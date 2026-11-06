import { createHash, randomUUID } from 'node:crypto';
import { Permissions } from '@retailos/core';
import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

const SENSITIVE_KEY_PATTERN = /(password|passphrase|token|secret|pin)/i;

function sanitizeMetadata(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeMetadata(val),
      ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export interface ComputeAuditHashInput {
  id: string;
  tenantId: string;
  storeId: string | null;
  actorUserId: string | null;
  actorUsername: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadataJson: string;
  previousHash: string;
  createdAt: string;
}

export function computeAuditEntryHash(input: ComputeAuditHashInput): string {
  const payload = [
    input.id,
    input.tenantId,
    input.storeId ?? '',
    input.actorUserId ?? '',
    input.actorUsername,
    input.actorRole,
    input.action,
    input.entityType,
    input.entityId ?? '',
    input.summary,
    input.metadataJson,
    input.previousHash,
    input.createdAt,
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface RecordAuditLogInput {
  id?: string | undefined;
  storeId?: string | null | undefined;
  actorUserId?: string | null | undefined;
  actorUsername: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string | null | undefined;
  summary: string;
  metadata?: Record<string, unknown> | undefined;
  occurredAt?: Date | undefined;
}

export interface AuditLogEntryRecord {
  sequenceNo: number;
  id: string;
  tenantId: string;
  storeId: string | null;
  actorUserId: string | null;
  actorUsername: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  headHash: string;
  brokenAtId?: string | undefined;
}

export interface ListAuditLogsOptions {
  storeId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export class SqliteAuditLogRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async record(
    ctx: ExecutionContext,
    input: RecordAuditLogInput,
  ): Promise<AuditLogEntryRecord> {
    const id = input.id ?? randomUUID();
    const storeId = input.storeId ?? ctx.storeId ?? null;
    const actorUserId =
      input.actorUserId === undefined
        ? ctx.userId === 'system'
          ? null
          : ctx.userId
        : input.actorUserId;
    const createdAt = (input.occurredAt ?? new Date()).toISOString();
    const sanitizedMetadata = sanitizeMetadata(input.metadata ?? {}) as Record<string, unknown>;
    const metadataJson = JSON.stringify(sanitizedMetadata);

    return this.db.transaction().execute(async (trx) => {
      const latest = await trx
        .selectFrom('audit_logs')
        .select(['entry_hash', 'sequence_no'])
        .where('tenant_id', '=', ctx.tenantId)
        .orderBy('sequence_no', 'desc')
        .limit(1)
        .executeTakeFirst();

      const previousHash = latest?.entry_hash ?? 'GENESIS';
      const entryHash = computeAuditEntryHash({
        id,
        tenantId: ctx.tenantId,
        storeId,
        actorUserId,
        actorUsername: input.actorUsername,
        actorRole: input.actorRole,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        metadataJson,
        previousHash,
        createdAt,
      });

      await trx
        .insertInto('audit_logs')
        .values({
          id,
          tenant_id: ctx.tenantId,
          store_id: storeId,
          actor_user_id: actorUserId,
          actor_username: input.actorUsername,
          actor_role: input.actorRole,
          action: input.action,
          entity_type: input.entityType,
          entity_id: input.entityId ?? null,
          summary: input.summary,
          metadata_json: metadataJson,
          previous_hash: previousHash,
          entry_hash: entryHash,
          created_at: createdAt,
        })
        .execute();

      const inserted = await trx
        .selectFrom('audit_logs')
        .select('sequence_no')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      return {
        sequenceNo: inserted.sequence_no,
        id,
        tenantId: ctx.tenantId,
        storeId,
        actorUserId,
        actorUsername: input.actorUsername,
        actorRole: input.actorRole,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        metadata: sanitizedMetadata,
        previousHash,
        entryHash,
        createdAt,
      };
    });
  }

  public async list(
    ctx: ExecutionContext,
    options: ListAuditLogsOptions = {},
  ): Promise<AuditLogEntryRecord[]> {
    ctx.assertPermission(Permissions.AUDIT_LOG_VIEW);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const effectiveStoreId = ctx.storeId ?? options.storeId;

    if (ctx.storeId && options.storeId && options.storeId !== ctx.storeId) {
      throw new Error('UnauthorizedError: Store scope mismatch for audit log query');
    }

    let query = this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId);

    if (effectiveStoreId) {
      query = query.where((eb) =>
        eb.or([eb('store_id', '=', effectiveStoreId), eb('store_id', 'is', null)]),
      );
    }
    if (options.action) {
      query = query.where('action', '=', options.action);
    }
    if (options.from) {
      query = query.where('created_at', '>=', `${options.from}T00:00:00.000Z`);
    }
    if (options.to) {
      query = query.where('created_at', '<=', `${options.to}T23:59:59.999Z`);
    }

    const rows = await query.orderBy('sequence_no', 'desc').limit(limit).execute();
    return rows.map((row) => ({
      sequenceNo: row.sequence_no,
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
      createdAt: row.created_at,
    }));
  }

  public async verifyChain(ctx: ExecutionContext): Promise<AuditChainVerificationResult> {
    ctx.assertPermission(Permissions.AUDIT_LOG_VIEW);
    const rows = await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('sequence_no', 'asc')
      .execute();

    let expectedPreviousHash = 'GENESIS';
    for (const row of rows) {
      if (row.previous_hash !== expectedPreviousHash) {
        return {
          valid: false,
          checkedCount: rows.length,
          headHash: expectedPreviousHash,
          brokenAtId: row.id,
        };
      }
      const recomputed = computeAuditEntryHash({
        id: row.id,
        tenantId: row.tenant_id,
        storeId: row.store_id,
        actorUserId: row.actor_user_id,
        actorUsername: row.actor_username,
        actorRole: row.actor_role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        summary: row.summary,
        metadataJson: row.metadata_json,
        previousHash: row.previous_hash,
        createdAt: row.created_at,
      });
      if (row.entry_hash !== recomputed) {
        return {
          valid: false,
          checkedCount: rows.length,
          headHash: expectedPreviousHash,
          brokenAtId: row.id,
        };
      }
      expectedPreviousHash = row.entry_hash;
    }

    return {
      valid: true,
      checkedCount: rows.length,
      headHash: expectedPreviousHash,
    };
  }
}
