import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScopedExecutionContext } from '@retailos/application';
import { Tenant } from '@retailos/core';
import {
  DatabaseMigrator,
  SqliteAuditLogRepository,
  SqliteDatabaseManager,
  SqliteOutboxRepository,
  SqliteTenantRepository,
} from '@retailos/infrastructure';
import {
  buildServerProcessEnv,
  createDesktopWindowSecurityPolicy,
  DESKTOP_IPC_CHANNELS,
  DesktopHostSupervisor,
  isProcessAlive,
  readExternalClockWatermark,
  resolveAvailableLoopbackPort,
  resolveDesktopDataPaths,
  resolveOrCreateDesktopDailyBackupSecret,
  resolveOrCreateDesktopWatermarkSecret,
  startManagedServerChild,
  stopManagedServerProcess,
  verifyStagedRuntimeIntegrity,
  waitForServerReady,
  writeExternalClockWatermark,
} from '../dist/index.js';

test('createDesktopWindowSecurityPolicy enforces loopback origin, sandbox flags, and IPC channel whitelist', () => {
  const policy = createDesktopWindowSecurityPolicy('http://127.0.0.1:4310');
  assert.equal(policy.contextIsolation, true);
  assert.equal(policy.nodeIntegration, false);
  assert.equal(policy.sandbox, true);
  assert.equal(policy.webSecurity, true);
  assert.equal(policy.allowRunningInsecureContent, false);
  assert.equal(policy.allowedOrigin, 'http://127.0.0.1:4310');

  assert.equal(policy.isAllowedNavigationUrl('http://127.0.0.1:4310/pos'), true);
  assert.equal(policy.isAllowedNavigationUrl('https://evil.example.com'), false);
  assert.equal(policy.isAllowedNavigationUrl('file:///C:/Windows/System32/cmd.exe'), false);

  assert.equal(policy.isAllowedChildNavigationUrl('http://127.0.0.1:4310/pos'), true);
  assert.equal(policy.isAllowedChildNavigationUrl('https://evil.example.com'), false);
  assert.equal(policy.isAllowedChildNavigationUrl('about:blank'), false);
  assert.equal(policy.isAllowedChildNavigationUrl('file:///C:/Windows/System32/cmd.exe'), false);

  assert.equal(
    policy.isAllowedPermissionRequest('clipboard-read', 'http://127.0.0.1:4310/pos'),
    true,
  );
  assert.equal(
    policy.isAllowedPermissionRequest('clipboard-sanitized-write', 'http://127.0.0.1:4310/pos'),
    true,
  );
  assert.equal(
    policy.isAllowedPermissionRequest('clipboard-read', 'about:blank', 'http://127.0.0.1:4310/'),
    true,
  );
  assert.equal(policy.isAllowedPermissionRequest('clipboard-read', 'about:blank'), false);
  assert.equal(
    policy.isAllowedPermissionRequest('clipboard-read', 'https://evil.example.com'),
    false,
  );
  assert.equal(
    policy.isAllowedPermissionRequest('clipboard-sanitized-write', 'http://127.0.0.1:9999/'),
    false,
  );
  assert.equal(policy.isAllowedPermissionRequest('media', 'http://127.0.0.1:4310/pos'), false);
  assert.equal(
    policy.isAllowedPermissionRequest('geolocation', 'http://127.0.0.1:4310/pos'),
    false,
  );
  assert.equal(
    policy.isAllowedPermissionRequest('notifications', 'http://127.0.0.1:4310/pos'),
    false,
  );

  assert.equal(policy.isAllowedIpcChannel(DESKTOP_IPC_CHANNELS.HOST_STATUS), true);
  assert.equal(policy.isAllowedIpcChannel('retailos:shell:exec'), false);

  assert.throws(
    () => createDesktopWindowSecurityPolicy('http://0.0.0.0:4310'),
    /DesktopSecurityError/,
  );
});

