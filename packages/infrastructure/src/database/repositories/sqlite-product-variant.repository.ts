import type { Kysely } from 'kysely';
import { Money, ProductVariant, parseAttributes, serializeAttributes } from '@retailos/core';
import type { ExecutionContext, ProductVariantRepository } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';
import { toBigInt } from '../values.js';

export class SqliteProductVariantRepository implements ProductVariantRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<ProductVariant | null> {
    const row = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async findBySku(ctx: ExecutionContext, sku: string): Promise<ProductVariant | null> {
    const row = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('sku', '=', sku.trim().toUpperCase())
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async findByBarcode(
    ctx: ExecutionContext,
    barcode: string,
  ): Promise<ProductVariant | null> {
    const row = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('barcode', '=', barcode.trim())
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  public async listByProduct(
    ctx: ExecutionContext,
    productId: string,
  ): Promise<ProductVariant[]> {
    const rows = await this.db
      .selectFrom('product_variants')
      .selectAll()
      .where('product_id', '=', productId)
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('sku', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  public async save(ctx: ExecutionContext, variant: ProductVariant): Promise<void> {
    if (variant.tenantId !== ctx.tenantId) {
      throw new Error(
        'TenantIsolationViolation: Cannot save product variant across different tenantId',
      );
    }

    await this.db
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

  private toEntity(row: {
    id: string;
    tenant_id: string;
    product_id: string;
    sku: string;
    barcode: string | null;
    attributes_json: string;
    retail_price: bigint;
    currency: string;
    reorder_point: bigint;
    is_active: number;
    created_at: string;
  }): ProductVariant {
    return ProductVariant.create({
      id: row.id,
      tenantId: row.tenant_id,
      productId: row.product_id,
      sku: row.sku,
      barcode: row.barcode ?? undefined,
      attributes: parseAttributes(row.attributes_json),
      retailPrice: Money.fromMinor(toBigInt(row.retail_price), row.currency),
      reorderPoint: toBigInt(row.reorder_point),
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
    });
  }
}
