import type { Kysely } from 'kysely';
import { Product, serializeAttributes } from '@retailos/core';
import type { ProductVariant } from '@retailos/core';
import type {
  ExecutionContext,
  ProductListFilter,
  ProductRepository,
} from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';

export class SqliteProductRepository implements ProductRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<Product | null> {
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async findBySku(ctx: ExecutionContext, sku: string): Promise<Product | null> {
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('sku', '=', sku.trim().toUpperCase())
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async listByTenant(
    ctx: ExecutionContext,
    filter?: ProductListFilter,
  ): Promise<Product[]> {
    let query = this.db
      .selectFrom('products')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId);

    if (filter?.categoryId !== undefined) {
      query = query.where('category_id', '=', filter.categoryId);
    }
    if (filter?.includeInactive !== true) {
      query = query.where('is_active', '=', 1);
    }
    if (filter?.search !== undefined && filter.search.trim() !== '') {
      const pattern = `%${filter.search.trim()}%`;
      query = query.where((eb) => eb.or([eb('name', 'like', pattern), eb('sku', 'like', pattern)]));
    }

    const rows = await query.orderBy('name', 'asc').execute();
    return rows.map((row) => this.toEntity(row));
  }

  public async save(ctx: ExecutionContext, product: Product): Promise<void> {
    this.assertTenant(ctx, product.tenantId);
    await this.upsertProduct(this.db, product);
  }

  public async saveWithVariants(
    ctx: ExecutionContext,
    product: Product,
    variants: readonly ProductVariant[],
  ): Promise<void> {
    this.assertTenant(ctx, product.tenantId);

    await this.db.transaction().execute(async (trx) => {
      await this.upsertProduct(trx, product);

      for (const variant of variants) {
        if (variant.tenantId !== ctx.tenantId || variant.productId !== product.id) {
          throw new Error(
            'TenantIsolationViolation: Variant does not belong to the product tenant/product',
          );
        }

        await trx
          .insertInto('product_variants')
          .values({
            id: variant.id,
            tenant_id: variant.tenantId,
            product_id: variant.productId,
            sku: variant.sku,
            barcode: variant.barcode ?? null,
            attributes_json: serializeAttributes(variant.attributes),
            retail_price: variant.retailPrice.amount,
            currency: variant.retailPrice.currency.code,
            reorder_point: variant.reorderPoint,
            is_active: variant.isActive ? 1 : 0,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              sku: variant.sku,
              barcode: variant.barcode ?? null,
              attributes_json: serializeAttributes(variant.attributes),
              retail_price: variant.retailPrice.amount,
              currency: variant.retailPrice.currency.code,
              reorder_point: variant.reorderPoint,
              is_active: variant.isActive ? 1 : 0,
            }),
          )
          .execute();
      }
    });
  }

  private async upsertProduct(db: Kysely<RetailOSDatabase>, product: Product): Promise<void> {
    await db
      .insertInto('products')
      .values({
        id: product.id,
        tenant_id: product.tenantId,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode ?? null,
        category_id: product.categoryId ?? null,
        has_variants: product.hasVariants ? 1 : 0,
        is_active: product.isActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: product.name,
          barcode: product.barcode ?? null,
          category_id: product.categoryId ?? null,
          has_variants: product.hasVariants ? 1 : 0,
          is_active: product.isActive ? 1 : 0,
        }),
      )
      .execute();
  }

  private assertTenant(ctx: ExecutionContext, tenantId: string): void {
    if (tenantId !== ctx.tenantId) {
      throw new Error('TenantIsolationViolation: Cannot save product across different tenantId');
    }
  }

  private toEntity(row: {
    id: string;
    tenant_id: string;
    name: string;
    sku: string;
    barcode: string | null;
    category_id: string | null;
    has_variants: number;
    is_active: number;
    created_at: string;
  }): Product {
    return Product.create({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode ?? undefined,
      categoryId: row.category_id ?? undefined,
      hasVariants: Boolean(row.has_variants),
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }
}
