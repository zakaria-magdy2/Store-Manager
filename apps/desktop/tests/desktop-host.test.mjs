import test from 'node:test';
import assert from 'node:assert/strict';
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
  createDesktopWindowSecurityPolicy,
  DESKTOP_IPC_CHANNELS,
  DesktopHostSupervisor,
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
