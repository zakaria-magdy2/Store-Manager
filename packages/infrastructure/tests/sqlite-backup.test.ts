import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSqliteFileQuick, createEncryptedSqliteBackup, decryptBackupArchive, installPreparedSqliteRestore, prepareEncryptedSqliteRestore, preparePlainSqliteRestore, recoverPendingSqliteRestore, removeBackupArtifact } from '../src/backup/sqlite-backup.service.js';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';

const restorePassphrase = 'correct horse battery staple';
const restoreTenant = { id: 'tenant-restore-test', code: 'RESTORE_TEST', currency: 'EGP' };

async function makeMigratedDatabase(path: string, markerValue: string): Promise<SqliteDatabaseManager> {
  await mkdir(dirname(path), { recursive: true });
  const manager = new SqliteDatabaseManager({ filename: path });
  manager.connect();
  const migration = await new DatabaseMigrator(manager.getDb()).migrateToLatest();
  if (!migration.success) throw new Error('Temporary restore test database migration failed', { cause: migration.error });
  await manager.getDb().insertInto('tenants').values({ id: restoreTenant.id, name: 'Restore Test Shop', code: restoreTenant.code, currency: restoreTenant.currency }).execute();
  manager.getRawDatabase().exec('CREATE TABLE restore_probe (value TEXT NOT NULL)');
  manager.getRawDatabase().prepare('INSERT INTO restore_probe(value) VALUES (?)').run(markerValue);
  return manager;
}

function readProbe(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare('SELECT value FROM restore_probe').get() as { value: string }).value; }
  finally { db.close(); }
}

describe('Encrypted SQLite backups', { timeout: 30000 }, () => {
  let workingDirectory: string | undefined;
  let backupPath: string | undefined;

  afterEach(async () => {
    if (backupPath) await removeBackupArtifact(backupPath);
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
    workingDirectory = undefined;
    backupPath = undefined;
  });

  it('creates a consistent encrypted snapshot and rejects a wrong passphrase', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-backup-test-'));
    const source = new Database(':memory:');
    source.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
    source.prepare('INSERT INTO tenants VALUES (?, ?)').run('tenant-1', 'Shop');
    try {
      const backup = await createEncryptedSqliteBackup(source, workingDirectory, 'correct horse battery staple');
      backupPath = backup.path;
      const archive = await readFile(backup.path);
      expect(archive.subarray(0, 5).toString()).toBe('RFBK1');
      expect(backup.size).toBe(archive.length);
      const snapshot = decryptBackupArchive(archive, 'correct horse battery staple');
      const restoredPath = join(workingDirectory, 'restored.sqlite');
      await writeFile(restoredPath, snapshot);
      const restored = new Database(restoredPath, { readonly: true });
      try {
        expect(restored.prepare('SELECT name FROM tenants WHERE id = ?').get('tenant-1')).toEqual({ name: 'Shop' });
      } finally {
        restored.close();
      }
      expect(() => decryptBackupArchive(archive, 'incorrect passphrase')).toThrow();
    } finally {
      source.close();
    }
  });

  it('restores a verified same-company backup, then startup recovery finalizes the swap', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-success-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-backup');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'current-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      await installPreparedSqliteRestore(active.getRawDatabase(), () => active.close(), activePath, workingDirectory, prepared);

      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(true);
      expect(readProbe(activePath)).toBe('from-backup');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('rejects wrong passphrases and other-company backups without changing the active database', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-reject-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-backup');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'keep-current-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      await expect(prepareEncryptedSqliteRestore(backup.path, workingDirectory, 'incorrect passphrase', restoreTenant)).rejects.toThrow();
      await expect(prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, { ...restoreTenant, id: 'another-company' })).rejects.toThrow(/different company/);
      expect(readProbe(activePath)).toBe('keep-current-data');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('recovers the original database after an interrupted swap using the moved original', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-recovery-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-backup');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      const previousPath = join(prepared.workspace, 'previous.sqlite');
      const rollbackPath = join(prepared.workspace, 'rollback.sqlite');
      await active.getRawDatabase().backup(rollbackPath);
      await active.close();
      await rename(activePath, previousPath);
      const candidateSha256 = createHash('sha256').update(await readFile(prepared.candidatePath)).digest('hex');
      await writeFile(join(workingDirectory, '.retailos-restore.json'), JSON.stringify({
        version: 1, stage: 'OLD_MOVED', workspace: prepared.workspace,
        activePath, candidatePath: prepared.candidatePath, previousPath, rollbackPath,
        candidateSha256, tenant: restoreTenant,
      }), { mode: 0o600 });

      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(readProbe(activePath)).toBe('original-data');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('falls back to the rollback snapshot when the active database is damaged and the original file is missing', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-fallback-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-backup');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'rollback-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      const rollbackPath = join(prepared.workspace, 'rollback.sqlite');
      await active.getRawDatabase().backup(rollbackPath);
      await active.close();
      await writeFile(activePath, 'damaged database');
      const candidateSha256 = createHash('sha256').update(await readFile(prepared.candidatePath)).digest('hex');
      await writeFile(join(workingDirectory, '.retailos-restore.json'), JSON.stringify({
        version: 1, stage: 'OLD_MOVED', workspace: prepared.workspace,
        activePath, candidatePath: prepared.candidatePath,
        previousPath: join(prepared.workspace, 'previous.sqlite'), rollbackPath,
        candidateSha256, tenant: restoreTenant,
      }), { mode: 0o600 });

      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(readProbe(activePath)).toBe('rollback-data');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('verifies and prepares a plain daily sqlite snapshot and detects corrupted files via quick check', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-plain-restore-'));
    const sourcePath = join(workingDirectory, 'daily.sqlite');
    const activePath = join(workingDirectory, 'active.sqlite');
    const corruptPath = join(workingDirectory, 'corrupt.sqlite');
    const source = await makeMigratedDatabase(sourcePath, 'daily-good');
    const active = await makeMigratedDatabase(activePath, 'active-before');
    try {
      await source.close();
      expect(checkSqliteFileQuick(sourcePath).ok).toBe(true);
      await writeFile(corruptPath, 'not a valid sqlite file');
      expect(checkSqliteFileQuick(corruptPath).ok).toBe(false);

      const prepared = await preparePlainSqliteRestore(sourcePath, workingDirectory, restoreTenant);
      await installPreparedSqliteRestore(active.getRawDatabase(), () => active.close(), activePath, workingDirectory, prepared);
      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(true);
      expect(readProbe(activePath)).toBe('daily-good');
    } finally {
      await source.close();
      await active.close();
    }
  });
});
