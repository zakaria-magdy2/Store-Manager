import type { Money, Sale, SaleItemType, SalePayment } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';

/**
 * One line of a checkout draft. Cost and revenue are intentionally absent:
 * the repository computes them inside the same transaction that applies the
 * stock movement, so the COGS snapshot always matches the ledger (ADR-004).
 */
export interface SaleDraftItem {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  variantAttributes?: Readonly<Record<string, string | number | boolean>> | undefined;
  type: SaleItemType;
  quantity: bigint;
  unitPrice: Money;
  lineDiscount: Money;
  cartDiscountShare: Money;
  /** Services are sold without changing stock or recording inventory cost. */
  stockTracked?: boolean | undefined;
}

export interface SaleDraft {
  id: string;
  tenantId: string;
  storeId: string;
  saleNumber: string;
  idempotencyKey: string;
  cashierUserId: string;
  customerName?: string | undefined;
  currency: string;
  items: readonly SaleDraftItem[];
  payments: readonly SalePayment[];
  subtotal: Money;
  discountTotal: Money;
  total: Money;
  createdAt: Date;
}

export interface CheckoutOptions {
  allowNegativeStock: boolean;
}

/**
 * Atomically persists a checkout: stock movements, sale header, sale items and
 * payments either all commit or all roll back. The returned `Sale` carries the
 * real WAC cost snapshot for every line.
 */
export interface CheckoutRepository {
  persistCheckout(
    ctx: ExecutionContext,
    draft: SaleDraft,
    options: CheckoutOptions,
  ): Promise<Sale>;
}

export interface SaleRepository {
  findById(ctx: ExecutionContext, saleId: string): Promise<Sale | null>;
  findByNumber(ctx: ExecutionContext, saleNumber: string): Promise<Sale | null>;
  findByIdempotencyKey(ctx: ExecutionContext, idempotencyKey: string): Promise<Sale | null>;
  listByStore(ctx: ExecutionContext, storeId: string, limit?: number, offset?: number): Promise<Sale[]>;
}
