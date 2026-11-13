import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import {
  MINIMUM_SUPPORTED_BACKUP_MIGRATION,
  REGISTERED_MIGRATION_NAMES,
} from '../database/migrator.js';

const MAGIC = Buffer.from('RFBK1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;
const RESTORE_MARKER = '.retailos-restore.json';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12 || passphrase.length > 256) throw new Error('Backup passphrase must contain 12 to 256 characters');
  return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function decryptBackupArchive(archive: Buffer, passphrase: string): Buffer {
  if (archive.length < HEADER_BYTES + TAG_BYTES || !archive.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid backup archive');
  const salt = archive.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = archive.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const tag = archive.subarray(archive.length - TAG_BYTES);
  const ciphertext = archive.subarray(HEADER_BYTES, archive.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function createEncryptedSqliteBackup(
  database: DatabaseInstance,
  workingDirectory: string,
  passphrase: string,
): Promise<{ path: string; size: number }> {
  const salt = randomBytes(SALT_BYTES), iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const workspace = await mkdtemp(join(workingDirectory, '.retailos-backup-'));
  const snapshotPath = join(workspace, 'snapshot.sqlite');
  const ciphertextPath = join(workspace, 'snapshot.enc');
  const outputPath = join(workspace, 'retailos.rfbackup');
  try {
    await database.backup(snapshotPath);
    const snapshot = await open(snapshotPath, 'r');
    const snapshotStats = await snapshot.stat();
    await snapshot.close();
    if (snapshotStats.size === 0 || snapshotStats.size > MAX_DATABASE_BYTES) throw new Error('Database size is outside backup limits');
    const verification = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = verification.pragma('integrity_check') as { integrity_check: string }[];
      const foreignKeys = verification.pragma('foreign_key_check') as unknown[];
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) throw new Error('Backup integrity verification failed');
      verification.prepare('SELECT id FROM tenants LIMIT 1').get();
    } finally {
      verification.close();
    }
    await pipeline(createReadStream(snapshotPath), cipher, createWriteStream(ciphertextPath, { flags: 'wx' }));
    const output = await open(outputPath, 'wx');
    try {
      await output.write(Buffer.concat([MAGIC, salt, iv]));
      for await (const chunk of createReadStream(ciphertextPath)) {
        await output.write(Buffer.from(chunk as Uint8Array));
      }
      await output.write(cipher.getAuthTag());
      const result = await output.stat();
      return { path: outputPath, size: result.size };
    } finally {
      await output.close();
    }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(snapshotPath, { force: true });
    await rm(ciphertextPath, { force: true });
  }
}

export async function removeBackupArtifact(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

export function backupDownloadName(backupPath: string): string {
  return basename(backupPath);
}

export interface RestoreTenantIdentity { id: string; code: string; currency: string }
export interface PreparedSqliteRestore { workspace: string; candidatePath: string; candidateSha256: string; tenant: RestoreTenantIdentity }
interface RestoreMarker {
  version: 1;
  stage: 'PREPARED' | 'OLD_MOVED' | 'CANDIDATE_INSTALLED';
  workspace: string;
  activePath: string;
  candidatePath: string;
  previousPath: string;
  rollbackPath: string;
  candidateSha256: string;
  tenant: RestoreTenantIdentity;
}

function isSupportedBackupMigrationHistory(appliedMigrationNames: readonly string[]): boolean {
  if (appliedMigrationNames.length === 0) return false;
  const minSupportedIndex = REGISTERED_MIGRATION_NAMES.indexOf(MINIMUM_SUPPORTED_BACKUP_MIGRATION);
  if (minSupportedIndex === -1) return false;
  for (let i = 0; i < appliedMigrationNames.length; i += 1) {
    if (appliedMigrationNames[i] !== REGISTERED_MIGRATION_NAMES[i]) {
      return false;
    }
  }
  return appliedMigrationNames.length - 1 >= minSupportedIndex;
}

export function checkSqliteFileQuick(path: string): { ok: boolean; messages: string[] } {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = db.pragma('quick_check') as { quick_check?: string }[];
      const messages = rows.map((row) => String(row.quick_check ?? '')).filter(Boolean);
      return {
        ok: messages.length === 1 && messages[0] === 'ok',
        messages,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      messages: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function verifySqliteFile(path: string, expectedTenant?: RestoreTenantIdentity): RestoreTenantIdentity {
  const verification = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = verification.pragma('integrity_check') as { integrity_check: string }[];
    const foreignKeys = verification.pragma('foreign_key_check') as unknown[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) throw new Error('SQLite restore verification failed');
    const migrationsTable = verification.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'").get();
    if (!migrationsTable) throw new Error('Backup is missing migration history');
    const appliedMigrations = (
      verification.prepare('SELECT name FROM kysely_migration ORDER BY name ASC').all() as {
        name?: string;
      }[]
    ).map((row) => row.name ?? '');
    if (!isSupportedBackupMigrationHistory(appliedMigrations)) {
      throw new Error('Backup schema version is not supported');
    }
    const tenants = verification.prepare('SELECT id, code, currency FROM tenants').all() as RestoreTenantIdentity[];
    if (tenants.length !== 1) throw new Error('Backup must contain exactly one company');
    const tenant = tenants[0]!;
    if (expectedTenant && (tenant.id !== expectedTenant.id || tenant.code !== expectedTenant.code || tenant.currency !== expectedTenant.currency)) throw new Error('Backup belongs to a different company');
    return tenant;
  } finally {
    verification.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(Buffer.from(chunk as Uint8Array));
  return hash.digest('hex');
}

function assertChildPath(parent: string, child: string): void {
  const path = resolve(child), rel = relative(resolve(parent), path);
  if (!isAbsolute(path) || rel.startsWith('..') || rel === '' || resolve(parent) === path) throw new Error('Restore marker contains an unsafe path');
}

export async function prepareEncryptedSqliteRestore(
  archivePath: string,
  workingDirectory: string,
  passphrase: string,
  expectedTenant: RestoreTenantIdentity,
): Promise<PreparedSqliteRestore> {
  const archive = await open(archivePath, 'r');
  const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(TAG_BYTES);
  const workspace = await mkdtemp(join(workingDirectory, '.retailos-restore-'));
  const candidatePath = join(workspace, 'candidate.sqlite');
  try {
    const archiveStats = await archive.stat();
    if (archiveStats.size < HEADER_BYTES + TAG_BYTES || archiveStats.size > MAX_DATABASE_BYTES + HEADER_BYTES + TAG_BYTES || archiveStats.size > 2 * 1024 * 1024 * 1024) throw new Error('Backup archive size is invalid');
    await archive.read(header, 0, HEADER_BYTES, 0);
    await archive.read(tag, 0, TAG_BYTES, archiveStats.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid backup archive');
    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
    const iv = header.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    await pipeline(archive.createReadStream({ start: HEADER_BYTES, end: archiveStats.size - TAG_BYTES - 1, autoClose: false }), decipher, createWriteStream(candidatePath, { flags: 'wx', mode: 0o600 }));
    const candidateStats = await stat(candidatePath);
    if (candidateStats.size === 0 || candidateStats.size > MAX_DATABASE_BYTES) throw new Error('Restored database size is invalid');
    const tenant = verifySqliteFile(candidatePath, expectedTenant);
    return { workspace, candidatePath, candidateSha256: await hashFile(candidatePath), tenant };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  } finally {
    await archive.close();
  }
}

export async function preparePlainSqliteRestore(
  snapshotPath: string,
  workingDirectory: string,
  expectedTenant: RestoreTenantIdentity,
): Promise<PreparedSqliteRestore> {
  const workspace = await mkdtemp(join(workingDirectory, '.retailos-restore-'));
  const candidatePath = join(workspace, 'candidate.sqlite');
  try {
    const sourceStats = await stat(snapshotPath);
    if (sourceStats.size === 0 || sourceStats.size > MAX_DATABASE_BYTES) {
      throw new Error('Daily backup size is invalid');
    }
    await copyFile(snapshotPath, candidatePath);
    const tenant = verifySqliteFile(candidatePath, expectedTenant);
    return { workspace, candidatePath, candidateSha256: await hashFile(candidatePath), tenant };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function writeRestoreMarker(path: string, marker: RestoreMarker): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function installPreparedSqliteRestore(
  database: DatabaseInstance,
  closeDatabase: () => Promise<void>,
  activePath: string,
  workingDirectory: string,
  prepared: PreparedSqliteRestore,
): Promise<void> {
  const workspace = resolve(prepared.workspace), root = resolve(workingDirectory);
  assertChildPath(root, workspace);
  assertChildPath(workspace, prepared.candidatePath);
  const markerPath = join(root, RESTORE_MARKER);
  const previousPath = join(workspace, 'previous.sqlite'), rollbackPath = join(workspace, 'rollback.sqlite');
  const marker: RestoreMarker = { version: 1, stage: 'PREPARED', workspace, activePath: resolve(activePath), candidatePath: resolve(prepared.candidatePath), previousPath, rollbackPath, candidateSha256: prepared.candidateSha256, tenant: prepared.tenant };
  let markerCreated = false;
  try {
    await database.backup(rollbackPath);
    verifySqliteFile(rollbackPath, prepared.tenant);
    await writeRestoreMarker(markerPath, marker);
    markerCreated = true;
    await closeDatabase();
    await rename(activePath, previousPath);
    marker.stage = 'OLD_MOVED';
    await writeRestoreMarker(markerPath, marker);
    await rm(`${activePath}-wal`, { force: true });
    await rm(`${activePath}-shm`, { force: true });
    await rename(prepared.candidatePath, activePath);
    marker.stage = 'CANDIDATE_INSTALLED';
    await writeRestoreMarker(markerPath, marker);
    if (await hashFile(activePath) !== marker.candidateSha256) throw new Error('Installed database does not match the verified restore candidate');
    verifySqliteFile(activePath, prepared.tenant);
  } catch (error) {
    if (!markerCreated) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
    try {
      if (await stat(previousPath).then(() => true, () => false)) {
        await rm(activePath, { force: true });
        await rm(`${activePath}-wal`, { force: true });
        await rm(`${activePath}-shm`, { force: true });
        await rename(previousPath, activePath);
      } else {
        let activeIsOriginal = false;
        if (await stat(activePath).then(() => true, () => false)) {
          try { verifySqliteFile(activePath, prepared.tenant); activeIsOriginal = await hashFile(activePath) !== prepared.candidateSha256; } catch { activeIsOriginal = false; }
        }
        if (!activeIsOriginal) {
          await rm(activePath, { force: true });
          await rm(`${activePath}-wal`, { force: true });
          await rm(`${activePath}-shm`, { force: true });
          if (!await stat(rollbackPath).then(() => true, () => false)) throw new Error('Rollback snapshot is unavailable', { cause: error });
          await copyFile(rollbackPath, activePath);
        }
      }
      verifySqliteFile(activePath, prepared.tenant);
      await rm(markerPath, { force: true });
      await rm(workspace, { recursive: true, force: true });
    } catch {
      // Keep the marker and rollback artifacts for startup recovery if immediate rollback cannot finish.
    }
    throw error;
  }
}

export async function recoverPendingSqliteRestore(workingDirectory: string, activePath: string, expectedCompanyCode: string): Promise<boolean> {
  const root = resolve(workingDirectory), markerPath = join(root, RESTORE_MARKER);
  let markerRaw: string;
  try {
    markerRaw = await readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const marker = JSON.parse(markerRaw) as RestoreMarker;
  if (marker.version !== 1 || !['PREPARED', 'OLD_MOVED', 'CANDIDATE_INSTALLED'].includes(marker.stage) || resolve(marker.activePath) !== resolve(activePath) || marker.tenant.code !== expectedCompanyCode) throw new Error('Restore recovery marker is invalid; database was not opened');
  assertChildPath(root, marker.workspace);
  assertChildPath(marker.workspace, marker.candidatePath);
  assertChildPath(marker.workspace, marker.previousPath);
  assertChildPath(marker.workspace, marker.rollbackPath);
  const activeIsCandidate = await stat(activePath).then(async () => await hashFile(activePath) === marker.candidateSha256, () => false);
  if (activeIsCandidate) {
    verifySqliteFile(activePath, marker.tenant);
    await rm(marker.workspace, { recursive: true, force: true });
    await rm(markerPath, { force: true });
    return true;
  }
  if (await stat(marker.previousPath).then(() => true, () => false)) {
    await rm(activePath, { force: true });
    await rm(`${activePath}-wal`, { force: true });
    await rm(`${activePath}-shm`, { force: true });
    await rename(marker.previousPath, activePath);
  } else {
    let activeIsValidOriginal = false;
    if (await stat(activePath).then(() => true, () => false)) {
      try { verifySqliteFile(activePath, marker.tenant); activeIsValidOriginal = true; } catch { activeIsValidOriginal = false; }
    }
    if (!activeIsValidOriginal) {
      await rm(activePath, { force: true });
      await rm(`${activePath}-wal`, { force: true });
      await rm(`${activePath}-shm`, { force: true });
      if (!await stat(marker.rollbackPath).then(() => true, () => false)) throw new Error('Restore recovery failed; rollback snapshot is unavailable');
      await copyFile(marker.rollbackPath, activePath);
    }
  }
  verifySqliteFile(activePath, marker.tenant);
  await rm(marker.workspace, { recursive: true, force: true });
  await rm(markerPath, { force: true });
  return false;
}
