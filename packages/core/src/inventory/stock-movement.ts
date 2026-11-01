import { Entity } from '../common/entity.base.js';
import { InvalidStockOperationError } from '../common/errors.js';
import type { Money } from '../money/money.js';

export const StockMovementTypes = {
  PURCHASE_RECEIPT: 'PURCHASE_RECEIPT',
  SALE: 'SALE',
  CUSTOMER_RETURN: 'CUSTOMER_RETURN',
  SUPPLIER_RETURN: 'SUPPLIER_RETURN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  INVENTORY_ADJUSTMENT: 'INVENTORY_ADJUSTMENT',
  DAMAGE_WRITE_OFF: 'DAMAGE_WRITE_OFF',
} as const;

export type StockMovementType = keyof typeof StockMovementTypes;

export const StockMovementSourceTypes = {
  SALE: 'SALE',
  PURCHASE: 'PURCHASE',
  RETURN: 'RETURN',
  TRANSFER: 'TRANSFER',
  ADJUSTMENT: 'ADJUSTMENT',
  DAMAGE: 'DAMAGE',
  MANUAL: 'MANUAL',
} as const;

export type StockMovementSourceType = keyof typeof StockMovementSourceTypes;

export interface StockMovementProps {
  tenantId: string;
  storeId: string;
  variantId: string;
  movementType: StockMovementType;
  /** Signed delta: positive for receipts, negative for issues. Never zero. */
  quantityDelta: bigint;
  /** Receipt cost, or the immutable WAC snapshot for an issue. */
  unitCost: Money;
  resultingQuantity: bigint;
  resultingWac: Money;
  sourceType: string;
  sourceId: string;
  createdByUserId: string;
}

/**
 * Immutable append-only inventory ledger entry.
 *
 * There are intentionally no mutators. Corrections are made by appending a
 * compensating movement, never by updating or deleting history (ADR-006 spirit,
 * extended to inventory).
 */
export class StockMovement extends Entity<StockMovementProps> {
  private constructor(
    id: string,
    props: StockMovementProps,
    createdAt?: Date,
    updatedAt?: Date,
  ) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    storeId: string;
    variantId: string;
    movementType: StockMovementType;
    quantityDelta: bigint;
    unitCost: Money;
    resultingQuantity: bigint;
    resultingWac: Money;
    sourceType: string;
    sourceId: string;
    createdByUserId: string;
    createdAt?: Date;
  }): StockMovement {
    if (!params.id.trim()) {
      throw new InvalidStockOperationError('Stock movement requires an id');
    }
    if (!params.tenantId.trim() || !params.storeId.trim() || !params.variantId.trim()) {
      throw new InvalidStockOperationError(
        'Stock movement requires tenantId, storeId and variantId',
      );
    }
    if (params.quantityDelta === 0n) {
      throw new InvalidStockOperationError('Stock movement quantity delta cannot be zero');
    }
    if (params.unitCost.isNegative() || params.resultingWac.isNegative()) {
      throw new InvalidStockOperationError('Stock movement costs cannot be negative');
    }
    if (params.unitCost.currency.code !== params.resultingWac.currency.code) {
      throw new InvalidStockOperationError('Stock movement cost currencies must match');
    }
    if (!params.sourceType.trim() || !params.sourceId.trim()) {
      throw new InvalidStockOperationError('Stock movement requires a source type and source id');
    }
    if (!params.createdByUserId.trim()) {
      throw new InvalidStockOperationError('Stock movement requires the acting user id');
    }

    return new StockMovement(
      params.id,
      {
        tenantId: params.tenantId,
        storeId: params.storeId,
        variantId: params.variantId,
        movementType: params.movementType,
        quantityDelta: params.quantityDelta,
        unitCost: params.unitCost,
        resultingQuantity: params.resultingQuantity,
        resultingWac: params.resultingWac,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        createdByUserId: params.createdByUserId,
      },
      params.createdAt,
      params.createdAt,
    );
  }

  public get tenantId(): string {
    return this.props.tenantId;
  }

  public get storeId(): string {
    return this.props.storeId;
  }

  public get variantId(): string {
    return this.props.variantId;
  }

  public get movementType(): StockMovementType {
    return this.props.movementType;
  }

  public get quantityDelta(): bigint {
    return this.props.quantityDelta;
  }

  public get unitCost(): Money {
    return this.props.unitCost;
  }

  public get resultingQuantity(): bigint {
    return this.props.resultingQuantity;
  }

  public get resultingWac(): Money {
    return this.props.resultingWac;
  }

  public get sourceType(): string {
    return this.props.sourceType;
  }

  public get sourceId(): string {
    return this.props.sourceId;
  }

  public get createdByUserId(): string {
    return this.props.createdByUserId;
  }

  public isIncoming(): boolean {
    return this.props.quantityDelta > 0n;
  }

  public totalCost(): Money {
    const absoluteQuantity = this.props.quantityDelta < 0n ? -this.props.quantityDelta : this.props.quantityDelta;
    return this.props.unitCost.multiply(absoluteQuantity);
  }
}
