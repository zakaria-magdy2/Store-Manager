import { describe, expect, it } from 'vitest';
import {
  Cart,
  InvalidCartError,
  InvalidPaymentError,
  Money,
  Sale,
  SaleItem,
  SalePayment,
} from '../src/index.js';

function usd(decimal: string): Money {
  return Money.fromDecimal(decimal, 'USD');
}

describe('POS cart and sale rules', () => {
  it('allocates cart discounts exactly and preserves the discount invariant', () => {
    const cart = Cart.empty('USD')
      .addItem({
        lineId: 'line-1',
        variantId: 'variant-1',
        productId: 'product-1',
        productName: 'Coffee',
        sku: 'COF-1',
        unitPrice: usd('1.00'),
        quantity: 1n,
      })
      .addItem({
        lineId: 'line-2',
        variantId: 'variant-2',
        productId: 'product-2',
        productName: 'Tea',
        sku: 'TEA-1',
        unitPrice: usd('2.00'),
        quantity: 1n,
      })
      .setCartDiscount(usd('1.50'));

    expect(
      cart.cartDiscountShare('line-1').add(cart.cartDiscountShare('line-2')).amount,
    ).toBe(150n);
    expect(() => cart.removeLine('line-2')).toThrow(InvalidCartError);
    expect(cart.clear().isEmpty).toBe(true);
  });

  it('only allows cash-funded change and consistent payment signs', () => {
    const item = SaleItem.create({
      id: 'item-1',
      variantId: 'variant-1',
      productId: 'product-1',
      productName: 'Coffee',
      sku: 'COF-1',
      type: 'SALE',
      quantity: 1n,
      unitPrice: usd('10.00'),
      lineDiscount: usd('0.00'),
      cartDiscountShare: usd('0.00'),
      unitCostSnapshot: usd('4.00'),
    });
    const createSale = (payments: SalePayment[]) =>
      Sale.create({
        id: 'sale-1',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        saleNumber: 'R-1',
        idempotencyKey: 'key-1',
        cashierUserId: 'cashier-1',
        currency: 'USD',
        items: [item],
        payments,
      });

    expect(() =>
      createSale([
        new SalePayment('pay-1', { method: 'CASH', amount: usd('4.00') }),
        new SalePayment('pay-2', { method: 'CARD', amount: usd('11.00') }),
      ]),
    ).toThrow(InvalidPaymentError);
    expect(() =>
      createSale([
        new SalePayment('pay-3', { method: 'CASH', amount: usd('-1.00') }),
        new SalePayment('pay-4', { method: 'CARD', amount: usd('11.00') }),
      ]),
    ).toThrow(InvalidPaymentError);
    expect(
      createSale([new SalePayment('pay-5', { method: 'CASH', amount: usd('12.00') })])
        .changeGiven.amount,
    ).toBe(200n);
  });
});
