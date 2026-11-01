import { InvalidStockOperationError } from '../common/errors.js';
import { Money } from '../money/money.js';

export interface WeightedAverageCostInput {
  /** Quantity on hand before the receipt. May be zero or negative (backorder). */
  currentQuantity: bigint;
  /** Prevailing WAC before the receipt. */
  currentWac: Money;
  /** Quantity being received. Must be strictly positive. */
  incomingQuantity: bigint;
  /** Unit cost paid for the incoming quantity. */
  incomingUnitCost: Money;
}

/**
 * GAAP/IFRS Weighted Average Cost after a receipt.
 *
 * New WAC = (CurrentQty * CurrentWAC + IncomingQty * IncomingCost)
 *           / (CurrentQty + IncomingQty)
 *
 * When the current quantity is zero or negative there is no meaningful weighted
 * history, so the incoming cost replaces the WAC entirely (ADR-004 / ADR-009).
 * Division is rounded Half-Even at the minor-unit boundary.
 */
export function calculateWeightedAverageCost(input: WeightedAverageCostInput): Money {
  if (input.incomingQuantity <= 0n) {
    throw new InvalidStockOperationError('Incoming quantity must be strictly positive');
  }
  if (input.incomingUnitCost.isNegative()) {
    throw new InvalidStockOperationError('Incoming unit cost cannot be negative');
  }
  if (input.currentWac.currency.code !== input.incomingUnitCost.currency.code) {
    throw new InvalidStockOperationError(
      `WAC currency mismatch: inventory is valued in ${input.currentWac.currency.code} but the receipt is in ${input.incomingUnitCost.currency.code}`,
    );
  }

  if (input.currentQuantity <= 0n) {
    return input.incomingUnitCost;
  }

  const totalQuantity = input.currentQuantity + input.incomingQuantity;
  const currentValue = input.currentWac.amount * input.currentQuantity;
  const incomingValue = input.incomingUnitCost.amount * input.incomingQuantity;

  return Money.fromMinor(currentValue + incomingValue, input.currentWac.currency).divideBy(
    totalQuantity,
    'HALF_EVEN',
  );
}
