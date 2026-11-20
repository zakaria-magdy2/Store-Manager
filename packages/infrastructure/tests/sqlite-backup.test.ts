import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessFreshReplacementHost, checkSqliteFileQuick, createEncryptedSqliteBackup, decryptBackupArchive, installPreparedSqliteRestore, prepareEncryptedSqliteRestore, preparePlainSqliteRestore, recoverPendingSqliteRestore, removeBackupArtifact, verifySqliteFile } from '../src/backup/sqlite-backup.service.js';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';

const restorePassphrase = 'correct horse battery staple';
const restoreTenant = { id: 'tenant-restore-test', code: 'RESTORE_TEST', currency: 'EGP' };
const replacementHostTenant = { id: 'fresh-replacement-pc-id', code: restoreTenant.code, currency: restoreTenant.currency };

async function makeMigratedDatabase(
  path: string,
  markerValue: string | null,
  tenant: { id: string; code: string; currency: string } = restoreTenant,
): Promise<SqliteDatabaseManager> {
  await mkdir(dirname(path), { recursive: true });
  const manager = new SqliteDatabaseManager({ filename: path });
  manager.connect();
  const migration = await new DatabaseMigrator(manager.getDb()).migrateToLatest();
  if (!migration.success) throw new Error('Temporary restore test database migration failed', { cause: migration.error });
  await manager.getDb().insertInto('tenants').values({ id: tenant.id, name: 'Restore Test Shop', code: tenant.code, currency: tenant.currency }).execute();
  if (markerValue !== null) {
    manager.getRawDatabase().exec('CREATE TABLE restore_probe (value TEXT NOT NULL)');
    manager.getRawDatabase().prepare('INSERT INTO restore_probe(value) VALUES (?)').run(markerValue);
  }
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

  it('strict restore shutdown checkpoints, closes the native handle, and forbids lazy reconnection', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-close-'));
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'kept-before-restore');
    const raw = active.getRawDatabase();
    try {
      active.beginMaintenanceMode();
      await active.closeForRestore();
      expect(raw.open).toBe(false);
      expect(() => active.getRawDatabase()).toThrow(/maintenance is in progress/);

      const reopened = new Database(activePath, { readonly: true, fileMustExist: true });
      try {
        expect(reopened.prepare('SELECT value FROM restore_probe').get()).toEqual({ value: 'kept-before-restore' });
      } finally {
        reopened.close();
      }
    } finally {
      await active.close();
    }
  });

  it('aborts strict restore shutdown when WAL checkpoint reports a live reader', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-checkpoint-busy-'));
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'kept-on-checkpoint-failure');
    const writer = active.getRawDatabase();
    const reader = new Database(activePath);
    try {
      writer.exec('CREATE TABLE checkpoint_probe(value TEXT NOT NULL)');
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM checkpoint_probe').all();
      writer.prepare('INSERT INTO checkpoint_probe(value) VALUES (?)').run('committed-after-reader-snapshot');

      active.beginMaintenanceMode();
      await expect(active.closeForRestore()).rejects.toThrow(/WAL checkpoint did not finish/);
      expect(writer.open).toBe(true);
      expect(() => active.connect()).toThrow(/maintenance is in progress/);
      expect(await stat(activePath).then(() => true, () => false)).toBe(true);
    } finally {
      if (reader.inTransaction) reader.exec('ROLLBACK');
      reader.close();
      await active.close();
    }
  });

  it('rolls back immediately when the installed candidate fails post-swap verification', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-rollback-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      await writeFile(prepared.candidatePath, 'tampered after preparation');

      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(
        active.getRawDatabase(),
        () => active.closeForRestore(),
        activePath,
        workingDirectory,
        prepared,
      )).rejects.toThrow(/does not match/);

      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('preserves the original database when native shutdown fails before the swap', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-close-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();

      await expect(installPreparedSqliteRestore(
        active.getRawDatabase(),
        () => { throw new Error('simulated native close failure'); },
        activePath,
        workingDirectory,
        prepared,
      )).rejects.toThrow(/simulated native close failure/);

      expect(active.getRawDatabase().open).toBe(true);
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('keeps the original recoverable when WAL cleanup fails and finalizes rollback on restart', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-wal-delete-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let obstructionPath: string | undefined;
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();

      await expect(installPreparedSqliteRestore(
        active.getRawDatabase(),
        async () => {
          await active.closeForRestore();
          obstructionPath = `${activePath}-wal`;
          await mkdir(obstructionPath);
        },
        activePath,
        workingDirectory,
        prepared,
      )).rejects.toThrow();

      expect(await stat(join(workingDirectory, '.retailos-restore.json')).then(() => true, () => false)).toBe(true);
      expect(await stat(join(prepared.workspace, 'previous.sqlite')).then(() => true, () => false)).toBe(true);
      expect(await stat(activePath).then(() => true, () => false)).toBe(false);

      await rm(obstructionPath!, { recursive: true, force: true });
      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it.each(['-wal', '-shm'] as const)('restores the original when deleting the %s sidecar fails', async (sidecar) => {
    workingDirectory = await mkdtemp(join(tmpdir(), `retailos-restore-delete-${sidecar.slice(1)}-`));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let injected = false;
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), async () => {
        await active.closeForRestore();
        await writeFile(`${activePath}${sidecar}`, 'synthetic sidecar obstruction');
      }, activePath, workingDirectory, prepared, {
        removeFile: async (path, options) => {
          if (!injected && path === `${activePath}${sidecar}`) {
            injected = true;
            throw new Error(`simulated ${sidecar} deletion failure`);
          }
          return rm(path, options);
        },
      })).rejects.toThrow(`simulated ${sidecar} deletion failure`);
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('does not report success when moving the candidate into place fails', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-install-move-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let injected = false;
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.closeForRestore(), activePath, workingDirectory, prepared, {
        renameFile: async (from, to) => {
          if (!injected && from === prepared.candidatePath && to === activePath) {
            injected = true;
            throw new Error('simulated candidate install move failure');
          }
          return rename(from, to);
        },
      })).rejects.toThrow('simulated candidate install move failure');
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('preserves recovery artifacts if the rollback move fails, then recovers the original safely', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-rollback-move-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let candidateMoveFailed = false;
    let rollbackMoveFailed = false;
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.closeForRestore(), activePath, workingDirectory, prepared, {
        renameFile: async (from, to) => {
          if (!candidateMoveFailed && from === prepared.candidatePath && to === activePath) {
            candidateMoveFailed = true;
            throw new Error('simulated candidate install failure');
          }
          if (candidateMoveFailed && !rollbackMoveFailed && typeof from === 'string' && from.endsWith('previous.sqlite') && to === activePath) {
            rollbackMoveFailed = true;
            throw new Error('simulated rollback move failure');
          }
          return rename(from, to);
        },
      })).rejects.toThrow(/rollback was incomplete/);
      const markerPath = join(workingDirectory, '.retailos-restore.json');
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { previousPath: string; rollbackPath: string };
      expect(await stat(marker.previousPath).then(() => true, () => false)).toBe(true);
      expect(await stat(marker.rollbackPath).then(() => true, () => false)).toBe(true);
      expect(await stat(activePath).then(() => true, () => false)).toBe(false);
      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('reports post-install validation failure and restores the original database', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-validation-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let injected = false;
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.closeForRestore(), activePath, workingDirectory, prepared, {
        verifyFile: (path, tenant, options) => {
          if (!injected && path === activePath) {
            injected = true;
            throw new Error('simulated post-install validation failure');
          }
          return verifySqliteFile(path, tenant, options);
        },
      })).rejects.toThrow('simulated post-install validation failure');
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('preserves a valid original if rollback marker creation fails before replacement', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-marker-create-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.closeForRestore(), activePath, workingDirectory, prepared, {
        writeMarker: () => { throw new Error('simulated restore marker creation failure'); },
      })).rejects.toThrow('simulated restore marker creation failure');
      expect(checkSqliteFileQuick(activePath).ok).toBe(true);
      expect(readProbe(activePath)).toBe('original-data');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('retains recovery marker and valid database when marker cleanup fails, then cleans it at recovery', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-restore-marker-cleanup-failure-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'source.sqlite'), 'candidate-data');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'original-data');
    let failInstall = false;
    let failCleanup = false;
    const markerPath = join(workingDirectory, '.retailos-restore.json');
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      active.beginMaintenanceMode();
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.closeForRestore(), activePath, workingDirectory, prepared, {
        renameFile: async (from, to) => {
          if (!failInstall && from === prepared.candidatePath && to === activePath) {
            failInstall = true;
            throw new Error('simulated candidate install failure');
          }
          return rename(from, to);
        },
        removeFile: async (path, options) => {
          if (!failCleanup && path === markerPath) {
            failCleanup = true;
            throw new Error('simulated marker cleanup failure');
          }
          return rm(path, options);
        },
      })).rejects.toThrow(/rollback was incomplete/);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await stat(markerPath).then(() => true, () => false)).toBe(true);
      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(readProbe(activePath)).toBe('original-data');
      expect(await stat(markerPath).then(() => true, () => false)).toBe(false);
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
      await expect(prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, { ...restoreTenant, code: 'OTHER_CO' }, { allowReplacementTenantId: true })).rejects.toThrow(/different company/);
      const replacementPrepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, { ...restoreTenant, id: 'fresh-replacement-pc-id' }, { allowReplacementTenantId: true });
      expect(replacementPrepared.tenant.code).toBe(restoreTenant.code);
      await rm(replacementPrepared.workspace, { recursive: true, force: true });
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

  it('produces consistent verified backups concurrently alongside continuous WAL write transactions', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-concurrent-backup-'));
    const dbPath = join(workingDirectory, 'live-wal.sqlite');
    const manager = await makeMigratedDatabase(dbPath, 'initial');
    try {
      const raw = manager.getRawDatabase();
      raw.exec('CREATE TABLE IF NOT EXISTS concurrent_writes (seq INTEGER PRIMARY KEY, marker TEXT NOT NULL);');
      const insertStmt = raw.prepare('INSERT INTO concurrent_writes (seq, marker) VALUES (?, ?)');

      let keepWriting = true;
      let writtenCount = 0;
      const writerTask = (async () => {
        for (let i = 1; i <= 150 && keepWriting; i += 1) {
          insertStmt.run(i, `row-${i}`);
          writtenCount = i;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 15));
      const backup = await createEncryptedSqliteBackup(raw, workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      keepWriting = false;
      await writerTask;

      expect(writtenCount).toBeGreaterThan(10);
      expect(checkSqliteFileQuick(prepared.candidatePath).ok).toBe(true);

      const snapshotDb = new Database(prepared.candidatePath, { readonly: true, fileMustExist: true });
      try {
        const integrity = snapshotDb.pragma('integrity_check') as Array<{ integrity_check?: string }>;
        expect(integrity.every((row) => row.integrity_check === 'ok')).toBe(true);
        const maxSeqRow = snapshotDb.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(seq), 0) AS maxSeq FROM concurrent_writes').get() as { cnt: number; maxSeq: number };
        expect(maxSeqRow.cnt).toBe(maxSeqRow.maxSeq);
        expect(maxSeqRow.cnt).toBeGreaterThan(0);
      } finally {
        snapshotDb.close();
      }
      await rm(prepared.workspace, { recursive: true, force: true });
    } finally {
      await manager.close();
    }
  });

  it('assessFreshReplacementHost accepts only a host with no operational data (fail-closed for unknown tables)', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-fresh-host-'));
    const fresh = await makeMigratedDatabase(join(workingDirectory, 'fresh.sqlite'), null, replacementHostTenant);
    try {
      const raw = fresh.getRawDatabase();
      expect(assessFreshReplacementHost(raw, replacementHostTenant.id)).toEqual({ fresh: true, blockers: [] });
      // Wrong tenant id for the session is never fresh.
      expect(assessFreshReplacementHost(raw, 'someone-else').fresh).toBe(false);

      // Any operational row (here: a product category) disqualifies the host.
      raw.prepare('INSERT INTO categories (id, tenant_id, name, code) VALUES (?, ?, ?, ?)').run('cat-1', replacementHostTenant.id, 'أحذية', 'SHOES');
      const withCategory = assessFreshReplacementHost(raw, replacementHostTenant.id);
      expect(withCategory.fresh).toBe(false);
      expect(withCategory.blockers).toContainEqual({ table: 'categories', rows: 1, allowed: 0 });
      raw.prepare('DELETE FROM categories').run();

      // A table introduced by a future migration is not on the allowlist: rows there also block.
      raw.exec('CREATE TABLE future_operational_table (id TEXT PRIMARY KEY)');
      raw.prepare('INSERT INTO future_operational_table (id) VALUES (?)').run('x');
      const withFuture = assessFreshReplacementHost(raw, replacementHostTenant.id);
      expect(withFuture.fresh).toBe(false);
      expect(withFuture.blockers.map((b) => b.table)).toContain('future_operational_table');
    } finally {
      await fresh.close();
    }
  });

  it('installs a cross-PC replacement restore and verifies the rollback snapshot against the host tenant', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-replacement-install-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-old-pc');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'fresh-host', replacementHostTenant);
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, replacementHostTenant, { allowReplacementTenantId: true });
      expect(prepared.tenant.id).toBe(restoreTenant.id);
      await installPreparedSqliteRestore(active.getRawDatabase(), () => active.close(), activePath, workingDirectory, prepared);
      const marker = JSON.parse(await readFile(join(workingDirectory, '.retailos-restore.json'), 'utf8')) as { previousTenant?: { id: string } };
      expect(marker.previousTenant?.id).toBe(replacementHostTenant.id);
      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(true);
      expect(readProbe(activePath)).toBe('from-old-pc');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('recovers an interrupted cross-PC replacement back to the host database using previousTenant', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-replacement-recovery-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-old-pc');
    const activePath = join(workingDirectory, 'active.sqlite');
    const active = await makeMigratedDatabase(activePath, 'host-original', replacementHostTenant);
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, replacementHostTenant, { allowReplacementTenantId: true });
      const rollbackPath = join(prepared.workspace, 'rollback.sqlite');
      await active.getRawDatabase().backup(rollbackPath);
      await active.close();
      // Original moved away is missing and active file is damaged: only the rollback snapshot can restore it.
      await writeFile(activePath, 'damaged database');
      const candidateSha256 = createHash('sha256').update(await readFile(prepared.candidatePath)).digest('hex');
      await writeFile(join(workingDirectory, '.retailos-restore.json'), JSON.stringify({
        version: 1, stage: 'OLD_MOVED', workspace: prepared.workspace,
        activePath, candidatePath: prepared.candidatePath,
        previousPath: join(prepared.workspace, 'previous.sqlite'), rollbackPath,
        candidateSha256, tenant: prepared.tenant, previousTenant: replacementHostTenant,
      }), { mode: 0o600 });

      await expect(recoverPendingSqliteRestore(workingDirectory, activePath, restoreTenant.code)).resolves.toBe(false);
      expect(readProbe(activePath)).toBe('host-original');
    } finally {
      await source.close();
      await active.close();
    }
  });

  it('refuses to install a candidate whose company code differs from the host', async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'retailos-replacement-code-'));
    const source = await makeMigratedDatabase(join(workingDirectory, 'snapshot.sqlite'), 'from-backup');
    const activePath = join(workingDirectory, 'active.sqlite');
    const otherCompany = { id: 'other-company-id', code: 'OTHER_CO', currency: 'EGP' };
    const active = await makeMigratedDatabase(activePath, 'other-company-data', otherCompany);
    try {
      const backup = await createEncryptedSqliteBackup(source.getRawDatabase(), workingDirectory, restorePassphrase);
      backupPath = backup.path;
      const prepared = await prepareEncryptedSqliteRestore(backup.path, workingDirectory, restorePassphrase, restoreTenant);
      await expect(installPreparedSqliteRestore(active.getRawDatabase(), () => active.close(), activePath, workingDirectory, prepared)).rejects.toThrow(/different company/);
      expect(readProbe(activePath)).toBe('other-company-data');
      expect(await readFile(join(workingDirectory, '.retailos-restore.json')).catch(() => null)).toBeNull();
    } finally {
      await source.close();
      await active.close();
    }
  });
});
