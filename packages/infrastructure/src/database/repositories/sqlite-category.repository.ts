import type { Kysely } from 'kysely';
import { Category } from '@retailos/core';
import type { CategoryRepository, ExecutionContext } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteCategoryRepository implements CategoryRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<Category | null> {
    const row = await this.db
      .selectFrom('categories')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async findByCode(ctx: ExecutionContext, code: string): Promise<Category | null> {
    const row = await this.db
      .selectFrom('categories')
      .selectAll()
      .where('code', '=', code.trim().toUpperCase())
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async listByTenant(ctx: ExecutionContext): Promise<Category[]> {
    const rows = await this.db
      .selectFrom('categories')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('name', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  public async save(ctx: ExecutionContext, category: Category): Promise<void> {
    if (category.tenantId !== ctx.tenantId) {
      throw new Error('TenantIsolationViolation: Cannot save category across different tenantId');
    }

    await this.db
      .insertInto('categories')
      .values({
        id: category.id,
        tenant_id: category.tenantId,
        parent_id: category.parentId ?? null,
        name: category.name,
        code: category.code,
        is_active: category.isActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          parent_id: category.parentId ?? null,
          name: category.name,
          is_active: category.isActive ? 1 : 0,
        }).where('categories.tenant_id', '=', ctx.tenantId),
      )
      .execute();
    const saved = await this.db.selectFrom('categories').select('id').where('id', '=', category.id).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
    if (!saved) throw new Error('TenantIsolationViolation: Category id belongs to another tenant');
  }

  private toEntity(row: {
    id: string;
    tenant_id: string;
    parent_id: string | null;
    name: string;
    code: string;
    is_active: number;
    created_at: string;
  }): Category {
    return Category.create({
      id: row.id,
      tenantId: row.tenant_id,
      parentId: row.parent_id ?? undefined,
      name: row.name,
      code: row.code,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }
}
