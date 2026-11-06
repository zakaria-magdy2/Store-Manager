import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogService,
  CashDrawerService,
  CheckoutService,
  InventoryService,
  ScopedExecutionContext,
} from '@retailos/application';
import { Cart, Money, Store, Tenant } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';
import { SqliteTenantRepository } from '../src/database/repositories/sqlite-tenant.repository.js';
import { SqliteStoreRepository } from '../src/database/repositories/sqlite-store.repository.js';
import { SqliteCategoryRepository } from '../src/database/repositories/sqlite-category.repository.js';
import { SqliteProductRepository } from '../src/database/repositories/sqlite-product.repository.js';
import { SqliteProductVariantRepository } from '../src/database/repositories/sqlite-product-variant.repository.js';
import { SqliteInventoryRepository } from '../src/database/repositories/sqlite-inventory.repository.js';
import { SqliteStockMovementRepository } from '../src/database/repositories/sqlite-stock-movement.repository.js';
import { SqliteSaleRepository } from '../src/database/repositories/sqlite-sale.repository.js';
import {
  BarcodeScannerListener,
  EscPosPrinterDevice,
  EscPosReceiptPrinter,
} from '../src/hardware/index.js';

const TENANT_ID = 'pos-tenant';
const STORE_ID = 'pos-store';
const VARIANT_ID = 'pos-variant';

function usd(value: string): Money {
  return Money.fromDecimal(value, 'USD');
}

