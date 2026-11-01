import type { Kysely } from 'kysely';
import { Money, StockMovement } from '@retailos/core';
import type { StockMovementType } from '@retailos/core';
import type { ExecutionContext, StockMovementRepository } from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';
import { toBigInt } from '../values.js';

export class SqliteStockMovementRepository implements StockMovementRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async listByVariant(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
    limit = 100,
  ): Promise<StockMovement[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const rows = await this.db
      .selectFrom('stock_movements')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .where('variant_id', '=', variantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLimit)
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  public async listBySource(
    ctx: ExecutionContext,
    sourceType: string,
    sourceId: string,
  ): Promise<StockMovement[]> {
    const rows = await this.db
      .selectFrom('stock_movements')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('source_type', '=', sourceType)
      .where('source_id', '=', sourceId)
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  private toEntity(row: {
    id: string;
    tenant_id: string;
    store_id: string;
    variant_id: string;
    movement_type: string;
    quantity_delta: bigint;
    unit_cost: bigint;
    currency: string;
    resulting_quantity: bigint;
    resulting_wac: bigint;
    source_type: string;
    source_id: string;
    created_by_user_id: string;
    created_at: string;
  }): StockMovement {
    return StockMovement.create({
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      variantId: row.variant_id,
      movementType: row.movement_type as StockMovementType,
      quantityDelta: toBigInt(row.quantity_delta),
      unitCost: Money.fromMinor(toBigInt(row.unit_cost), row.currency),
      resultingQuantity: toBigInt(row.resulting_quantity),
      resultingWac: Money.fromMinor(toBigInt(row.resulting_wac), row.currency),
      sourceType: row.source_type,
      sourceId: row.source_id,
      createdByUserId: row.created_by_user_id,
      createdAt: new Date(row.created_at),
    });
  }
}
