import { describe, it, expect } from 'vitest';
import {
  Category,
  InventoryPosition,
  Money,
  Product,
  ProductVariant,
  StockMovement,
  Tenant,
  calculateWeightedAverageCost,
  normalizeAttributes,
  parseAttributes,
  serializeAttributes,
} from '../src/index.js';

const USD = 'USD';

function usd(decimal: string): Money {
  return Money.fromDecimal(decimal, USD);
}

describe('Phase 3: Product Catalog Domain', () => {
  it('creates categories with normalized codes and parent links', () => {
    const category = Category.create({
      id: 'cat-1',
      tenantId: 'tenant-1',
      name: ' Beverages ',
      code: 'bev',
      parentId: 'cat-root',
    });

    expect(category.name).toBe('Beverages');
    expect(category.code).toBe('BEV');
    expect(category.parentId).toBe('cat-root');
    expect(category.isActive).toBe(true);

    expect(() =>
      Category.create({ id: 'cat-2', tenantId: 'tenant-1', name: '', code: 'X' }),
    ).toThrow('Category name cannot be empty');
    expect(() =>
      Category.create({
        id: 'cat-2',
        tenantId: 'tenant-1',
        name: 'Self',
        code: 'SELF',
        parentId: 'cat-2',
      }),
    ).toThrow('Category cannot be its own parent');
  });

  it('creates products with normalized SKUs and barcodes', () => {
    const product = Product.create({
      id: 'p-1',
      tenantId: 'tenant-1',
      name: 'Cola',
      sku: ' cola-330 ',
      barcode: ' 123456 ',
      hasVariants: true,
    });

    expect(product.sku).toBe('COLA-330');
    expect(product.barcode).toBe('123456');
    expect(product.hasVariants).toBe(true);
  });

  it('creates variants with dynamic JSON attributes and exact pricing', () => {
    const variant = ProductVariant.create({
      id: 'v-1',
      tenantId: 'tenant-1',
      productId: 'p-1',
      sku: 'cola-330-red',
      barcode: '999',
      attributes: { size: '330ml', color: 'red', chilled: true, weight: 0.33 },
      retailPrice: usd('1.25'),
      reorderPoint: 5n,
    });

    expect(variant.sku).toBe('COLA-330-RED');
    expect(variant.retailPrice.amount).toBe(125n);
    expect(variant.reorderPoint).toBe(5n);
    expect(variant.attributes.color).toBe('red');

    const roundTripped = parseAttributes(serializeAttributes(variant.attributes));
    expect(roundTripped).toEqual(variant.attributes);

    expect(() =>
      ProductVariant.create({
        id: 'v-2',
        tenantId: 'tenant-1',
        productId: 'p-1',
        sku: 'bad',
        retailPrice: usd('-1.00'),
      }),
    ).toThrow('Variant retail price cannot be negative');
  });

  it('rejects unsafe attribute keys and non-finite numbers', () => {
    expect(() => normalizeAttributes({ 'bad key': 'x' })).toThrow('Invalid attribute key');
    expect(() => normalizeAttributes({ size: Number.POSITIVE_INFINITY })).toThrow(
      'must be a finite number',
    );
    expect(parseAttributes('{"size":"M"}').size).toBe('M');
  });
});

describe('Phase 3: Weighted Average Cost (WAC)', () => {
  it('computes the weighted average exactly across receipts', () => {
    const wac = calculateWeightedAverageCost({
      currentQuantity: 10n,
      currentWac: usd('5.00'),
      incomingQuantity: 5n,
      incomingUnitCost: usd('8.00'),
    });

    // (10 * 500 + 5 * 800) / 15 = 600 cents
    expect(wac.amount).toBe(600n);
    expect(wac.toDecimalString()).toBe('6.00');
  });

  it('replaces WAC entirely when current quantity is zero or negative', () => {
    const zero = calculateWeightedAverageCost({
      currentQuantity: 0n,
      currentWac: usd('1.00'),
      incomingQuantity: 4n,
      incomingUnitCost: usd('9.99'),
    });
    expect(zero.amount).toBe(999n);

    const negative = calculateWeightedAverageCost({
      currentQuantity: -3n,
      currentWac: usd('1.00'),
      incomingQuantity: 3n,
      incomingUnitCost: usd('7.00'),
    });
    expect(negative.amount).toBe(700n);
  });

  it('rounds fractional minor units with Half-Even', () => {
    const wac = calculateWeightedAverageCost({
      currentQuantity: 3n,
      currentWac: usd('0.01'), // 3 cents
      incomingQuantity: 1n,
      incomingUnitCost: usd('0.07'), // 7 cents
    });

    // 10 / 4 = 2.5 minor units -> 2 (even)
    expect(wac.amount).toBe(2n);
  });

  it('rejects zero incoming quantity, negative cost and currency mismatch', () => {
    expect(() =>
      calculateWeightedAverageCost({
        currentQuantity: 1n,
        currentWac: usd('1.00'),
        incomingQuantity: 0n,
        incomingUnitCost: usd('1.00'),
      }),
    ).toThrow('Incoming quantity must be strictly positive');

    expect(() =>
      calculateWeightedAverageCost({
        currentQuantity: 1n,
        currentWac: usd('1.00'),
        incomingQuantity: 1n,
        incomingUnitCost: Money.fromDecimal('1.00', 'EGP'),
      }),
    ).toThrow('WAC currency mismatch');
  });
});