test('DesktopHostSupervisor coordinates outbox sync and tamper-evident audit verification over whitelisted IPC channels', async () => {
  const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
  dbManager.connect();
  try {
    const db = dbManager.getDb();
    await new DatabaseMigrator(db).migrateToLatest();

    const tenantRepo = new SqliteTenantRepository(db);
    await tenantRepo.save(
      Tenant.create({
        id: 'tenant-desk-1',
        name: 'Desktop Store',
        code: 'DESK1',
        currency: 'EGP',
      }),
    );

    await db
      .insertInto('users')
      .values({
        id: 'user-desk-1',
        tenant_id: 'tenant-desk-1',
        store_id: null,
        username: 'owner_desk',
        password_hash: 'hash',
        full_name: 'Desktop Owner',
        role: 'OWNER',
      })
      .execute();

    const ctx = new ScopedExecutionContext({
      tenantId: 'tenant-desk-1',
      userId: 'user-desk-1',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'desk-corr-1',
    });

    const outboxRepo = new SqliteOutboxRepository(db);
    const auditRepo = new SqliteAuditLogRepository(db);

    await outboxRepo.enqueue(ctx, {
      id: 'desk-evt-1',
      aggregateType: 'SALE',
      aggregateId: 'sale-1',
      eventType: 'SALE_COMPLETED',
      payload: { totalMinor: 25000n },
      idempotencyKey: 'desk-idem-1',
    });

    await auditRepo.record(ctx, {
      actorUsername: 'owner_desk',
      actorRole: 'OWNER',
      action: 'DESKTOP_BOOT',
      entityType: 'HOST',
      entityId: 'host-1',
      summary: 'تشغيل نسخة سطح المكتب',
    });

    const supervisor = new DesktopHostSupervisor({
      db,
      transport: {
        pushBatch: async (_c, events) => ({
          acceptedIds: events.map((e) => e.id),
        }),
      },
    });

    const initialStatus = await supervisor.dispatchIpc(
      ctx,
      DESKTOP_IPC_CHANNELS.HOST_STATUS,
    );
    assert.deepEqual(initialStatus, {
      mode: 'OFFLINE_FIRST_DESKTOP',
      allowedOrigin: 'http://127.0.0.1:4310',
      outboxPendingCount: 1,
      outboxSyncedCount: 0,
      outboxLastSequenceNo: 1,
      auditChainValid: true,
      auditCheckedEntries: 1,
    });

    const syncResult = await supervisor.dispatchIpc(
      ctx,
      DESKTOP_IPC_CHANNELS.SYNC_RUN_BATCH,
      { batchSize: 20 },
    );
    assert.deepEqual(syncResult, { fetched: 1, synced: 1 });

    const finalStats = await supervisor.dispatchIpc(
      ctx,
      DESKTOP_IPC_CHANNELS.SYNC_STATS,
    );
    assert.deepEqual(finalStats, {
      pendingCount: 0,
      syncedCount: 1,
      lastSequenceNo: 1,
    });

    await assert.rejects(
      () => supervisor.dispatchIpc(ctx, 'retailos:untrusted:channel'),
      /Unauthorized Desktop IPC channel/,
    );
  } finally {
    await dbManager.close();
  }
});

test('resolveDesktopDataPaths and buildServerProcessEnv isolate AppData SQLite and backup paths', () => {
  const paths = resolveDesktopDataPaths(join(tmpdir(), 'RetailOS-Test-UserData'));
  assert.equal(paths.dataDir, join(paths.userDataDir, 'data'));
  assert.equal(paths.databasePath, join(paths.dataDir, 'retailos.sqlite'));
  assert.equal(paths.backupDir, join(paths.dataDir, 'backups'));
  assert.equal(paths.dailyBackupDir, join(paths.backupDir, 'daily'));

  const env = buildServerProcessEnv({}, paths, 3210, {
    runAsNode: true,
    desktopVersion: '0.1.0',
  });
  assert.equal(env.PORT, '3210');
  assert.equal(env.RETAILOS_DATA_DIR, paths.dataDir);
  assert.equal(env.RETAILOS_DB_PATH, paths.databasePath);
  assert.equal(env.RETAILOS_BACKUP_DIR, paths.backupDir);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.RETAILOS_DESKTOP_VERSION, '0.1.0');
});

test('resolveAvailableLoopbackPort falls back dynamically when preferred port is occupied', async () => {
  const blocker = createServer();
  await new Promise((resolvePromise) => blocker.listen(0, '127.0.0.1', resolvePromise));
  try {
    const addr = blocker.address();
    assert.ok(addr && typeof addr !== 'string');
    const busyPort = addr.port;
    const allocatedPort = await resolveAvailableLoopbackPort(busyPort);
    assert.notEqual(allocatedPort, busyPort);
    assert.ok(allocatedPort > 0 && allocatedPort <= 65535);
  } finally {
    await new Promise((resolvePromise) => blocker.close(resolvePromise));
  }
});

