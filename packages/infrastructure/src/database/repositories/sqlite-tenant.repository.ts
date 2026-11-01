import type { Kysely } from 'kysely';
import { Tenant } from '@retailos/core';
import type { TenantRepository } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteTenantRepository implements TenantRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(id: string): Promise<Tenant | null> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;

    return Tenant.create({
      id: row.id,
      name: row.name,
      code: row.code,
      currency: row.currency,
      isActive: Boolean(row.is_active),
      allowNegativeStock: Boolean(row.allow_negative_stock),
      createdAt: new Date(row.created_at),
    });
  }

  public async findByCode(code: string): Promise<Tenant | null> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('code', '=', code.toUpperCase())
      .executeTakeFirst();

    if (!row) return null;

    return Tenant.create({
      id: row.id,
      name: row.name,
      code: row.code,
      currency: row.currency,
      isActive: Boolean(row.is_active),
      allowNegativeStock: Boolean(row.allow_negative_stock),
      createdAt: new Date(row.created_at),
    });
  }

  public async save(tenant: Tenant): Promise<void> {
    await this.db
      .insertInto('tenants')
      .values({
        id: tenant.id,
        name: tenant.name,
        code: tenant.code,
        currency: tenant.currency,
        is_active: tenant.isActive ? 1 : 0,
        allow_negative_stock: tenant.allowNegativeStock ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: tenant.name,
          currency: tenant.currency,
          is_active: tenant.isActive ? 1 : 0,
          allow_negative_stock: tenant.allowNegativeStock ? 1 : 0,
        }),
      )
      .execute();
  }

  public async listAll(): Promise<Tenant[]> {
    const rows = await this.db.selectFrom('tenants').selectAll().execute();
    return rows.map((r) =>
      Tenant.create({
        id: r.id,
        name: r.name,
        code: r.code,
        currency: r.currency,
        isActive: Boolean(r.is_active),
        allowNegativeStock: Boolean(r.allow_negative_stock),
        createdAt: new Date(r.created_at),
      }),
    );
  }
}