describe('Phase 3: Inventory Position & Immutable Movements', () => {
  it('receives and issues stock while preserving WAC on issue', () => {
    const empty = InventoryPosition.empty('v-1', USD);
    expect(empty.quantityOnHand).toBe(0n);

    const afterReceipt = empty.receive(10n, usd('5.00'));
    expect(afterReceipt.quantityOnHand).toBe(10n);
    expect(afterReceipt.wacCost.amount).toBe(500n);

    const afterIssue = afterReceipt.issue(3n);
    expect(afterIssue.quantityOnHand).toBe(7n);
    expect(afterIssue.wacCost.amount).toBe(500n);
    expect(afterIssue.inventoryValue().amount).toBe(3500n);
  });

  it('blocks overselling unless the tenant opted into negative stock', () => {
    const position = InventoryPosition.create({
      variantId: 'v-1',
      quantityOnHand: 2n,
      wacCost: usd('5.00'),
    });

    expect(() => position.issue(3n)).toThrow('Insufficient stock');
    const backorder = position.issue(3n, true);
    expect(backorder.quantityOnHand).toBe(-1n);
    expect(backorder.isOutOfStock()).toBe(true);
  });

  it('creates immutable stock movements with a WAC snapshot', () => {
    const movement = StockMovement.create({
      id: 'm-1',
      tenantId: 't-1',
      storeId: 's-1',
      variantId: 'v-1',
      movementType: 'SALE',
      quantityDelta: -2n,
      unitCost: usd('6.00'),
      resultingQuantity: 8n,
      resultingWac: usd('6.00'),
      sourceType: 'SALE',
      sourceId: 'sale-1',
      createdByUserId: 'u-1',
    });

    expect(movement.isIncoming()).toBe(false);
    expect(movement.totalCost().amount).toBe(1200n);
    expect(() =>
      StockMovement.create({
        id: 'm-2',
        tenantId: 't-1',
        storeId: 's-1',
        variantId: 'v-1',
        movementType: 'SALE',
        quantityDelta: 0n,
        unitCost: usd('1.00'),
        resultingQuantity: 0n,
        resultingWac: usd('1.00'),
        sourceType: 'SALE',
        sourceId: 'sale-1',
        createdByUserId: 'u-1',
      }),
    ).toThrow('quantity delta cannot be zero');
  });
});

describe('Phase 3: Money Boundary Improvements', () => {
  it('rounds excess decimal digits with Half-Even instead of truncating', () => {
    expect(Money.fromDecimal('1.999', USD).amount).toBe(200n);
    expect(Money.fromDecimal('1.994', USD).amount).toBe(199n);
    // 1.005 -> 1.00 (even) under Banker's Rounding
    expect(Money.fromDecimal('1.005', USD).amount).toBe(100n);
    expect(Money.fromDecimal('1.015', USD).amount).toBe(102n);
  });

  it('divides minor units with Half-Even rounding', () => {
    expect(usd('10.00').divideBy(4n).amount).toBe(250n);
    expect(Money.fromMinor(5n, USD).divideBy(2n).amount).toBe(2n);
    expect(Money.fromMinor(7n, USD).divideBy(2n).amount).toBe(4n);
    expect(() => usd('1.00').divideBy(0n)).toThrow('Cannot divide');
  });
});

describe('Phase 3: Tenant Negative-Stock Policy', () => {
  it('defaults to strict prohibition and can be toggled explicitly', () => {
    const tenant = Tenant.create({
      id: 't-1',
      name: 'Tenant',
      code: 'T1',
      currency: 'USD',
    });

    expect(tenant.allowNegativeStock).toBe(false);
    tenant.setNegativeStockPolicy(true);
    expect(tenant.allowNegativeStock).toBe(true);
  });
});