test('managed desktop server boots with temporary userData paths via stdin secret handshake, verifies /api/bootstrap, and shuts down with zero orphan processes', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const webServerPath = resolve(testDir, '..', '..', 'web', 'server.mjs');
  const tempUserData = await mkdtemp(join(tmpdir(), 'retailos-desktop-smoke-'));
  const paths = resolveDesktopDataPaths(tempUserData);
  const port = await resolveAvailableLoopbackPort(0);
  const origin = `http://127.0.0.1:${String(port)}`;
  const watermarkSecret = await resolveOrCreateDesktopWatermarkSecret({
    userDataDir: tempUserData,
  });
  const env = buildServerProcessEnv(process.env, paths, port);

  let child = null;
  try {
    const managed = startManagedServerChild({
      execPath: process.execPath,
      serverScriptPath: webServerPath,
      cwd: dirname(webServerPath),
      env,
      watermarkSecret,
    });
    child = managed.child;
    const identity = await waitForServerReady({
      origin,
      child,
      logs: managed.logs,
    });
    assert.equal(identity.ok, true);
    assert.equal(identity.configured, true);
    assert.equal(existsSync(paths.databasePath), true, 'SQLite DB must be created at RETAILOS_DB_PATH');
    assert.equal(existsSync(paths.dailyBackupDir), true, 'Daily backup dir must be created inside RETAILOS_BACKUP_DIR');
    assert.equal(existsSync(join(paths.dataDir, '.retailos-watermark.key')), false, 'Plaintext watermark fallback file must not exist');

    const licenseRes = await fetch(`${origin}/api/license/status`);
    assert.equal(licenseRes.status, 200);
    const licensePayload = await licenseRes.json();
    assert.equal(licensePayload.status, 'UNLICENSED');

    const pid = child.pid;
    await stopManagedServerProcess({ child, dataDir: paths.dataDir, origin });
    child = null;
    if (typeof pid === 'number') {
      assert.equal(isProcessAlive(pid), false, 'Embedded server process must exit completely with zero orphans');
    }
  } finally {
    if (child) {
      await stopManagedServerProcess({ child, dataDir: paths.dataDir, origin }).catch(() => undefined);
    }
    await rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('resolveOrCreateDesktopWatermarkSecret persists DPAPI-sealed secret and buildServerProcessEnv strips secret env vars', async () => {
  const tempUserData = await mkdtemp(join(tmpdir(), 'retailos-watermark-dpapi-'));
  try {
    const fakeDpapi = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`dpapi:${plain}`, 'utf8'),
      decryptString: (blob) => {
        const text = blob.toString('utf8');
        if (!text.startsWith('dpapi:')) throw new Error('Invalid DPAPI envelope');
        return text.slice('dpapi:'.length);
      },
    };

    const secret1 = await resolveOrCreateDesktopWatermarkSecret({
      userDataDir: tempUserData,
      safeStorage: fakeDpapi,
    });
    assert.match(secret1, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(tempUserData, 'license-watermark.bin')), true);

    const secret2 = await resolveOrCreateDesktopWatermarkSecret({
      userDataDir: tempUserData,
      safeStorage: fakeDpapi,
    });
    assert.equal(secret2, secret1);

    const paths = resolveDesktopDataPaths(tempUserData);
    const dailySecret = await resolveOrCreateDesktopDailyBackupSecret({
      userDataDir: tempUserData,
      safeStorage: fakeDpapi,
    });
    assert.ok(dailySecret.length >= 32);
    assert.equal(existsSync(join(tempUserData, 'daily-backup.bin')), true);

    const childEnv = buildServerProcessEnv(
      {
        RETAILOS_WATERMARK_SECRET: secret1,
        RETAILOS_DAILY_BACKUP_KEY: dailySecret,
        RETAILOS_TEST_LICENSE_PUBLIC_KEY: 'should-be-stripped',
        RETAILOS_TEST_CLOCK_FILE: 'should-be-stripped',
      },
      paths,
      3210,
      { runAsNode: true, desktopVersion: '0.1.0' },
    );
    assert.equal(childEnv.RETAILOS_WATERMARK_SECRET, undefined);
    assert.equal(childEnv.RETAILOS_DAILY_BACKUP_KEY, undefined);
    assert.equal(childEnv.RETAILOS_TEST_LICENSE_PUBLIC_KEY, undefined);
    assert.equal(childEnv.RETAILOS_TEST_CLOCK_FILE, undefined);
    assert.equal(childEnv.NODE_ENV, 'production');

    // Fail closed when DPAPI is required on Windows production and unavailable
    await assert.rejects(
      () =>
        resolveOrCreateDesktopWatermarkSecret({
          userDataDir: tempUserData,
          requireDpapi: true,
        }),
      /DPAPI/,
    );
    await assert.rejects(
      () =>
        resolveOrCreateDesktopDailyBackupSecret({
          userDataDir: tempUserData,
          requireDpapi: true,
        }),
      /DPAPI/,
    );

    // External DPAPI monotonic clock file: monotonic write, reject rewind, detect corruption
    const t1 = Date.parse('2026-11-18T10:00:00.000Z');
    const t2 = Date.parse('2026-11-19T10:00:00.000Z');
    await writeExternalClockWatermark({
      userDataDir: tempUserData,
      watermarkSecret: secret1,
      clockMs: t2,
      safeStorage: fakeDpapi,
      requireDpapi: true,
    });
    await writeExternalClockWatermark({
      userDataDir: tempUserData,
      watermarkSecret: secret1,
      clockMs: t1,
      safeStorage: fakeDpapi,
      requireDpapi: true,
    });
    const clockRead = await readExternalClockWatermark({
      userDataDir: tempUserData,
      watermarkSecret: secret1,
      safeStorage: fakeDpapi,
      requireDpapi: true,
    });
    assert.deepEqual(clockRead, { clockMs: t2, tampered: false });

    await writeFile(join(tempUserData, 'license-clock.dat'), Buffer.from('corrupt-blob'));
    const tamperedRead = await readExternalClockWatermark({
      userDataDir: tempUserData,
      watermarkSecret: secret1,
      safeStorage: fakeDpapi,
      requireDpapi: true,
    });
    assert.deepEqual(tamperedRead, { clockMs: null, tampered: true });
  } finally {
    await rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('verifyStagedRuntimeIntegrity validates Ed25519 manifest and rejects tampered or unmanifested files', async () => {
  const tempWebDir = await mkdtemp(join(tmpdir(), 'retailos-manifest-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const publicKeyPem = String(publicKey);
    const privateKeyPem = String(privateKey);

    await writeFile(join(tempWebDir, 'server.mjs'), 'console.log("server");\n', 'utf8');
    await writeFile(join(tempWebDir, 'index.html'), '<html><body>ok</body></html>\n', 'utf8');

    const files = {
      'index.html': createHash('sha256')
        .update('<html><body>ok</body></html>\n', 'utf8')
        .digest('hex'),
      'server.mjs': createHash('sha256').update('console.log("server");\n', 'utf8').digest('hex'),
    };
    const canonical = JSON.stringify({ version: 1, algorithm: 'sha256', files });
    const sig = sign(null, Buffer.from(`ROS-MANIFEST-V1:${canonical}`, 'utf8'), privateKeyPem).toString(
      'base64url',
    );
    await writeFile(
      join(tempWebDir, 'integrity-manifest.json'),
      JSON.stringify({ version: 1, algorithm: 'sha256', files, signature: sig }, null, 2),
      'utf8',
    );

    const ok = await verifyStagedRuntimeIntegrity({
      webDir: tempWebDir,
      publicKeyPem,
      requireManifest: true,
    });
    assert.deepEqual(ok, { checked: true, verifiedFiles: 2 });

    // Dropping an unmanifested .mjs file must fail immediately
    await writeFile(join(tempWebDir, 'injected.mjs'), 'evil();\n', 'utf8');
    await assert.rejects(
      () => verifyStagedRuntimeIntegrity({ webDir: tempWebDir, publicKeyPem, requireManifest: true }),
      /غير موقّع/,
    );
    await rm(join(tempWebDir, 'injected.mjs'), { force: true });

    // Modifying server.mjs must fail immediately
    await writeFile(join(tempWebDir, 'server.mjs'), 'console.log("tampered");\n', 'utf8');
    await assert.rejects(
      () => verifyStagedRuntimeIntegrity({ webDir: tempWebDir, publicKeyPem, requireManifest: true }),
      /تم تعديل ملف تشغيل/,
    );
  } finally {
    await rm(tempWebDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
