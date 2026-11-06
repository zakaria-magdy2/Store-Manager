import { Entity } from '../common/entity.base.js';
import { InvalidPaymentError, InvalidSaleError } from '../common/errors.js';
import { Money } from '../money/money.js';
import type { ProductAttributes } from '../catalog/attributes.js';

export const PaymentMethods = {
  CASH: 'CASH',
  CARD: 'CARD',
  MOBILE: 'MOBILE',
  OTHER: 'OTHER',
} as const;

export type PaymentMethod = keyof typeof PaymentMethods;

export const SaleItemTypes = {
  SALE: 'SALE',
  RETURN: 'RETURN',
} as const;

export type SaleItemType = keyof typeof SaleItemTypes;

export const SaleStatuses = {
  COMPLETED: 'COMPLETED',
  REFUNDED: 'REFUNDED',
} as const;

export type SaleStatus = keyof typeof SaleStatuses;

export interface SaleItemProps {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  variantAttributes: ProductAttributes;
  type: SaleItemType;
  quantity: bigint;
  unitPrice: Money;
  lineDiscount: Money;
  cartDiscountShare: Money;
  unitCostSnapshot: Money;
  /** Signed net revenue: positive for a sale, negative for a return. */
  netRevenue: Money;
  /** Signed COGS: positive for a sale, negative for a return. */
  costOfGoodsSold: Money;
}

/**
 * Immutable sale line with the historical cost snapshot captured at checkout.
 *
 * Revenue and COGS are derived inside the entity, so a persisted line can never
 * disagree with its own unit price, discounts and WAC snapshot (ADR-004).
 */
export class SaleItem extends Entity<SaleItemProps> {
  private constructor(id: string, props: SaleItemProps, createdAt?: Date) {
    super(id, props, createdAt, createdAt);
  }

  public static create(params: {
    id: string;
    variantId: string;
    productId: string;
    productName: string;
    sku: string;
    variantAttributes?: ProductAttributes;
    type: SaleItemType;
    quantity: bigint;
    unitPrice: Money;
    lineDiscount: Money;
    cartDiscountShare: Money;
    unitCostSnapshot: Money;
    createdAt?: Date;
  }): SaleItem {
    if (!params.id.trim()) {
      throw new InvalidSaleError('Sale item requires an id');
    }
    if (!params.variantId.trim() || !params.productId.trim()) {
      throw new InvalidSaleError('Sale item requires variantId and productId');
    }
    if (!params.productName.trim() || !params.sku.trim()) {
      throw new InvalidSaleError('Sale item requires a product name and SKU');
    }
    if (!(params.type in SaleItemTypes) || !Object.hasOwn(SaleItemTypes, params.type)) {
      throw new InvalidSaleError(`Unknown sale item type '${String(params.type)}'`);
    }
    if (params.quantity <= 0n) {
      throw new InvalidSaleError('Sale item quantity must be strictly positive');
    }
    if (params.unitPrice.isNegative()) {
      throw new InvalidSaleError('Sale item unit price cannot be negative');
    }
    if (params.unitCostSnapshot.isNegative()) {
      throw new InvalidSaleError('Sale item unit cost snapshot cannot be negative');
    }
    if (params.unitCostSnapshot.currency.code !== params.unitPrice.currency.code) {
      throw new InvalidSaleError('Sale item cost currency must match the selling currency');
    }
    if (params.lineDiscount.currency.code !== params.unitPrice.currency.code) {
      throw new InvalidSaleError('Sale item discount currency must match the selling currency');
    }
    if (params.cartDiscountShare.currency.code !== params.unitPrice.currency.code) {
      throw new InvalidSaleError('Sale item discount currency must match the selling currency');
    }
    if (params.lineDiscount.isNegative() || params.cartDiscountShare.isNegative()) {
      throw new InvalidSaleError('Sale item discounts cannot be negative');
    }

    const gross = params.unitPrice.multiply(params.quantity);
    const discount = params.lineDiscount.add(params.cartDiscountShare);

    if (params.type === 'RETURN') {
      if (!discount.isZero()) {
        throw new InvalidSaleError('Return lines cannot carry a discount');
      }
    } else if (discount.greaterThan(gross)) {
      throw new InvalidSaleError('Sale item discounts cannot exceed the gross amount');
    }

    const direction = params.type === 'SALE' ? 1n : -1n;
    const netRevenue = gross.subtract(discount).multiply(direction);
    const costOfGoodsSold = params.unitCostSnapshot.multiply(params.quantity).multiply(direction);

    return new SaleItem(
      params.id,
      {
        variantId: params.variantId,
        productId: params.productId,
        productName: params.productName,
        sku: params.sku.trim().toUpperCase(),
        variantAttributes: params.variantAttributes ?? {},
        type: params.type,
        quantity: params.quantity,
        unitPrice: params.unitPrice,
        lineDiscount: params.lineDiscount,
        cartDiscountShare: params.cartDiscountShare,
        unitCostSnapshot: params.unitCostSnapshot,
        netRevenue,
        costOfGoodsSold,
      },
      params.createdAt,
    );
  }

