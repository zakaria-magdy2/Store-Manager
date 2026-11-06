import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CatalogService,
  InventoryService,
  ScopedExecutionContext,
} from '@retailos/application';
import { Money, Store, Tenant } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';
import { SqliteTenantRepository } from '../src/database/repositories/sqlite-tenant.repository.js';
import { SqliteStoreRepository } from '../src/database/repositories/sqlite-store.repository.js';
import { SqliteCategoryRepository } from '../src/database/repositories/sqlite-category.repository.js';
import { SqliteProductRepository } from '../src/database/repositories/sqlite-product.repository.js';
import { SqliteProductVariantRepository } from '../src/database/repositories/sqlite-product-variant.repository.js';
import { SqliteInventoryRepository } from '../src/database/repositories/sqlite-inventory.repository.js';
import { SqliteStockMovementRepository } from '../src/database/repositories/sqlite-stock-movement.repository.js';

const TENANT_ID = 'tenant-alpha';
const STORE_ID = 'store-1';

function usd(decimal: string): Money {
  return Money.fromDecimal(decimal, 'USD');
}

describe('Phase 3: Catalog & WAC Inventory Engine', () => {
  let dbManager: SqliteDatabaseManager;
  let tenantRepo: SqliteTenantRepository;
  let storeRepo: SqliteStoreRepository;
  let categoryRepo: SqliteCategoryRepository;
  let productRepo: SqliteProductRepository;
  let variantRepo: SqliteProductVariantRepository;
  let inventoryRepo: SqliteInventoryRepository;
  let movementRepo: SqliteStockMovementRepository;
  let catalogService: CatalogService;
  let inventoryService: InventoryService;
  let ctx: ScopedExecutionContext;
  let tenant: Tenant;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();

    const migrator = new DatabaseMigrator(dbManager.getDb());
    const migration = await migrator.migrateToLatest();
    expect(migration.success).toBe(true);
    expect(migration.executedMigrations).toContain('003_catalog_inventory');

    const db = dbManager.getDb();
    tenantRepo = new SqliteTenantRepository(db);
    storeRepo = new SqliteStoreRepository(db);
    categoryRepo = new SqliteCategoryRepository(db);
    productRepo = new SqliteProductRepository(db);
    variantRepo = new SqliteProductVariantRepository(db);
    inventoryRepo = new SqliteInventoryRepository(db);
    movementRepo = new SqliteStockMovementRepository(db);

    catalogService = new CatalogService(categoryRepo, productRepo, variantRepo);
    inventoryService = new InventoryService(
      inventoryRepo,
      movementRepo,
      variantRepo,
      storeRepo,
      tenantRepo,
    );

    tenant = Tenant.create({
      id: TENANT_ID,
      name: 'Alpha Retail',
      code: 'ALPHA',
      currency: 'USD',
    });
    await tenantRepo.save(tenant);

    ctx = new ScopedExecutionContext({
      tenantId: TENANT_ID,
      userId: 'owner-1',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'test-correlation',
    });

    await storeRepo.save(
      ctx,
      Store.create({ id: STORE_ID, tenantId: TENANT_ID, name: 'Main Store', code: 'MAIN' }),
    );
    await storeRepo.save(
      ctx,
      Store.create({ id: 'store-2', tenantId: TENANT_ID, name: 'Second Store', code: 'SECOND' }),
    );
    await db.insertInto('users').values([
      { id: 'owner-1', tenant_id: TENANT_ID, store_id: null, username: 'owner', password_hash: 'test-hash', full_name: 'Owner', role: 'OWNER' },
      { id: 'cashier-1', tenant_id: TENANT_ID, store_id: STORE_ID, username: 'cashier', password_hash: 'test-hash', full_name: 'Cashier', role: 'CASHIER' },
    ]).execute();
  });

  afterEach(async () => {
    await dbManager.close();
  });

  async function seedCola(): Promise<{ variantId: string; productId: string }> {
    await catalogService.createCategory(ctx, {
      id: 'cat-1',
      name: 'Beverages',
      code: 'BEV',
    });

    const { product, variants } = await catalogService.createProduct(ctx, {
      id: 'prod-1',
      name: 'Cola',
      sku: 'COLA',
      categoryId: 'cat-1',
      hasVariants: true,
      variants: [
        {
          id: 'var-330',
          sku: 'COLA-330',
          barcode: '111111',
          attributes: { size: '330ml', color: 'red' },
          retailPrice: usd('1.50'),
          reorderPoint: 5n,
        },
        {
          id: 'var-500',
          sku: 'COLA-500',
          barcode: '222222',
          attributes: { size: '500ml', color: 'red' },
          retailPrice: usd('2.00'),
        },
      ],
    });

    expect(variants).toHaveLength(2);
    return { variantId: variants[0]!.id, productId: product.id };
  }

  it('creates the catalog and resolves variants by barcode', async () => {
    await seedCola();

    const found = await catalogService.findByBarcode(ctx, '111111');
    expect(found).not.toBeNull();
    expect(found!.product.sku).toBe('COLA');
    expect(found!.variant.sku).toBe('COLA-330');
    expect(found!.variant.attributes.size).toBe('330ml');
    expect(found!.variant.retailPrice.amount).toBe(150n);

    await expect(
      catalogService.createProduct(ctx, {
        id: 'prod-dup',
        name: 'Duplicate',
        sku: 'COLA',
        variants: [{ id: 'var-dup', sku: 'COLA-DUP', retailPrice: usd('1.00') }],
      }),
    ).rejects.toThrow("Product SKU 'COLA' already exists");

    await expect(
      catalogService.createProduct(ctx, {
        id: 'prod-dup-2',
        name: 'Duplicate Barcode',
        sku: 'COLA-2',
        variants: [
          { id: 'var-dup-2', sku: 'COLA-2-A', barcode: '111111', retailPrice: usd('1.00') },
        ],
      }),
    ).rejects.toThrow("Barcode '111111' is already assigned");
  });

  it('isolates catalog and inventory data between tenants', async () => {
    await seedCola();

    const otherTenant = Tenant.create({
      id: 'tenant-beta',
      name: 'Beta Retail',
      code: 'BETA',
      currency: 'USD',
    });
    await tenantRepo.save(otherTenant);

    const otherCtx = new ScopedExecutionContext({
      tenantId: otherTenant.id,
      userId: 'owner-beta',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'test-beta',
    });

    expect(await catalogService.findByBarcode(otherCtx, '111111')).toBeNull();
    expect(await productRepo.findById(otherCtx, 'prod-1')).toBeNull();
    expect(await variantRepo.findById(otherCtx, 'var-330')).toBeNull();
    expect(await categoryRepo.findById(otherCtx, 'cat-1')).toBeNull();
    expect(await inventoryRepo.getPosition(otherCtx, STORE_ID, 'var-330')).toBeNull();
  });

  it('valuates stock with WAC across receipts and snapshots COGS on sale', async () => {
    const { variantId } = await seedCola();

    const firstReceipt = await inventoryService.receiveStock(ctx, {
      id: 'mv-receipt-1',
      storeId: STORE_ID,
      variantId,
      quantity: 10n,
      unitCost: usd('5.00'),
      sourceId: 'po-1',
    });
    expect(firstReceipt.quantityOnHand).toBe(10n);
    expect(firstReceipt.wacCost.amount).toBe(500n);

    const secondReceipt = await inventoryService.receiveStock(ctx, {
      id: 'mv-receipt-2',
      storeId: STORE_ID,
      variantId,
      quantity: 5n,
      unitCost: usd('8.00'),
      sourceId: 'po-2',
    });
    expect(secondReceipt.quantityOnHand).toBe(15n);
    // (10*500 + 5*800) / 15 = 600 cents
    expect(secondReceipt.wacCost.amount).toBe(600n);

    const sale = await inventoryService.recordSale(ctx, {
      id: 'mv-sale-1',
      storeId: STORE_ID,
      variantId,
      quantity: 3n,
      sourceId: 'sale-1',
    });
    expect(sale.quantityOnHand).toBe(12n);
    expect(sale.wacCost.amount).toBe(600n);
    expect(sale.unitCostSnapshot.amount).toBe(600n);
    expect(sale.costOfGoodsSold.amount).toBe(1800n);

    const position = await inventoryService.getPosition(ctx, STORE_ID, variantId);
    expect(position!.quantityOnHand).toBe(12n);
    expect(position!.wacCost.toDecimalString()).toBe('6.00');

    const movements = await inventoryService.listMovements(ctx, STORE_ID, variantId);
    expect(movements).toHaveLength(3);
    expect(movements[0]!.movementType).toBe('SALE');
    expect(movements[0]!.unitCost.amount).toBe(600n);
    expect(movements[0]!.resultingQuantity).toBe(12n);

    await expect(
      inventoryService.recordSale(ctx, {
        id: 'mv-sale-over',
        storeId: STORE_ID,
        variantId,
        quantity: 100n,
        sourceId: 'sale-over',
      }),
    ).rejects.toThrow('Insufficient stock');
  });

  it('enforces append-only stock movements at the database level', async () => {
    const { variantId } = await seedCola();
    await inventoryService.receiveStock(ctx, {
      id: 'mv-locked',
      storeId: STORE_ID,
      variantId,
      quantity: 1n,
      unitCost: usd('1.00'),
    });

    const db = dbManager.getDb();
    await expect(
      db
        .updateTable('stock_movements')
        .set({ unit_cost: 99n })
        .where('id', '=', 'mv-locked')
        .execute(),
    ).rejects.toThrow('append-only');

    await expect(
      db.deleteFrom('stock_movements').where('id', '=', 'mv-locked').execute(),
    ).rejects.toThrow('append-only');
  });

  it('allows negative stock only when the tenant explicitly enables it', async () => {
    const { variantId } = await seedCola();

    await expect(
      inventoryService.recordSale(ctx, {
        id: 'mv-negative-1',
        storeId: STORE_ID,
        variantId,
        quantity: 2n,
        sourceId: 'sale-neg-1',
      }),
    ).rejects.toThrow('Insufficient stock');

    tenant.setNegativeStockPolicy(true);
    await tenantRepo.save(tenant);

    const sale = await inventoryService.recordSale(ctx, {
      id: 'mv-negative-2',
      storeId: STORE_ID,
      variantId,
      quantity: 2n,
      sourceId: 'sale-neg-2',
    });

    expect(sale.quantityOnHand).toBe(-2n);
    expect(sale.unitCostSnapshot.amount).toBe(0n);
  });

  it('moves stock between stores atomically at the source WAC', async () => {
    const { variantId } = await seedCola();

    await inventoryService.receiveStock(ctx, {
      id: 'mv-transfer-seed',
      storeId: STORE_ID,
      variantId,
      quantity: 10n,
      unitCost: usd('4.00'),
    });

    const transfer = await inventoryService.transferStock(ctx, {
      id: 'transfer-1',
      fromStoreId: STORE_ID,
      toStoreId: 'store-2',
      variantId,
      quantity: 4n,
    });

    expect(transfer.out.movementType).toBe('TRANSFER_OUT');
    expect(transfer.out.resultingQuantity).toBe(6n);
    expect(transfer.in.movementType).toBe('TRANSFER_IN');
    expect(transfer.in.resultingQuantity).toBe(4n);
    expect(transfer.in.unitCost.amount).toBe(400n);

    const source = await inventoryService.getPosition(ctx, STORE_ID, variantId);
    const destination = await inventoryService.getPosition(ctx, 'store-2', variantId);
    expect(source!.quantityOnHand).toBe(6n);
    expect(destination!.quantityOnHand).toBe(4n);
    expect(destination!.wacCost.amount).toBe(400n);
  });

  it('records damage, supplier returns and stock adjustments', async () => {
    const { variantId } = await seedCola();

    await inventoryService.receiveStock(ctx, {
      id: 'mv-adj-seed',
      storeId: STORE_ID,
      variantId,
      quantity: 10n,
      unitCost: usd('5.00'),
    });

    const damage = await inventoryService.recordDamage(ctx, {
      id: 'mv-damage',
      storeId: STORE_ID,
      variantId,
      quantity: 2n,
      sourceId: 'damage-1',
    });
    expect(damage.quantityOnHand).toBe(8n);
    expect(damage.wacCost.amount).toBe(500n);

    const supplierReturn = await inventoryService.recordSupplierReturn(ctx, {
      id: 'mv-supplier-return',
      storeId: STORE_ID,
      variantId,
      quantity: 1n,
      sourceId: 'return-1',
    });
    expect(supplierReturn.quantityOnHand).toBe(7n);

    const adjustment = await inventoryService.adjustStock(ctx, {
      id: 'mv-adjust',
      storeId: STORE_ID,
      variantId,
      targetQuantity: 10n,
      unitCost: usd('7.00'),
      reason: 'cycle count',
    });
    expect(adjustment.quantityOnHand).toBe(10n);
    // (7*500 + 3*700) / 10 = 560 cents
    expect(adjustment.wacCost.amount).toBe(560n);
  });

  it('enforces store scoping for store-bound users', async () => {
    const { variantId } = await seedCola();

    const cashierCtx = new ScopedExecutionContext({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      userId: 'cashier-1',
      roleId: 'CASHIER',
      permissions: new Set(['pos:checkout', 'inventory:view']),
      correlationId: 'cashier-test',
    });

    await inventoryService.receiveStock(ctx, {
      id: 'mv-scope-seed',
      storeId: STORE_ID,
      variantId,
      quantity: 5n,
      unitCost: usd('2.00'),
    });

    const sale = await inventoryService.recordSale(cashierCtx, {
      id: 'mv-scope-sale',
      storeId: STORE_ID,
      variantId,
      quantity: 1n,
      sourceId: 'sale-scope',
    });
    expect(sale.quantityOnHand).toBe(4n);

    await expect(
      inventoryService.recordSale(cashierCtx, {
        id: 'mv-scope-sale-2',
        storeId: 'store-2',
        variantId,
        quantity: 1n,
        sourceId: 'sale-scope-2',
      }),
    ).rejects.toThrow('cannot operate on store');
  });
});
