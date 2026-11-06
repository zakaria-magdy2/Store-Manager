import {
  InvalidCartError,
  InvalidPaymentError,
  InvalidSaleError,
  Money,
  Permissions,
  SalePayment,
} from '@retailos/core';
import type { Cart, PaymentMethod, Sale } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';
import type { StoreRepository, TenantRepository } from '../ports/identity-repositories.interface.js';
import type {
  ProductRepository,
  ProductVariantRepository,
} from '../ports/catalog-repositories.interface.js';
import type {
  CheckoutRepository,
  SaleDraft,
  SaleDraftItem,
  SaleRepository,
} from '../ports/pos-repositories.interface.js';

export interface CheckoutPaymentInput {
  method: PaymentMethod;
  /** Amount tendered. Cash overpayment produces change. */
  amount: Money;
}

export interface CheckoutParams {
  saleId: string;
  saleNumber: string;
  storeId: string;
  cart: Cart;
  payments: readonly CheckoutPaymentInput[];
  idempotencyKey: string;
  customerName?: string | undefined;
  occurredAt?: Date | undefined;
}

/**
 * Fast POS checkout orchestration (Phase 4).
 *
 * The service is responsible for authorization, store scoping, catalog and price
 * validation. Persistence is delegated to `CheckoutRepository`, which applies the
 * stock movements and writes the sale in one database transaction, so a failed
 * line can never leave partial inventory or financial state behind.
 *
 * Double-entry journal posting is intentionally deferred to Phase 5, which owns
 * the chart of accounts and the accounting engine.
 */
export class CheckoutService {
  constructor(
    private readonly checkoutRepo: CheckoutRepository,
    private readonly saleRepo: SaleRepository,
    private readonly variantRepo: ProductVariantRepository,
    private readonly productRepo: ProductRepository,
    private readonly storeRepo: StoreRepository,
    private readonly tenantRepo: TenantRepository,
  ) {}

  public async checkout(ctx: ExecutionContext, params: CheckoutParams): Promise<Sale> {
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    this.assertStoreAccess(ctx, params.storeId);

    if (params.cart.isEmpty) {
      throw new InvalidCartError('Cannot check out an empty cart');
    }
    if (params.cart.lines.some((line) => line.type === 'RETURN')) {
      throw new InvalidCartError(
        'Returns require an original sale reference and are not available in checkout yet',
      );
    }
    if (params.payments.length === 0) {
      throw new InvalidPaymentError('A checkout requires at least one payment');
    }
    if (!params.saleNumber.trim()) {
      throw new InvalidSaleError('A checkout requires a sale number');
    }
    if (!params.idempotencyKey.trim()) {
      throw new InvalidSaleError('A checkout requires an idempotency key');
    }

    const store = await this.storeRepo.findById(ctx, params.storeId);
    if (!store) {
      throw new InvalidSaleError(`Store '${params.storeId}' does not exist in this tenant`);
    }

    const existing = await this.saleRepo.findByIdempotencyKey(ctx, params.idempotencyKey);
    if (existing) {
      if (
        existing.storeId !== params.storeId ||
        !matchesCheckoutRequest(existing, params, ctx.userId)
      ) {
        throw new InvalidSaleError(
          `Idempotency key '${params.idempotencyKey}' was already used for a different checkout`,
        );
      }
      return existing;
    }

    const currency = params.cart.currencyCode;
    const discountAllocation = params.cart.allocatedCartDiscounts;

    const items: SaleDraftItem[] = [];
    let index = 0;
    for (const line of params.cart.lines) {
      const variant = await this.variantRepo.findById(ctx, line.variantId);
      if (!variant) {
        throw new InvalidCartError(`Variant '${line.variantId}' was not found in this tenant`);
      }
      if (!variant.isActive) {
        throw new InvalidCartError(`Variant '${line.variantId}' is inactive`);
      }
      if (variant.productId !== line.productId) {
        throw new InvalidCartError(
          `Variant '${line.variantId}' does not belong to product '${line.productId}'`,
        );
      }
      const product = await this.productRepo.findById(ctx, variant.productId);
      if (!product || !product.isActive) {
        throw new InvalidCartError(`Product '${variant.productId}' is unavailable`);
      }
      if (variant.retailPrice.currency.code !== currency) {
        throw new InvalidCartError(
          `Variant '${line.variantId}' is priced in ${variant.retailPrice.currency.code}, not ${currency}`,
        );
      }
      if (!variant.retailPrice.equals(line.unitPrice)) {
        throw new InvalidCartError(
          `Unit price for variant '${line.variantId}' changed; rescan the item`,
        );
      }

      const optionLabel = Object.entries(variant.attributes).map(([key, value]) => `${product.options.find((option) => option.key === key)?.name ?? key}: ${String(value)}`).join(' · ');
      items.push({
        id: `${params.saleId}:item:${index}`,
        variantId: line.variantId,
        productId: line.productId,
        productName: optionLabel ? `${product.name} · ${optionLabel}` : product.name,
        sku: variant.sku,
        variantAttributes: variant.attributes,
        type: line.type,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineDiscount: line.lineDiscount,
        cartDiscountShare: discountAllocation.get(line.lineId) ?? Money.zero(currency),
        stockTracked: product.itemKind === 'PRODUCT',
      });
      index += 1;
    }

    const payments = params.payments.map((payment, paymentIndex) => {
      if (payment.amount.currency.code !== currency) {
        throw new InvalidPaymentError(
          `Payment currency ${payment.amount.currency.code} does not match cart currency ${currency}`,
        );
      }
      return new SalePayment(`${params.saleId}:payment:${paymentIndex}`, {
        method: payment.method,
        amount: payment.amount,
      });
    });

    const draft: SaleDraft = {
      id: params.saleId,
      tenantId: ctx.tenantId,
      storeId: params.storeId,
      saleNumber: params.saleNumber,
      idempotencyKey: params.idempotencyKey,
      cashierUserId: ctx.userId,
      customerName: params.customerName,
      currency,
      items,
      payments,
      subtotal: params.cart.grossSubtotal,
      discountTotal: params.cart.discountTotal,
      total: params.cart.total,
      createdAt: params.occurredAt ?? new Date(),
    };

    const tenant = await this.tenantRepo.findById(ctx.tenantId);
    const sale = await this.checkoutRepo.persistCheckout(ctx, draft, {
      allowNegativeStock: tenant?.allowNegativeStock ?? false,
    });

    if (!sale.total.equals(params.cart.total)) {
      throw new InvalidSaleError(
        `Persisted sale total ${sale.total.toDecimalString()} does not match cart total ${params.cart.total.toDecimalString()}`,
      );
    }

    return sale;
  }

