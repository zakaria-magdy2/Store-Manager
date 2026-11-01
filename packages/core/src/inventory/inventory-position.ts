import { InsufficientStockError, InvalidStockOperationError } from '../common/errors.js';
import { Money } from '../money/money.js';
import { calculateWeightedAverageCost } from './wac.js';

export interface InventoryPositionProps {
  variantId: string;
  quantityOnHand: bigint;
  wacCost: Money;
}

/**
 * Immutable stock position for one (store, variant) partition.
 *
 * Inventory is partitioned per store (ADR-005) and valued with WAC (ADR-004).
 * Issuing stock never changes the WAC; the last known cost is retained so a
 * later return or backorder reconciliation uses a deterministic value.
 */
export class InventoryPosition {
  public readonly variantId: string;
  public readonly quantityOnHand: bigint;
  public readonly wacCost: Money;

  private constructor(props: InventoryPositionProps) {
    this.variantId = props.variantId;
    this.quantityOnHand = props.quantityOnHand;
    this.wacCost = props.wacCost;
  }

  public static create(props: InventoryPositionProps): InventoryPosition {
    if (!props.variantId.trim()) {
      throw new InvalidStockOperationError('Inventory position requires a variantId');
    }
    if (props.wacCost.isNegative()) {
      throw new InvalidStockOperationError('WAC cost cannot be negative');
    }
    return new InventoryPosition(props);
  }

  public static empty(variantId: string, currency: string): InventoryPosition {
    return InventoryPosition.create({
      variantId,
      quantityOnHand: 0n,
      wacCost: Money.zero(currency),
    });
  }

  public receive(quantity: bigint, unitCost: Money): InventoryPosition {
    if (quantity <= 0n) {
      throw new InvalidStockOperationError('Received quantity must be strictly positive');
    }
    if (unitCost.currency.code !== this.wacCost.currency.code) {
      throw new InvalidStockOperationError(
        `Receipt currency ${unitCost.currency.code} does not match inventory currency ${this.wacCost.currency.code}`,
      );
    }

    const newWac = calculateWeightedAverageCost({
      currentQuantity: this.quantityOnHand,
      currentWac: this.wacCost,
      incomingQuantity: quantity,
      incomingUnitCost: unitCost,
    });

    return InventoryPosition.create({
      variantId: this.variantId,
      quantityOnHand: this.quantityOnHand + quantity,
      wacCost: newWac,
    });
  }

  public issue(quantity: bigint, allowNegativeStock = false): InventoryPosition {
    if (quantity <= 0n) {
      throw new InvalidStockOperationError('Issued quantity must be strictly positive');
    }
    if (!allowNegativeStock && this.quantityOnHand < quantity) {
      throw new InsufficientStockError(
        this.variantId,
        quantity.toString(),
        this.quantityOnHand.toString(),
      );
    }

    return InventoryPosition.create({
      variantId: this.variantId,
      quantityOnHand: this.quantityOnHand - quantity,
      wacCost: this.wacCost,
    });
  }

  public isOutOfStock(): boolean {
    return this.quantityOnHand <= 0n;
  }

  public isBelowReorderPoint(reorderPoint: bigint): boolean {
    return this.quantityOnHand <= reorderPoint;
  }

  public inventoryValue(): Money {
    return this.wacCost.multiply(this.quantityOnHand);
  }
}
