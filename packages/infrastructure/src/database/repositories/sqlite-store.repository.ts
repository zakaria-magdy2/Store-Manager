import type { Kysely } from 'kysely';
import { Store } from '@retailos/core';
import type { StoreRepository, ExecutionContext } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteStoreRepository implements StoreRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<Store | null> {
    const row = await this.db
      .selectFrom('stores')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    if (!row) return null;

    return Store.create({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      code: row.code,
      address: row.address ?? undefined,
      phone: row.phone ?? undefined,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }

  public async findByCode(ctx: ExecutionContext, code: string): Promise<Store | null> {
    const row = await this.db
      .selectFrom('stores')
      .selectAll()
      .where('code', '=', code.toUpperCase())
      .where('tenant_id', '=', ctx.tenantId) // STRICT: Tenant boundary
      .executeTakeFirst();

    if (!row) return null;

    return Store.create({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      code: row.code,
      address: row.address ?? undefined,
      phone: row.phone ?? undefined,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }

  public async listByTenant(ctx: ExecutionContext): Promise<Store[]> {
    let query = this.db
      .selectFrom('stores')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId);

    // If caller has storeId (e.g. Cashier or Store Manager), restrict to their store
    if (ctx.storeId) {
      query = query.where('id', '=', ctx.storeId);
    }

    const rows = await query.execute();
    return rows.map((r) =>
      Store.create({
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        code: r.code,
        address: r.address ?? undefined,
        phone: r.phone ?? undefined,
        isActive: Boolean(r.is_active),
        createdAt: new Date(r.created_at),
      }),
    );
  }

  public async save(ctx: ExecutionContext, store: Store): Promise<void> {
    if (store.tenantId !== ctx.tenantId) {
      throw new Error('TenantIsolationViolation: Cannot save store across different tenantId');
    }

    await this.db
      .insertInto('stores')
      .values({
        id: store.id,
        tenant_id: store.tenantId,
        name: store.name,
        code: store.code,
        address: store.address ?? null,
        phone: store.phone ?? null,
        is_active: store.isActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: store.name,
          address: store.address ?? null,
          phone: store.phone ?? null,
          is_active: store.isActive ? 1 : 0,
        }).where('stores.tenant_id', '=', ctx.tenantId),
      )
      .execute();
    const saved = await this.db.selectFrom('stores').select('id').where('id', '=', store.id).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
    if (!saved) throw new Error('TenantIsolationViolation: Store id belongs to another tenant');
  }
}