  public get variantId(): string {
    return this.props.variantId;
  }

  public get variantAttributes(): ProductAttributes {
    return this.props.variantAttributes;
  }

  public get productId(): string {
    return this.props.productId;
  }

  public get productName(): string {
    return this.props.productName;
  }

  public get sku(): string {
    return this.props.sku;
  }

  public get type(): SaleItemType {
    return this.props.type;
  }

  public get quantity(): bigint {
    return this.props.quantity;
  }

  public get unitPrice(): Money {
    return this.props.unitPrice;
  }

  public get lineDiscount(): Money {
    return this.props.lineDiscount;
  }

  public get cartDiscountShare(): Money {
    return this.props.cartDiscountShare;
  }

  public get unitCostSnapshot(): Money {
    return this.props.unitCostSnapshot;
  }

  public get netRevenue(): Money {
    return this.props.netRevenue;
  }

  public get costOfGoodsSold(): Money {
    return this.props.costOfGoodsSold;
  }

  /** Gross amount before discounts, always positive. */
  public get grossAmount(): Money {
    return this.props.unitPrice.multiply(this.props.quantity);
  }

  /** Signed gross amount: positive for a sale, negative for a return. */
  public get signedGrossAmount(): Money {
    return this.props.type === 'SALE' ? this.grossAmount : this.grossAmount.multiply(-1n);
  }

  public get discountTotal(): Money {
    return this.props.lineDiscount.add(this.props.cartDiscountShare);
  }
}

export interface SalePaymentProps {
  method: PaymentMethod;
  amount: Money;
}

/** One tender applied to a sale. Refund tenders are negative. */
export class SalePayment {
  public constructor(
    public readonly id: string,
    public readonly props: SalePaymentProps,
  ) {
    if (!id.trim()) {
      throw new InvalidPaymentError('Sale payment requires an id');
    }
    if (!Object.hasOwn(PaymentMethods, props.method)) {
      throw new InvalidPaymentError(`Unknown payment method '${props.method}'`);
    }
    if (props.amount.isZero()) {
      throw new InvalidPaymentError('Sale payment amount cannot be zero');
    }
  }

  public get method(): PaymentMethod {
    return this.props.method;
  }

  public get amount(): Money {
    return this.props.amount;
  }
}

export interface SaleProps {
  tenantId: string;
  storeId: string;
  saleNumber: string;
  idempotencyKey: string;
  cashierUserId: string;
  customerName: string | undefined;
  currency: string;
  status: SaleStatus;
  subtotal: Money;
  discountTotal: Money;
  total: Money;
  paidTotal: Money;
  changeGiven: Money;
  items: readonly SaleItem[];
  payments: readonly SalePayment[];
}

