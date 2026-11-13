import type { Kysely, Selectable } from 'kysely';
import { User } from '@retailos/core';
import type { Role } from '@retailos/core';
import type { UserRepository, ExecutionContext } from '@retailos/application';
import type { RetailOSDatabase, UsersTable } from '../types.js';

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  private mapRowToUser(row: Selectable<UsersTable>): User {
    return User.create({
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id ?? undefined,
      username: row.username,
      passwordHash: row.password_hash,
      fullName: row.full_name,
      phone: row.phone ?? undefined,
      employmentStartDate: row.employment_start_date ?? row.created_at.slice(0, 10),
      shiftStartTime: row.shift_start_time ?? undefined,
      lateGraceMinutes: Number(row.late_grace_minutes ?? 0),
      role: row.role as Role,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }

  public async findById(ctx: ExecutionContext, id: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    return row ? this.mapRowToUser(row) : null;
  }

  public async findByUsername(tenantId: string, username: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username.toLowerCase())
      .where('tenant_id', '=', tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    return row ? this.mapRowToUser(row) : null;
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

    return rows.map((r) => this.mapRowToUser(r));
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
        phone: user.phone ?? null,
        employment_start_date: user.employmentStartDate,
        shift_start_time: user.shiftStartTime ?? null,
        late_grace_minutes: user.lateGraceMinutes,
        role: user.role,
        is_active: user.isActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          store_id: user.storeId ?? null,
          password_hash: user.passwordHash,
          full_name: user.fullName,
          phone: user.phone ?? null,
          employment_start_date: user.employmentStartDate,
          shift_start_time: user.shiftStartTime ?? null,
          late_grace_minutes: user.lateGraceMinutes,
          role: user.role,
          is_active: user.isActive ? 1 : 0,
        }).where('users.tenant_id', '=', ctx.tenantId),
      )
      .execute();
    const saved = await this.db.selectFrom('users').select('id').where('id', '=', user.id).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
    if (!saved) throw new Error('TenantIsolationViolation: User id belongs to another tenant');
  }
}
