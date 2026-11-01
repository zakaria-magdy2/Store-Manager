import type { Money, StockMovement, StockMovementType } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';

export interface InventoryPositionRecord {
  id: string;
  tenantId: string;
  storeId: string;
  variantId: string;
  quantityOnHand: bigint;
  wacCost: Money;
  updatedAt: Date;
}

export interface ApplyStockMovementCommand {
  id: string;
  storeId: string;
  variantId: string;
  /** ISO currency of the tenant / variant; enforced against the cost currency. */
  currency: string;
  movementType: StockMovementType;
  /** Signed: positive receipt, negative issue. Never zero. */
  quantityDelta: bigint;
  /** Required for receipts. Ignored for issues, which use the live WAC snapshot. */
  unitCost?: Money | undefined;
  sourceType: string;
  sourceId: string;
  allowNegativeStock?: boolean | undefined;
}

export interface TransferStockCommand {
  outMovementId: string;
  inMovementId: string;
  fromStoreId: string;
  toStoreId: string;
  variantId: string;
  quantity: bigint;
  currency: string;
  sourceType: string;
  sourceId: string;
}

export interface InventoryRepository {
  getPosition(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
  ): Promise<InventoryPositionRecord | null>;
  listByStore(ctx: ExecutionContext, storeId: string): Promise<InventoryPositionRecord[]>;
  /** Applies one movement atomically: updates the position and appends the ledger row. */
  applyMovement(ctx: ExecutionContext, command: ApplyStockMovementCommand): Promise<StockMovement>;
  /** Two-phase transfer: issue from source and receive into destination atomically. */
  transfer(
    ctx: ExecutionContext,
    command: TransferStockCommand,
  ): Promise<{ out: StockMovement; in: StockMovement }>;
}

export interface StockMovementRepository {
  listByVariant(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
    limit?: number,
  ): Promise<StockMovement[]>;
  listBySource(ctx: ExecutionContext, sourceType: string, sourceId: string): Promise<StockMovement[]>;
}
