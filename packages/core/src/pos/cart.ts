import { InvalidCartError } from '../common/errors.js';
import { distributeDiscount } from '../money/allocation.js';
import { Money } from '../money/money.js';

export const CartLineTypes = {
  SALE: 'SALE',
  RETURN: 'RETURN',
} as const;

export type CartLineType = keyof typeof CartLineTypes;

/**
 * One immutable cart line.
 *
 * A line is identified by `lineId`, not by variant, so the same variant may be
 * sold at different unit prices in one cart (for example a manual price override)
 * without silently merging unrelated lines.
 */
export interface CartLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly sku: string;
  readonly type: CartLineType;
  readonly unitPrice: Money;
  readonly quantity: bigint;
  readonly lineDiscount: Money;
}

export interface AddCartItemParams {
  lineId: string;
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  type?: CartLineType | undefined;
  unitPrice: Money;
  quantity: bigint;
}

/**
 * Immutable Point-of-Sale cart.
 *
 * The cart only performs exact integer arithmetic through the `Money` value
 * object. Whole-cart discounts are redistributed across eligible sale lines with
 * Hamilton-Hare (largest remainder), so the allocated shares always sum exactly
 * to the requested discount (ADR-003). Return lines are never discount-eligible.
 */
export class Cart {
  private constructor(
    public readonly currencyCode: string,
    private readonly _lines: readonly CartLine[],
    private readonly _cartDiscount: Money,
  ) {}

  public static empty(currencyCode: string): Cart {
    const normalized = currencyCode.trim().toUpperCase();
    if (!normalized) {
      throw new InvalidCartError('Cart requires a currency code');
    }
    return new Cart(normalized, [], Money.zero(normalized));
  }

  public get lines(): readonly CartLine[] {
    return this._lines;
  }

  public get cartDiscount(): Money {
    return this._cartDiscount;
  }

  public get isEmpty(): boolean {
    return this._lines.length === 0;
  }

  public addItem(params: AddCartItemParams): Cart {
    this.assertText(params.lineId, 'lineId');
    this.assertText(params.variantId, 'variantId');
    this.assertText(params.productId, 'productId');
    this.assertText(params.productName, 'productName');
    this.assertText(params.sku, 'sku');

    if (params.quantity <= 0n) {
      throw new InvalidCartError('Cart line quantity must be strictly positive');
    }
    if (params.unitPrice.isNegative()) {
      throw new InvalidCartError('Cart line unit price cannot be negative');
    }
    this.assertCurrency(params.unitPrice);
    if (this._lines.some((line) => line.lineId === params.lineId)) {
      throw new InvalidCartError(`Cart line '${params.lineId}' already exists`);
    }

    const line: CartLine = {
      lineId: params.lineId,
      variantId: params.variantId,
      productId: params.productId,
      productName: params.productName,
      sku: params.sku.trim().toUpperCase(),
      type: params.type ?? 'SALE',
      unitPrice: params.unitPrice,
      quantity: params.quantity,
      lineDiscount: Money.zero(this.currencyCode),
    };

    return new Cart(this.currencyCode, [...this._lines, line], this._cartDiscount);
  }

  public setQuantity(lineId: string, quantity: bigint): Cart {
    if (quantity < 0n) {
      throw new InvalidCartError('Cart line quantity cannot be negative');
    }
    const line = this.requireLine(lineId);

    if (quantity === 0n) {
      return this.removeLine(lineId);
    }

    const gross = line.unitPrice.multiply(quantity);
    if (line.lineDiscount.greaterThan(gross)) {
      throw new InvalidCartError(
        `Line discount exceeds the new gross amount for line '${lineId}'`,
      );
    }

    const nextLines = this._lines.map((current) =>
      current.lineId === lineId ? { ...current, quantity } : current,
    );
    const next = new Cart(this.currencyCode, nextLines, this._cartDiscount);
    next.assertCartDiscountWithinBase();
    return next;
  }

  public removeLine(lineId: string): Cart {
    this.requireLine(lineId);
    const next = new Cart(
      this.currencyCode,
      this._lines.filter((line) => line.lineId !== lineId),
      this._cartDiscount,
    );
    next.assertCartDiscountWithinBase();
    return next;
  }

  public setLineDiscount(lineId: string, discount: Money): Cart {
    this.assertCurrency(discount);
    if (discount.isNegative()) {
      throw new InvalidCartError('Line discount cannot be negative');
    }

    const line = this.requireLine(lineId);
    if (line.type === 'RETURN') {
      throw new InvalidCartError('Return lines cannot carry a discount');
    }
    if (discount.greaterThan(line.unitPrice.multiply(line.quantity))) {
      throw new InvalidCartError('Line discount cannot exceed the line gross amount');
    }

    const nextLines = this._lines.map((current) =>
      current.lineId === lineId ? { ...current, lineDiscount: discount } : current,
    );
    const next = new Cart(this.currencyCode, nextLines, this._cartDiscount);
    next.assertCartDiscountWithinBase();
    return next;
  }

