import { describe, expect, it } from 'vitest';
import { Cart, Money, Product, ProductVariant, Sale, SaleItem, Store, Tenant } from '@retailos/core';
import { CheckoutService, ScopedExecutionContext } from '../src/index.js';
import type {
  CheckoutRepository,
  SaleDraft,
  SaleRepository,
} from '../src/ports/pos-repositories.interface.js';
import type {
  ProductRepository,
  ProductVariantRepository,
} from '../src/ports/catalog-repositories.interface.js';
import type {
  StoreRepository,
  TenantRepository,
} from '../src/ports/identity-repositories.interface.js';

function usd(value: string): Money {
  return Money.fromDecimal(value, 'USD');
}

describe('CheckoutService', () => {
  it('uses catalog snapshots and sends a validated draft to the checkout port', async () => {
    const ctx = new ScopedExecutionContext({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      userId: 'cashier-1',
      roleId: 'CASHIER',
      permissions: new Set(['*']),
      correlationId: 'checkout-unit-test',
    });
    const product = Product.create({
      id: 'product-1',
      tenantId: ctx.tenantId,
      name: 'Catalog Name',
      sku: 'PRODUCT',
    });
    const variant = ProductVariant.create({
      id: 'variant-1',
      tenantId: ctx.tenantId,
      productId: product.id,
      sku: 'CATALOG-SKU',
      retailPrice: usd('5.00'),
    });
    const store = Store.create({
      id: 'store-1',
      tenantId: ctx.tenantId,
      name: 'Main Store',
      code: 'MAIN',
    });
    const tenant = Tenant.create({
      id: ctx.tenantId,
      name: 'Tenant',
      code: 'TEN',
      currency: 'USD',
    });

    let capturedDraft: SaleDraft | undefined;
    const checkoutRepo: CheckoutRepository = {
      persistCheckout: (_context, draft) => {
        capturedDraft = draft;
        const items = draft.items.map((item) =>
          SaleItem.create({ ...item, unitCostSnapshot: usd('2.00') }),
        );
        return Promise.resolve(Sale.create({
          id: draft.id,
          tenantId: draft.tenantId,
          storeId: draft.storeId,
          saleNumber: draft.saleNumber,
          idempotencyKey: draft.idempotencyKey,
          cashierUserId: draft.cashierUserId,
          customerName: draft.customerName,
          currency: draft.currency,
          items,
          payments: draft.payments,
          createdAt: draft.createdAt,
        }));
      },
    };
    const saleRepo: SaleRepository = {
      findByIdempotencyKey: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      findByNumber: () => Promise.resolve(null),
      listByStore: () => Promise.resolve([]),
    };
    const variantRepo: ProductVariantRepository = {
      findById: () => Promise.resolve(variant),
      findBySku: () => Promise.resolve(null),
      findByBarcode: () => Promise.resolve(null),
      listByProduct: () => Promise.resolve([variant]),
      save: () => Promise.resolve(),
    };
    const productRepo: ProductRepository = {
      findById: () => Promise.resolve(product),
      findBySku: () => Promise.resolve(null),
      listByTenant: () => Promise.resolve([product]),
      save: () => Promise.resolve(),
      saveWithVariants: () => Promise.resolve(),
    };
    const storeRepo: StoreRepository = {
      findById: () => Promise.resolve(store),
      findByCode: () => Promise.resolve(store),
      listByTenant: () => Promise.resolve([store]),
      save: () => Promise.resolve(),
    };
    const tenantRepo: TenantRepository = {
      findById: () => Promise.resolve(tenant),
      findByCode: () => Promise.resolve(tenant),
      listAll: () => Promise.resolve([tenant]),
      save: () => Promise.resolve(),
    };

    const service = new CheckoutService(
      checkoutRepo,
      saleRepo,
      variantRepo,
      productRepo,
      storeRepo,
      tenantRepo,
    );
    const sale = await service.checkout(ctx, {
      saleId: 'sale-1',
      saleNumber: 'POS-1',
      storeId: store.id,
      idempotencyKey: 'key-1',
      cart: Cart.empty('USD').addItem({
        lineId: 'line-1',
        variantId: variant.id,
        productId: product.id,
        productName: 'Untrusted Name',
        sku: 'UNTRUSTED-SKU',
        unitPrice: usd('5.00'),
        quantity: 1n,
      }),
      payments: [{ method: 'CASH', amount: usd('5.00') }],
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(capturedDraft?.items[0]?.productName).toBe('Catalog Name');
    expect(capturedDraft?.items[0]?.sku).toBe('CATALOG-SKU');
    expect(sale.total.amount).toBe(500n);
  });
});