describe('POS checkout and peripherals', () => {
  let dbManager: SqliteDatabaseManager;
  let tenantRepo: SqliteTenantRepository;
  let storeRepo: SqliteStoreRepository;
  let productRepo: SqliteProductRepository;
  let variantRepo: SqliteProductVariantRepository;
  let inventoryRepo: SqliteInventoryRepository;
  let saleRepo: SqliteSaleRepository;
  let checkoutService: CheckoutService;
  let inventoryService: InventoryService;
  let ctx: ScopedExecutionContext;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    const migration = await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    expect(migration.success).toBe(true);
    expect(migration.executedMigrations).toContain('005_pos_checkout_ordering');

    const db = dbManager.getDb();
    tenantRepo = new SqliteTenantRepository(db);
    storeRepo = new SqliteStoreRepository(db);
    const categoryRepo = new SqliteCategoryRepository(db);
    productRepo = new SqliteProductRepository(db);
    variantRepo = new SqliteProductVariantRepository(db);
    inventoryRepo = new SqliteInventoryRepository(db);
    const movementRepo = new SqliteStockMovementRepository(db);
    saleRepo = new SqliteSaleRepository(db);

    const tenant = Tenant.create({
      id: TENANT_ID,
      name: 'POS Tenant',
      code: 'POST',
      currency: 'USD',
    });
    await tenantRepo.save(tenant);
    ctx = new ScopedExecutionContext({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      userId: 'cashier-1',
      roleId: 'CASHIER',
      permissions: new Set(['*']),
      correlationId: 'pos-checkout-test',
    });
    await storeRepo.save(
      ctx,
      Store.create({ id: STORE_ID, tenantId: TENANT_ID, name: 'Main Store', code: 'MAIN' }),
    );
    await db.insertInto('users').values({
      id: 'cashier-1', tenant_id: TENANT_ID, store_id: STORE_ID,
      username: 'cashier', password_hash: 'test-hash', full_name: 'Cashier', role: 'CASHIER',
    }).execute();

    const catalogService = new CatalogService(
      categoryRepo,
      productRepo,
      variantRepo,
    );
    await catalogService.createProduct(ctx, {
      id: 'pos-product',
      name: 'Coffee',
      sku: 'COFFEE',
      variants: [
        { id: VARIANT_ID, sku: 'COF-1', retailPrice: usd('12.50') },
      ],
    });
    inventoryService = new InventoryService(
      inventoryRepo,
      movementRepo,
      variantRepo,
      storeRepo,
      tenantRepo,
    );
    await inventoryService.receiveStock(ctx, {
      id: 'pos-opening-stock',
      storeId: STORE_ID,
      variantId: VARIANT_ID,
      quantity: 10n,
      unitCost: usd('5.00'),
    });

    checkoutService = new CheckoutService(
      saleRepo,
      saleRepo,
      variantRepo,
      productRepo,
      storeRepo,
      tenantRepo,
    );
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('persists ordered sale lines and payments atomically with WAC snapshots', async () => {
    const cart = Cart.empty('USD')
      .addItem({
        lineId: 'first',
        variantId: VARIANT_ID,
        productId: 'pos-product',
        productName: 'Forged name',
        sku: 'FORGED',
        unitPrice: usd('12.50'),
        quantity: 1n,
      })
      .addItem({
        lineId: 'second',
        variantId: VARIANT_ID,
        productId: 'pos-product',
        productName: 'Forged name',
        sku: 'FORGED',
        unitPrice: usd('12.50'),
        quantity: 1n,
      });
    const params = {
      saleId: 'pos-sale-1',
      saleNumber: 'POS-1',
      storeId: STORE_ID,
      cart,
      payments: [
        { method: 'CARD' as const, amount: usd('10.00') },
        { method: 'CASH' as const, amount: usd('20.00') },
      ],
      idempotencyKey: 'pos-key-1',
    };

    const sale = await checkoutService.checkout(ctx, params);
    expect(sale.items.map((item) => item.productName)).toEqual(['Coffee', 'Coffee']);
    expect(sale.items.map((item) => item.sku)).toEqual(['COF-1', 'COF-1']);
    expect(sale.items.map((item) => item.unitCostSnapshot.amount)).toEqual([500n, 500n]);
    expect(sale.payments.map((payment) => payment.method)).toEqual(['CARD', 'CASH']);
    expect(sale.changeGiven).toEqual(usd('5.00'));

    const loaded = await saleRepo.findById(ctx, sale.id);
    expect(loaded?.items.map((item) => item.id)).toEqual([
      'pos-sale-1:item:0',
      'pos-sale-1:item:1',
    ]);
    expect(loaded?.payments.map((payment) => payment.id)).toEqual([
      'pos-sale-1:payment:0',
      'pos-sale-1:payment:1',
    ]);

    const position = await inventoryRepo.getPosition(ctx, STORE_ID, VARIANT_ID);
    expect(position?.quantityOnHand).toBe(8n);
    expect(await checkoutService.checkout(ctx, params)).toBeDefined();
    expect((await inventoryRepo.getPosition(ctx, STORE_ID, VARIANT_ID))?.quantityOnHand).toBe(8n);

    const conflicting = {
      ...params,
      cart: cart.setQuantity('first', 2n),
    };
    await expect(checkoutService.checkout(ctx, conflicting)).rejects.toThrow(
      'different checkout',
    );
  });

  it('rolls back stock when a checkout cannot be fulfilled', async () => {
    const cart = Cart.empty('USD').addItem({
      lineId: 'oversold',
      variantId: VARIANT_ID,
      productId: 'pos-product',
      productName: 'Coffee',
      sku: 'COF-1',
      unitPrice: usd('12.50'),
      quantity: 11n,
    });

    await expect(
      checkoutService.checkout(ctx, {
        saleId: 'pos-sale-too-large',
        saleNumber: 'POS-TOO-LARGE',
        storeId: STORE_ID,
        cart,
        payments: [{ method: 'CASH', amount: usd('137.50') }],
        idempotencyKey: 'pos-key-too-large',
      }),
    ).rejects.toThrow();

    expect((await inventoryRepo.getPosition(ctx, STORE_ID, VARIANT_ID))?.quantityOnHand).toBe(
      10n,
    );
    expect(await saleRepo.findByNumber(ctx, 'POS-TOO-LARGE')).toBeNull();
  });

  it('parses keyboard-wedge scans and formats ESC/POS receipts safely', async () => {
    const scanned: string[] = [];
    const scanner = new BarcodeScannerListener((barcode) => scanned.push(barcode));
    for (const [index, key] of Array.from('123456').entries()) {
      scanner.feed(key, index * 10 + 1);
    }
    expect(scanner.feed('Enter', 70)).toBe(true);
    expect(scanned).toEqual(['123456']);

    const cart = Cart.empty('USD').addItem({
      lineId: 'receipt-line',
      variantId: VARIANT_ID,
      productId: 'pos-product',
      productName: 'Coffee',
      sku: 'COF-1',
      unitPrice: usd('12.50'),
      quantity: 1n,
    });
    const sale = await checkoutService.checkout(ctx, {
      saleId: 'pos-sale-receipt',
      saleNumber: 'POS-RECEIPT',
      storeId: STORE_ID,
      cart,
      payments: [{ method: 'CASH', amount: usd('12.50') }],
      idempotencyKey: 'pos-key-receipt',
    });
    const printer = new EscPosReceiptPrinter({ width: '58mm', storeName: 'Main Store' });
    const bytes = printer.format(sale);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(printer.cashDrawerPulse())).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(() => new EscPosReceiptPrinter({ width: '58mm', storeName: 'متجر' }).format(sale)).toThrow(
      'cannot print',
    );

    const writes: Uint8Array[] = [];
    const device = new EscPosPrinterDevice(printer, {
      write: (data) => {
        writes.push(data);
        return Promise.resolve();
      },
    });
    await device.print(sale);
    await device.openCashDrawer();
    expect(writes[0]).toEqual(bytes);
    expect(writes[1]).toEqual(printer.cashDrawerPulse());

    const openedStores: string[] = [];
    const drawerService = new CashDrawerService(
      {
        openDrawer: (_context, storeId) => {
          openedStores.push(storeId);
          return Promise.resolve();
        },
      },
      storeRepo,
    );
    await drawerService.open(ctx, STORE_ID);
    expect(openedStores).toEqual([STORE_ID]);

    const deniedCtx = new ScopedExecutionContext({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      userId: 'cashier-no-drawer',
      roleId: 'CASHIER',
      permissions: new Set(),
      correlationId: 'drawer-denied-test',
    });
    await expect(drawerService.open(deniedCtx, STORE_ID)).rejects.toThrow('lacks required permission');
  });
});