  /** Reloads a sale, for receipt reprints and receipt lookup. */
  public async getSale(ctx: ExecutionContext, saleId: string): Promise<Sale | null> {
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    const sale = await this.saleRepo.findById(ctx, saleId);
    if (!sale) {
      return null;
    }
    this.assertStoreAccess(ctx, sale.storeId);
    return sale;
  }

  private assertStoreAccess(ctx: ExecutionContext, storeId: string): void {
    if (ctx.storeId !== undefined && ctx.storeId !== storeId) {
      throw new Error(
        `UnauthorizedError: User ${ctx.userId} cannot operate on store '${storeId}'`,
      );
    }
  }
}

function matchesCheckoutRequest(
  sale: Sale,
  params: CheckoutParams,
  cashierUserId: string,
): boolean {
  const cart = params.cart;
  const allocation = cart.allocatedCartDiscounts;
  if (
    sale.saleNumber !== params.saleNumber.trim() ||
    sale.cashierUserId !== cashierUserId ||
    sale.customerName !== (params.customerName?.trim() || undefined) ||
    sale.currency !== cart.currencyCode ||
    !sale.subtotal.equals(cart.grossSubtotal) ||
    !sale.discountTotal.equals(cart.discountTotal) ||
    !sale.total.equals(cart.total) ||
    sale.items.length !== cart.lines.length ||
    sale.payments.length !== params.payments.length
  ) {
    return false;
  }

  for (const [index, line] of cart.lines.entries()) {
    const item = sale.items[index];
    const cartDiscountShare = allocation.get(line.lineId);
    if (
      !item ||
      !cartDiscountShare ||
      item.variantId !== line.variantId ||
      item.productId !== line.productId ||
      item.type !== line.type ||
      item.quantity !== line.quantity ||
      !item.unitPrice.equals(line.unitPrice) ||
      !item.lineDiscount.equals(line.lineDiscount) ||
      !item.cartDiscountShare.equals(cartDiscountShare)
    ) {
      return false;
    }
  }

  return params.payments.every((payment, index) => {
    const stored = sale.payments[index];
    return !!stored && stored.method === payment.method && stored.amount.equals(payment.amount);
  });
}
