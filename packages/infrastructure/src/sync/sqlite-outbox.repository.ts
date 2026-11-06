import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ExecutionContext } from '@retailos/application';
import type { RetailOSDatabase } from '../database/types.js';

export interface OutboxEventRecord {
  id: string;
  tenantId: string;
  storeId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sequenceNo: number;
  idempotencyKey: string;
  syncedAt: string | null;
  createdAt: string;
}

export interface EnqueueOutboxEventInput {
  id?: string | undefined;
  storeId?: string | null | undefined;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt?: Date | undefined;
}

export interface OutboxSyncTransport {
  pushBatch(
    ctx: ExecutionContext,
    events: readonly OutboxEventRecord[],
  ): Promise<{ acceptedIds: readonly string[] }>;
}

function serializeOutboxPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function parseOutboxPayload(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export class SqliteOutboxRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async enqueue(
    ctx: ExecutionContext,
    input: EnqueueOutboxEventInput,
  ): Promise<OutboxEventRecord> {
    const storeScope = input.storeId ?? ctx.storeId ?? null;
    if (ctx.storeId && storeScope && ctx.storeId !== storeScope) {
      throw Object.assign(new Error('Store scope mismatch for outbox event'), { status: 403 });
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error('Outbox event requires a non-empty idempotencyKey'), {
        status: 400,
      });
    }

    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();

      if (existing) {
        if (
          existing.aggregate_type !== input.aggregateType ||
          existing.aggregate_id !== input.aggregateId ||
          existing.event_type !== input.eventType
        ) {
          throw Object.assign(
            new Error('Outbox idempotency key is already used for a different event'),
            { status: 409 },
          );
        }
        return this.toRecord(existing);
      }

      const lastRow = await trx
        .selectFrom('outbox_events')
        .select('sequence_no')
        .where('tenant_id', '=', ctx.tenantId)
        .orderBy('sequence_no', 'desc')
        .limit(1)
        .executeTakeFirst();

      const sequenceNo = lastRow ? lastRow.sequence_no + 1 : 1;
      const id = input.id ?? randomUUID();
      const createdAt = (input.createdAt ?? new Date()).toISOString();
      const serializedPayload = serializeOutboxPayload(input.payload);

      await trx
        .insertInto('outbox_events')
        .values({
          id,
          tenant_id: ctx.tenantId,
          store_id: storeScope,
          aggregate_type: input.aggregateType,
          aggregate_id: input.aggregateId,
          event_type: input.eventType,
          payload: serializedPayload,
          sequence_no: sequenceNo,
          idempotency_key: idempotencyKey,
          synced_at: null,
          created_at: createdAt,
        })
        .execute();

      return {
        id,
        tenantId: ctx.tenantId,
        storeId: storeScope,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: parseOutboxPayload(serializedPayload),
        sequenceNo,
        idempotencyKey,
        syncedAt: null,
        createdAt,
      };
    });
  }

  public async listPending(ctx: ExecutionContext, limit = 50): Promise<OutboxEventRecord[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    let query = this.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('synced_at', 'is', null);

    if (ctx.storeId) {
      query = query.where('store_id', '=', ctx.storeId);
    }

    const rows = await query.orderBy('sequence_no', 'asc').limit(safeLimit).execute();
    return rows.map((row) => this.toRecord(row));
  }

  public async markSynced(
    ctx: ExecutionContext,
    eventIds: readonly string[],
    syncedAt: Date = new Date(),
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0;
    }
    const iso = syncedAt.toISOString();
    let query = this.db
      .updateTable('outbox_events')
      .set({ synced_at: iso })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', [...eventIds])
      .where('synced_at', 'is', null);

    if (ctx.storeId) {
      query = query.where('store_id', '=', ctx.storeId);
    }

    const result = await query.executeTakeFirst();
    const updatedCount = result.numUpdatedRows ?? 0n;
    let count = 0;
    for (let i = 0n; i < updatedCount; i += 1n) {
      count += 1;
    }
    return count;
  }

  public async getStats(ctx: ExecutionContext): Promise<{
    pendingCount: number;
    syncedCount: number;
    lastSequenceNo: number;
  }> {
    let query = this.db
      .selectFrom('outbox_events')
      .select(['sequence_no', 'synced_at'])
      .where('tenant_id', '=', ctx.tenantId);

    if (ctx.storeId) {
      query = query.where('store_id', '=', ctx.storeId);
    }

    const rows = await query.execute();
    let pendingCount = 0;
    let syncedCount = 0;
    let lastSequenceNo = 0;

    for (const row of rows) {
      if (row.synced_at === null) {
        pendingCount += 1;
      } else {
        syncedCount += 1;
      }
      if (row.sequence_no > lastSequenceNo) {
        lastSequenceNo = row.sequence_no;
      }
    }

    return {
      pendingCount,
      syncedCount,
      lastSequenceNo,
    };
  }

  private toRecord(row: {
    id: string;
    tenant_id: string;
    store_id: string | null;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: string;
    sequence_no: number;
    idempotency_key: string;
    synced_at: string | null;
    created_at: string;
  }): OutboxEventRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: parseOutboxPayload(row.payload),
      sequenceNo: row.sequence_no,
      idempotencyKey: row.idempotency_key,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
    };
  }
}

export class OutboxSyncWorker {
  constructor(
    private readonly outboxRepo: SqliteOutboxRepository,
    private readonly transport: OutboxSyncTransport,
  ) {}

  public async syncPendingBatch(
    ctx: ExecutionContext,
    batchSize = 50,
  ): Promise<{ fetched: number; synced: number }> {
    const pending = await this.outboxRepo.listPending(ctx, batchSize);
    if (pending.length === 0) {
      return { fetched: 0, synced: 0 };
    }

    const pendingIdSet = new Set(pending.map((event) => event.id));
    const response = await this.transport.pushBatch(ctx, pending);
    const validAcceptedIds = response.acceptedIds.filter((id) => pendingIdSet.has(id));

    const synced = await this.outboxRepo.markSynced(ctx, validAcceptedIds);
    return {
      fetched: pending.length,
      synced,
    };
  }
}
