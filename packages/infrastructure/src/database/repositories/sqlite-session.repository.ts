import type { Kysely } from 'kysely';
import type { SessionRepository, ActiveSessionRecord } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async createSession(session: {
    id: string;
    tenantId: string;
    storeId?: string | undefined;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db
      .insertInto('sessions')
      .values({
        id: session.id,
        tenant_id: session.tenantId,
        store_id: session.storeId ?? null,
        user_id: session.userId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt.toISOString(),
        is_revoked: 0,
      })
      .execute();
  }

  public async findSessionByTokenHash(tokenHash: string): Promise<ActiveSessionRecord | null> {
    const row = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id ?? undefined,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at),
      isRevoked: Boolean(row.is_revoked),
      createdAt: new Date(row.created_at),
    };
  }

  public async revokeSession(tokenHash: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ is_revoked: 1 })
      .where('token_hash', '=', tokenHash)
      .execute();
  }

  public async revokeAllUserSessions(tenantId: string, userId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ is_revoked: 1 })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .execute();
  }
}
