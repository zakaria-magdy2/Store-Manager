import type { Kysely } from 'kysely';
import { User } from '@retailos/core';
import type { Role } from '@retailos/core';
import type { UserRepository, ExecutionContext } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    if (!row) return null;

    return User.create({
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id ?? undefined,
      username: row.username,
      passwordHash: row.password_hash,
      fullName: row.full_name,
      role: row.role as Role,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }

  public async findByUsername(tenantId: string, username: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username.toLowerCase())
      .where('tenant_id', '=', tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    if (!row) return null;

    return User.create({
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id ?? undefined,
      username: row.username,
      passwordHash: row.password_hash,
      fullName: row.full_name,
      role: row.role as Role,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }

  public async listByTenant(ctx: ExecutionContext): Promise<User[]> {
    let query = this.db
      .selectFrom('users')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId);

    if (ctx.storeId) {
      query = query.where('store_id', '=', ctx.storeId);
    }

    const rows = await query.execute();

    return rows.map((r) =>
      User.create({
        id: r.id,
        tenantId: r.tenant_id,
        storeId: r.store_id ?? undefined,
        username: r.username,
        passwordHash: r.password_hash,
        fullName: r.full_name,
        role: r.role as Role,
        isActive: Boolean(r.is_active),
        createdAt: new Date(r.created_at),
      }),
    );
  }

  public async save(ctx: ExecutionContext, user: User): Promise<void> {
    if (user.tenantId !== ctx.tenantId) {
      throw new Error('TenantIsolationViolation: Cannot save user across different tenantId');
    }

    await this.db
      .insertInto('users')
      .values({
        id: user.id,
        tenant_id: user.tenantId,
        store_id: user.storeId ?? null,
        username: user.username,
        password_hash: user.passwordHash,
        full_name: user.fullName,
        role: user.role,
        is_active: user.isActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          store_id: user.storeId ?? null,
          password_hash: user.passwordHash,
          full_name: user.fullName,
          role: user.role,
          is_active: user.isActive ? 1 : 0,
        }),
      )
      .execute();
  }
}
