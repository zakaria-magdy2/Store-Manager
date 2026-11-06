import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  InventoryPosition,
  InvalidStockOperationError,
  Money,
  StockMovement,
} from '@retailos/core';
import type {
  ApplyStockMovementCommand,
  ExecutionContext,
} from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';
import { toBigInt } from '../values.js';

export type InventoryExecutor = Kysely<RetailOSDatabase>;

export interface InventoryRow {
  id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  quantity_on_hand: bigint;
  wac_cost: bigint;
  currency: string;
  updated_at: string;
}

export async function findInventoryRow(
  db: InventoryExecutor,
  ctx: ExecutionContext,
  storeId: string,
  variantId: string,
): Promise<InventoryRow | undefined> {
  return db
    .selectFrom('inventory_items')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', storeId)
    .where('variant_id', '=', variantId)
    .executeTakeFirst();
}

export function toInventoryPosition(row: InventoryRow): InventoryPosition {
  return InventoryPosition.create({
    variantId: row.variant_id,
    quantityOnHand: toBigInt(row.quantity_on_hand),
    wacCost: Money.fromMinor(toBigInt(row.wac_cost), row.currency),
  });
}

export function assertPositionCurrency(position: InventoryPosition, currency: string): void {
  if (position.wacCost.currency.code !== currency) {
    throw new InvalidStockOperationError(
      `Inventory currency ${position.wacCost.currency.code} does not match requested currency ${currency}`,
    );
  }
}

export async function persistInventoryPosition(
  db: InventoryExecutor,
  ctx: ExecutionContext,
  storeId: string,
  existingRow: InventoryRow | undefined,
  position: InventoryPosition,
  now: Date,
): Promise<void> {
  if (existingRow) {
    await db
      .updateTable('inventory_items')
      .set({
        quantity_on_hand: position.quantityOnHand,
        wac_cost: position.wacCost.amount,
        updated_at: now.toISOString(),
      })
      .where('id', '=', existingRow.id)
      .where('tenant_id', '=', ctx.tenantId)
      .execute();
    return;
  }

  await db
    .insertInto('inventory_items')
    .values({
      id: `inv_${randomUUID()}`,
      tenant_id: ctx.tenantId,
      store_id: storeId,
      variant_id: position.variantId,
      quantity_on_hand: position.quantityOnHand,
      wac_cost: position.wacCost.amount,
      currency: position.wacCost.currency.code,
      updated_at: now.toISOString(),
    })
    .execute();
}

export async function insertStockMovement(
  db: InventoryExecutor,
  movement: StockMovement,
): Promise<void> {
  await db
    .insertInto('stock_movements')
    .values({
      id: movement.id,
      tenant_id: movement.tenantId,
      store_id: movement.storeId,
      variant_id: movement.variantId,
      movement_type: movement.movementType,
      quantity_delta: movement.quantityDelta,
      unit_cost: movement.unitCost.amount,
      currency: movement.unitCost.currency.code,
      resulting_quantity: movement.resultingQuantity,
      resulting_wac: movement.resultingWac.amount,
      source_type: movement.sourceType,
      source_id: movement.sourceId,
      created_by_user_id: movement.createdByUserId,
      created_at: movement.createdAt.toISOString(),
    })
    .execute();
}

/**
 * Applies exactly one stock movement inside an existing transaction.
 *
 * Both the standalone inventory repository and the checkout repository use this
 * helper, guaranteeing identical WAC, negative-stock and currency rules no matter
 * which use case triggered the movement.
 */
export async function applyStockMovementInTransaction(
  db: InventoryExecutor,
  ctx: ExecutionContext,
  command: ApplyStockMovementCommand,
): Promise<StockMovement> {
  if (command.quantityDelta === 0n) {
    throw new InvalidStockOperationError('Stock movement quantity delta cannot be zero');
  }

  const existingRow = await findInventoryRow(db, ctx, command.storeId, command.variantId);
  const current = existingRow
    ? toInventoryPosition(existingRow)
    : InventoryPosition.empty(command.variantId, command.currency);
  assertPositionCurrency(current, command.currency);

  let next: InventoryPosition;
  let unitCost: Money;

  if (command.quantityDelta > 0n) {
    if (!command.unitCost) {
      throw new InvalidStockOperationError('Incoming stock movements require a unit cost');
    }
    if (command.unitCost.currency.code !== command.currency) {
      throw new InvalidStockOperationError(
        `Unit cost currency ${command.unitCost.currency.code} does not match inventory currency ${command.currency}`,
      );
    }
    next = current.receive(command.quantityDelta, command.unitCost);
    unitCost = command.unitCost;
  } else {
    next = current.issue(-command.quantityDelta, command.allowNegativeStock ?? false);
    unitCost = current.wacCost;
  }

  const now = new Date();
  await persistInventoryPosition(db, ctx, command.storeId, existingRow, next, now);

  const movement = StockMovement.create({
    id: command.id,
    tenantId: ctx.tenantId,
    storeId: command.storeId,
    variantId: command.variantId,
    movementType: command.movementType,
    quantityDelta: command.quantityDelta,
    unitCost,
    resultingQuantity: next.quantityOnHand,
    resultingWac: next.wacCost,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    createdByUserId: ctx.userId,
    createdAt: now,
  });

  await insertStockMovement(db, movement);
  return movement;
}