  public setCartDiscount(discount: Money): Cart {
    this.assertCurrency(discount);
    if (discount.isNegative()) {
      throw new InvalidCartError('Cart discount cannot be negative');
    }
    const base = this.discountBase;
    if (discount.greaterThan(base)) {
      throw new InvalidCartError('Cart discount cannot exceed the discountable sale amount');
    }
    return new Cart(this.currencyCode, this._lines, discount);
  }

  public clear(): Cart {
    return Cart.empty(this.currencyCode);
  }

  /** Gross sale revenue before any discount (returns are excluded). */
  public get saleSubtotal(): Money {
    return this.sum(this.saleLines().map((line) => line.unitPrice.multiply(line.quantity)));
  }

  /** Gross value of returned units, expressed as a positive magnitude. */
  public get returnSubtotal(): Money {
    return this.sum(
      this.returnLines().map((line) => line.unitPrice.multiply(line.quantity)),
    );
  }

  /** Signed subtotal: sale revenue minus returns. */
  public get grossSubtotal(): Money {
    return this.saleSubtotal.subtract(this.returnSubtotal);
  }

  public get lineDiscountTotal(): Money {
    return this.sum(this.saleLines().map((line) => line.lineDiscount));
  }

  public get discountBase(): Money {
    return this.saleSubtotal.subtract(this.lineDiscountTotal);
  }

  public get discountTotal(): Money {
    return this.lineDiscountTotal.add(this._cartDiscount);
  }

  /** Signed amount payable. A pure return produces a negative total. */
  public get total(): Money {
    return this.grossSubtotal.subtract(this.discountTotal);
  }

  public get itemCount(): number {
    return this._lines.length;
  }

  public get unitCount(): bigint {
    return this._lines.reduce((sum, line) => sum + line.quantity, 0n);
  }

  /**
   * Whole-cart discount allocated to each line. Return lines receive zero.
   * The shares always sum exactly to `cartDiscount`.
   */
  public get allocatedCartDiscounts(): ReadonlyMap<string, Money> {
    const eligible = this.saleLines();
    const shares = distributeDiscount(
      this._cartDiscount,
      eligible.map((line) => line.unitPrice.multiply(line.quantity).subtract(line.lineDiscount)),
    );

    const allocation = new Map<string, Money>();
    for (const line of this._lines) {
      allocation.set(line.lineId, Money.zero(this.currencyCode));
    }
    eligible.forEach((line, index) => {
      const share = shares[index];
      if (share) {
        allocation.set(line.lineId, share);
      }
    });
    return allocation;
  }

  public cartDiscountShare(lineId: string): Money {
    this.requireLine(lineId);
    return this.allocatedCartDiscounts.get(lineId) ?? Money.zero(this.currencyCode);
  }

  /** Signed net revenue for one line, after line and allocated cart discounts. */
  public lineNetRevenue(lineId: string): Money {
    const line = this.requireLine(lineId);
    const gross = line.unitPrice.multiply(line.quantity).subtract(line.lineDiscount);
    const net = gross.subtract(this.cartDiscountShare(lineId));
    return line.type === 'SALE' ? net : net.multiply(-1n);
  }

  private saleLines(): readonly CartLine[] {
    return this._lines.filter((line) => line.type === 'SALE');
  }

  private returnLines(): readonly CartLine[] {
    return this._lines.filter((line) => line.type === 'RETURN');
  }

  private sum(amounts: readonly Money[]): Money {
    return amounts.reduce(
      (total, amount) => total.add(amount),
      Money.zero(this.currencyCode),
    );
  }

  private requireLine(lineId: string): CartLine {
    const line = this._lines.find((candidate) => candidate.lineId === lineId);
    if (!line) {
      throw new InvalidCartError(`Cart line '${lineId}' does not exist`);
    }
    return line;
  }

  private assertCartDiscountWithinBase(): void {
    if (this._cartDiscount.greaterThan(this.discountBase)) {
      throw new InvalidCartError(
        'Cart discount exceeds the discountable sale amount after line changes',
      );
    }
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency.code !== this.currencyCode) {
      throw new InvalidCartError(
        `Cart currency ${this.currencyCode} does not match amount currency ${amount.currency.code}`,
      );
    }
  }

  private assertText(value: string, field: string): void {
    if (!value.trim()) {
      throw new InvalidCartError(`Cart line requires a non-empty ${field}`);
    }
  }
}