export class Sale extends Entity<SaleProps> {
  private constructor(id: string, props: SaleProps, createdAt?: Date) {
    super(id, props, createdAt, createdAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    storeId: string;
    saleNumber: string;
    idempotencyKey: string;
    cashierUserId: string;
    customerName?: string | undefined;
    currency: string;
    items: readonly SaleItem[];
    payments: readonly SalePayment[];
    createdAt?: Date;
  }): Sale {
    if (!params.id.trim()) {
      throw new InvalidSaleError('Sale requires an id');
    }
    if (!params.tenantId.trim() || !params.storeId.trim()) {
      throw new InvalidSaleError('Sale requires a tenantId and a storeId');
    }
    if (!params.saleNumber.trim()) {
      throw new InvalidSaleError('Sale requires a sale number');
    }
    if (!params.idempotencyKey.trim()) {
      throw new InvalidSaleError('Sale requires an idempotency key');
    }
    if (!params.cashierUserId.trim()) {
      throw new InvalidSaleError('Sale requires the cashier user id');
    }
    if (params.items.length === 0) {
      throw new InvalidSaleError('A sale requires at least one item');
    }
    if (params.payments.length === 0) {
      throw new InvalidSaleError('A sale requires at least one payment');
    }

    const currency = params.currency.trim().toUpperCase();
    if (!currency) {
      throw new InvalidSaleError('Sale requires a currency');
    }

    const itemIds = new Set<string>();
    let subtotal = Money.zero(currency);
    let discountTotal = Money.zero(currency);
    for (const item of params.items) {
      if (itemIds.has(item.id)) {
        throw new InvalidSaleError(`Duplicate sale item id '${item.id}'`);
      }
      itemIds.add(item.id);
      if (item.unitPrice.currency.code !== currency) {
        throw new InvalidSaleError(
          `Sale item currency ${item.unitPrice.currency.code} does not match sale currency ${currency}`,
        );
      }
      subtotal = subtotal.add(item.signedGrossAmount);
      discountTotal = discountTotal.add(item.discountTotal);
    }

    let paidTotal = Money.zero(currency);
    for (const payment of params.payments) {
      if (payment.amount.currency.code !== currency) {
        throw new InvalidPaymentError(
          `Payment currency ${payment.amount.currency.code} does not match sale currency ${currency}`,
        );
      }
      paidTotal = paidTotal.add(payment.amount);
    }

    const total = subtotal.subtract(discountTotal);
    for (const payment of params.payments) {
      if (total.isNegative() ? !payment.amount.isNegative() : payment.amount.isNegative()) {
        throw new InvalidPaymentError(
          total.isNegative()
            ? 'Refund payments must be negative amounts'
            : 'Sale payments must be positive amounts',
        );
      }
    }
    let changeGiven = Money.zero(currency);
    if (total.isNegative()) {
      if (!paidTotal.equals(total)) {
        throw new InvalidPaymentError(
          `Refund payments must equal the negative sale total (expected ${total.toDecimalString()}, received ${paidTotal.toDecimalString()})`,
        );
      }
    } else if (paidTotal.lessThan(total)) {
      throw new InvalidPaymentError(
        `Insufficient payment: total is ${total.toDecimalString()} but only ${paidTotal.toDecimalString()} was tendered`,
      );
    } else {
      changeGiven = paidTotal.subtract(total);
      if (!changeGiven.isZero()) {
        const cashTendered = params.payments
          .filter((payment) => payment.method === 'CASH')
          .reduce((sum, payment) => sum.add(payment.amount), Money.zero(currency));
        if (cashTendered.lessThan(changeGiven)) {
          throw new InvalidPaymentError(
            'Change can only be given from cash tender; cash tendered is less than the change due',
          );
        }
      }
    }

    return new Sale(
      params.id,
      {
        tenantId: params.tenantId,
        storeId: params.storeId,
        saleNumber: params.saleNumber.trim(),
        idempotencyKey: params.idempotencyKey.trim(),
        cashierUserId: params.cashierUserId,
        customerName: params.customerName?.trim() || undefined,
        currency,
        status: 'COMPLETED',
        subtotal,
        discountTotal,
        total,
        paidTotal,
        changeGiven,
        items: params.items,
        payments: params.payments,
      },
      params.createdAt,
    );
  }

  public get tenantId(): string {
    return this.props.tenantId;
  }

  public get storeId(): string {
    return this.props.storeId;
  }

  public get saleNumber(): string {
    return this.props.saleNumber;
  }

  public get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }

  public get cashierUserId(): string {
    return this.props.cashierUserId;
  }

  public get customerName(): string | undefined {
    return this.props.customerName;
  }

  public get currency(): string {
    return this.props.currency;
  }

  public get status(): SaleStatus {
    return this.props.status;
  }

  public get subtotal(): Money {
    return this.props.subtotal;
  }

  public get discountTotal(): Money {
    return this.props.discountTotal;
  }

  public get total(): Money {
    return this.props.total;
  }

  public get paidTotal(): Money {
    return this.props.paidTotal;
  }

  public get changeGiven(): Money {
    return this.props.changeGiven;
  }

  public get items(): readonly SaleItem[] {
    return this.props.items;
  }

  public get payments(): readonly SalePayment[] {
    return this.props.payments;
  }

  public get isRefund(): boolean {
    return this.props.total.isNegative();
  }

  /** Signed COGS: positive for a net sale, negative for a net return. */
  public totalCostOfGoodsSold(): Money {
    return this.props.items.reduce(
      (total, item) => total.add(item.costOfGoodsSold),
      Money.zero(this.props.currency),
    );
  }

  /**
   * Signed gross profit for this sale. For a net sale this equals
   * net revenue minus COGS; for a net return both sides are negative.
   */
  public grossProfit(): Money {
    return this.props.total.subtract(this.totalCostOfGoodsSold());
  }
}
