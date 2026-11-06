import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScopedExecutionContext } from '@retailos/application';
import { Store, Tenant } from '@retailos/core';
import {
  DatabaseMigrator,
  OutboxSyncWorker,
  SqliteDatabaseManager,
  SqliteOutboxRepository,
  SqliteStoreRepository,
  SqliteTenantRepository,
  type OutboxEventRecord,
  type OutboxSyncTransport,
} from '../src/index.js';

describe('Outbox CDC Repository & Sync Worker Integration Tests (Phase 8)', () => {
  let dbManager: SqliteDatabaseManager;
  let outboxRepo: SqliteOutboxRepository;
  let ctxA: ScopedExecutionContext;
  let ctxB: ScopedExecutionContext;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    const migration = await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    expect(migration.success).toBe(true);

    const db = dbManager.getDb();
    const tenantRepo = new SqliteTenantRepository(db);
    const storeRepo = new SqliteStoreRepository(db);
    outboxRepo = new SqliteOutboxRepository(db);

    await tenantRepo.save(
      Tenant.create({
        id: 'tenant-sync-a',
        name: 'Sync Tenant A',
        code: 'SYNCA',
        currency: 'EGP',
      }),
    );
    await tenantRepo.save(
      Tenant.create({
        id: 'tenant-sync-b',
        name: 'Sync Tenant B',
        code: 'SYNCB',
        currency: 'EGP',
      }),
    );

    ctxA = new ScopedExecutionContext({
      tenantId: 'tenant-sync-a',
      storeId: 'store-sync-a',
      userId: 'user-a',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'sync-corr-a',
    });
    ctxB = new ScopedExecutionContext({
      tenantId: 'tenant-sync-b',
      storeId: 'store-sync-b',
      userId: 'user-b',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'sync-corr-b',
    });

    await storeRepo.save(
      ctxA,
      Store.create({
        id: 'store-sync-a',
        tenantId: 'tenant-sync-a',
        name: 'Store A',
        code: 'STA',
      }),
    );
    await storeRepo.save(
      ctxB,
      Store.create({
        id: 'store-sync-b',
        tenantId: 'tenant-sync-b',
        name: 'Store B',
        code: 'STB',
      }),
    );
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('enqueues outbox events with monotonic per-tenant sequence numbers, serializes BigInt safely, and enforces idempotency', async () => {
    const first = await outboxRepo.enqueue(ctxA, {
      id: 'evt-1',
      aggregateType: 'SALE',
      aggregateId: 'sale-100',
      eventType: 'SALE_COMPLETED',
      payload: {
        saleNumber: 'POS-100',
        totalMinor: 150000n,
        currency: 'EGP',
      },
      idempotencyKey: 'idem-evt-1',
    });

    expect(first.sequenceNo).toBe(1);
    expect(first.payload).toEqual({
      saleNumber: 'POS-100',
      totalMinor: '150000',
      currency: 'EGP',
    });
    expect(first.syncedAt).toBeNull();

    // Idempotent replay with same key & aggregate metadata returns existing record without incrementing sequenceNo
    const replay = await outboxRepo.enqueue(ctxA, {
      id: 'evt-1-replay',
      aggregateType: 'SALE',
      aggregateId: 'sale-100',
      eventType: 'SALE_COMPLETED',
      payload: {
        saleNumber: 'POS-100',
        totalMinor: 150000n,
        currency: 'EGP',
      },
      idempotencyKey: 'idem-evt-1',
    });
    expect(replay.id).toBe('evt-1');
    expect(replay.sequenceNo).toBe(1);

    // Conflicting aggregate metadata with same idempotencyKey rejects with 409
    await expect(
      outboxRepo.enqueue(ctxA, {
        id: 'evt-1-conflict',
        aggregateType: 'SALE',
        aggregateId: 'sale-999',
        eventType: 'SALE_COMPLETED',
        payload: {},
        idempotencyKey: 'idem-evt-1',
      }),
    ).rejects.toThrow(/already used for a different event/);

    // Second event for tenant A gets sequenceNo = 2
    const second = await outboxRepo.enqueue(ctxA, {
      id: 'evt-2',
      aggregateType: 'PURCHASE',
      aggregateId: 'pur-200',
      eventType: 'PURCHASE_RECORDED',
      payload: { totalMinor: 300000n },
      idempotencyKey: 'idem-evt-2',
    });
    expect(second.sequenceNo).toBe(2);

    // First event for tenant B gets sequenceNo = 1 independently
    const tenantBFirst = await outboxRepo.enqueue(ctxB, {
      id: 'evt-b-1',
      aggregateType: 'SALE',
      aggregateId: 'sale-b-1',
      eventType: 'SALE_COMPLETED',
      payload: { totalMinor: 50000n },
      idempotencyKey: 'idem-evt-1',
    });
    expect(tenantBFirst.sequenceNo).toBe(1);
  });

  it('synchronizes pending outbox batches via OutboxSyncWorker and isolates tenants', async () => {
    await outboxRepo.enqueue(ctxA, {
      id: 'evt-a-1',
      aggregateType: 'SALE',
      aggregateId: 'sale-1',
      eventType: 'SALE_COMPLETED',
      payload: { seq: 1 },
      idempotencyKey: 'key-a-1',
    });
    await outboxRepo.enqueue(ctxA, {
      id: 'evt-a-2',
      aggregateType: 'SALE',
      aggregateId: 'sale-2',
      eventType: 'SALE_COMPLETED',
      payload: { seq: 2 },
      idempotencyKey: 'key-a-2',
    });
    await outboxRepo.enqueue(ctxA, {
      id: 'evt-a-3',
      aggregateType: 'EXPENSE',
      aggregateId: 'exp-1',
      eventType: 'EXPENSE_RECORDED',
      payload: { seq: 3 },
      idempotencyKey: 'key-a-3',
    });

    const statsBefore = await outboxRepo.getStats(ctxA);
    expect(statsBefore).toEqual({
      pendingCount: 3,
      syncedCount: 0,
      lastSequenceNo: 3,
    });

    // Transport accepts only the first 2 events on first attempt (partial ack + forged unknown ID ignored)
    const pushedBatches: OutboxEventRecord[][] = [];
    const partialTransport: OutboxSyncTransport = {
      pushBatch: (_ctx, events) => {
        pushedBatches.push([...events]);
        return Promise.resolve({
          acceptedIds: ['evt-a-1', 'evt-a-2', 'forged-unknown-id'],
        });
      },
    };

    const worker1 = new OutboxSyncWorker(outboxRepo, partialTransport);
    const run1 = await worker1.syncPendingBatch(ctxA, 10);
    expect(run1).toEqual({ fetched: 3, synced: 2 });
    expect(pushedBatches[0]?.map((e) => e.id)).toEqual(['evt-a-1', 'evt-a-2', 'evt-a-3']);

    const statsMiddle = await outboxRepo.getStats(ctxA);
    expect(statsMiddle).toEqual({
      pendingCount: 1,
      syncedCount: 2,
      lastSequenceNo: 3,
    });

    // Second sync run pushes only the remaining unsynced event ('evt-a-3')
    const fullTransport: OutboxSyncTransport = {
      pushBatch: (_ctx, events) =>
        Promise.resolve({
          acceptedIds: events.map((e) => e.id),
        }),
    };
    const worker2 = new OutboxSyncWorker(outboxRepo, fullTransport);
    const run2 = await worker2.syncPendingBatch(ctxA, 10);
    expect(run2).toEqual({ fetched: 1, synced: 1 });

    const statsAfter = await outboxRepo.getStats(ctxA);
    expect(statsAfter).toEqual({
      pendingCount: 0,
      syncedCount: 3,
      lastSequenceNo: 3,
    });
  });
});
