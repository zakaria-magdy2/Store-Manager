import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ScopedExecutionContext } from '@retailos/application';
import { Money, Permissions, Store, Tenant } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';
import { SqliteTenantRepository } from '../src/database/repositories/sqlite-tenant.repository.js';
import { SqliteStoreRepository } from '../src/database/repositories/sqlite-store.repository.js';
import { SqliteCategoryRepository } from '../src/database/repositories/sqlite-category.repository.js';
import { SqlitePurchasingRepository } from '../src/database/repositories/sqlite-purchasing.repository.js';

function egp(minor: bigint): Money {
  return Money.fromMinor(minor, 'EGP');
}

describe('Atomic inline new-product creation inside purchase invoice', () => {
  let dbManager: SqliteDatabaseManager;
  let purchasingRepo: SqlitePurchasingRepository;
  let ctx: ScopedExecutionContext;
  let tenantId: string;
  let storeId: string;
  let userId: string;
  let supplierId: string;
  let categoryId: string;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    const migrator = new DatabaseMigrator(dbManager.getDb());
    const migration = await migrator.migrateToLatest();
    expect(migration.success).toBe(true);

    const db = dbManager.getDb();
    tenantId = randomUUID();
    storeId = randomUUID();
    userId = randomUUID();
    supplierId = randomUUID();
    categoryId = randomUUID();

    const tenantRepo = new SqliteTenantRepository(db);
    const storeRepo = new SqliteStoreRepository(db);
    const categoryRepo = new SqliteCategoryRepository(db);
    purchasingRepo = new SqlitePurchasingRepository(db);

    const tenant = Tenant.create({
      id: tenantId,
      name: 'شركة الاختبار الذري',
      code: 'ATOMIC-CO',
      currency: 'EGP',
    });
    await tenantRepo.save(tenant);

    ctx = new ScopedExecutionContext({
      tenantId,
      userId,
      roleId: 'OWNER',
      permissions: new Set([Permissions.CATALOG_MANAGE, Permissions.INVENTORY_ADJUST]),
      storeId,
      correlationId: 'test-inline-purchase',
    });

    const store = Store.create({
      id: storeId,
      tenantId,
      name: 'الفرع الرئيسي',
      code: 'MAIN-01',
    });
    await storeRepo.save(ctx, store);

    await db.insertInto('users').values({
      id: userId,
      tenant_id: tenantId,
      store_id: storeId,
      username: 'owner_atomic',
      full_name: 'المالك',
      phone: null,
      employment_start_date: null,
      password_hash: 'hash',
      role: 'OWNER',
      is_active: 1,
    }).execute();

    await categoryRepo.save(ctx, {
      id: categoryId,
      tenantId,
      name: 'أحذية رياضية',
      code: 'CAT-SHOES',
      isActive: true,
      createdAt: new Date(),
    });

    await db.insertInto('suppliers').values({
      id: supplierId,
      tenant_id: tenantId,
      name: 'مورد الأحذية المركزي',
      phone: '01000000000',
      notes: null,
      is_active: 1,
    }).execute();
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('creates product + flexible variants + purchase invoice + stock + balanced journal atomically, and supports reordering', async () => {
    const db = dbManager.getDb();
    const purchaseId = randomUUID();
    const idempotencyKey = randomUUID();
    const productId = randomUUID();
    const vBlack41 = randomUUID();
    const vBlack42 = randomUUID();
    const vWhite41 = randomUUID();
    const vWhite42 = randomUUID();

    // 2 + 3 + 1 + 0 = 6 pieces @ 300.00 EGP (30000 piasters) = 1800.00 EGP (180000 piasters)
    // Optional retail price: 450.00 EGP (45000 piasters) -> expected retail = 270000 piasters
    // Paid upfront: 1000.00 EGP (100000 piasters) in CASH -> remaining payable: 80000 piasters
    const savedId = await purchasingRepo.recordPurchase(ctx, {
      id: purchaseId,
      idempotencyKey,
      supplierId,
      storeId,
      autoGenerateInvoiceNumber: true,
      totalAmount: egp(180000n),
      initialPayment: egp(100000n),
      paymentMethod: 'CASH',
      expectedRetailTotal: egp(270000n),
      notes: 'أول فاتورة بمنتج جديد داخل الفاتورة',
      purchasedAt: new Date('2026-11-22T12:00:00Z'),
      lines: [],
      newProducts: [
        {
          id: productId,
          name: 'كوتشي ميلانو رانينج',
          sku: 'MIL-900',
          categoryId,
          options: [
            { key: 'option_1', name: 'اللون', values: ['أسود', 'أبيض'] },
            { key: 'option_2', name: 'المقاس', values: ['41', '42'] },
          ],
          variants: [
            {
              id: vBlack41,
              sku: 'MIL-900-BLK-41',
              attributes: { option_1: 'أسود', option_2: '41' },
              quantity: 2n,
              unitCost: egp(30000n),
              retailPrice: egp(45000n),
              reorderPoint: 3n,
            },
            {
              id: vBlack42,
              sku: 'MIL-900-BLK-42',
              attributes: { option_1: 'أسود', option_2: '42' },
              quantity: 3n,
              unitCost: egp(30000n),
              retailPrice: egp(45000n),
              reorderPoint: 3n,
            },
            {
              id: vWhite41,
              sku: 'MIL-900-WHT-41',
              attributes: { option_1: 'أبيض', option_2: '41' },
              quantity: 1n,
              unitCost: egp(30000n),
              retailPrice: egp(45000n),
              reorderPoint: 3n,
            },
            {
              id: vWhite42,
              sku: 'MIL-900-WHT-42',
              attributes: { option_1: 'أبيض', option_2: '42' },
              quantity: 0n,
              unitCost: egp(30000n),
              retailPrice: egp(45000n),
              reorderPoint: 3n,
            },
          ],
        },
      ],
    });

    expect(savedId).toBe(purchaseId);

    // 1. Product & all 4 variants created
    const products = await db.selectFrom('products').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(products).toHaveLength(1);
    expect(products[0]?.sku).toBe('MIL-900');
    expect(products[0]?.category_id).toBe(categoryId);
    expect(products[0]?.has_variants).toBe(1);

    const variants = await db.selectFrom('product_variants').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(variants).toHaveLength(4);
    expect(variants.every((v) => BigInt(v.retail_price) === 45000n)).toBe(true);

    // 2. Only the 3 variants with qty > 0 appear in purchase items & stock movements
    const purchaseItems = await db
      .selectFrom('supplier_purchase_items')
      .selectAll()
      .where('purchase_id', '=', purchaseId)
      .execute();
    expect(purchaseItems).toHaveLength(3);

    const inventory = await db.selectFrom('inventory_items').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(inventory).toHaveLength(3);
    const totalOnHand = inventory.reduce((sum, row) => sum + BigInt(row.quantity_on_hand), 0n);
    expect(totalOnHand).toBe(6n);

    // 3. Balanced journal entry: DR 1300 = 180000, CR 1010 = 100000, CR 2010 = 80000
    const journalEntries = await db.selectFrom('journal_entries').select('id').where('tenant_id', '=', tenantId).execute();
    expect(journalEntries).toHaveLength(1);
    const journalLines = await db
      .selectFrom('journal_lines')
      .selectAll()
      .where('journal_entry_id', '=', journalEntries[0]!.id)
      .execute();
    const totalDebits = journalLines.filter((l) => l.entry_type === 'DEBIT').reduce((s, l) => s + BigInt(l.amount), 0n);
    const totalCredits = journalLines.filter((l) => l.entry_type === 'CREDIT').reduce((s, l) => s + BigInt(l.amount), 0n);
    expect(totalDebits).toBe(180000n);
    expect(totalCredits).toBe(180000n);

    // 4. Reordering the newly created variant works seamlessly alongside another inline product
    const reorderPurchaseId = randomUUID();
    const savedReorderId = await purchasingRepo.recordPurchase(ctx, {
      id: reorderPurchaseId,
      idempotencyKey: randomUUID(),
      supplierId,
      storeId,
      autoGenerateInvoiceNumber: true,
      totalAmount: egp(70000n),
      initialPayment: egp(70000n),
      paymentMethod: 'CASH',
      purchasedAt: new Date('2026-11-22T13:00:00Z'),
      lines: [
        { variantId: vBlack41, quantity: 2n, unitCost: egp(35000n) },
      ],
    });
    expect(savedReorderId).toBe(reorderPurchaseId);
    const refreshedBlack41 = await db
      .selectFrom('inventory_items')
      .selectAll()
      .where('variant_id', '=', vBlack41)
      .executeTakeFirst();
    expect(BigInt(refreshedBlack41?.quantity_on_hand ?? 0)).toBe(4n);
  });

  it('prevents duplicate products, stock, and journal entries on idempotent retry and rejects conflicting payloads', async () => {
    const db = dbManager.getDb();
    const idempotencyKey = randomUUID();
    const firstPurchaseId = randomUUID();

    const makeInput = (overrideCost?: bigint) => ({
      id: randomUUID(),
      idempotencyKey,
      supplierId,
      storeId,
      autoGenerateInvoiceNumber: true,
      totalAmount: egp((overrideCost ?? 25000n) * 4n),
      initialPayment: egp((overrideCost ?? 25000n) * 4n),
      paymentMethod: 'CASH' as const,
      purchasedAt: new Date('2026-11-22T12:00:00Z'),
      lines: [],
      newProducts: [
        {
          id: randomUUID(),
          name: 'تيشيرت قطن',
          sku: 'TEE-101',
          categoryId,
          options: [{ key: 'option_1', name: 'المقاس', values: ['M', 'L'] }],
          variants: [
            {
              id: randomUUID(),
              sku: 'TEE-101-M',
              attributes: { option_1: 'M' },
              quantity: 2n,
              unitCost: egp(overrideCost ?? 25000n),
            },
            {
              id: randomUUID(),
              sku: 'TEE-101-L',
              attributes: { option_1: 'L' },
              quantity: 2n,
              unitCost: egp(overrideCost ?? 25000n),
            },
          ],
        },
      ],
    });

    const first = { ...makeInput(), id: firstPurchaseId };
    const savedFirst = await purchasingRepo.recordPurchase(ctx, first);
    expect(savedFirst).toBe(firstPurchaseId);

    // Retry with the exact same business payload & idempotencyKey but brand-new UUIDs (as HTTP retry does)
    const replayedId = await purchasingRepo.recordPurchase(ctx, makeInput());
    expect(replayedId).toBe(firstPurchaseId);

    // Zero duplicates across all tables
    expect(await db.selectFrom('products').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(1);
    expect(await db.selectFrom('product_variants').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(2);
    expect(await db.selectFrom('supplier_purchases').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(1);
    expect(await db.selectFrom('supplier_purchase_items').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(2);
    expect(await db.selectFrom('stock_movements').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(2);
    expect(await db.selectFrom('journal_entries').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(1);

    const inv = await db.selectFrom('inventory_items').selectAll().where('tenant_id', '=', tenantId).execute();
    expect(inv.reduce((s, r) => s + BigInt(r.quantity_on_hand), 0n)).toBe(4n);

    // Same idempotencyKey with different cost must fail with 409 Conflict
    await expect(purchasingRepo.recordPurchase(ctx, makeInput(26000n))).rejects.toThrow(/مفتاح العملية مستخدم/);
  });

  it('rolls back completely on mid-transaction failure leaving zero partial product, variant, stock, purchase, or journal', async () => {
    const db = dbManager.getDb();

    // Case A: valid inline new product + invalid existing variantId on another line
    await expect(
      purchasingRepo.recordPurchase(ctx, {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        supplierId,
        storeId,
        autoGenerateInvoiceNumber: true,
        totalAmount: egp(50000n),
        initialPayment: egp(50000n),
        paymentMethod: 'CASH',
        purchasedAt: new Date(),
        lines: [
          { variantId: randomUUID(), quantity: 1n, unitCost: egp(20000n) },
        ],
        newProducts: [
          {
            id: randomUUID(),
            name: 'جاكيت شتوي',
            sku: 'JKT-FAIL-01',
            categoryId,
            options: [],
            variants: [
              {
                id: randomUUID(),
                sku: 'JKT-FAIL-01',
                attributes: {},
                quantity: 1n,
                unitCost: egp(30000n),
                retailPrice: egp(50000n),
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow();

    // Case B: valid first inline product + invalid categoryId on second inline product
    await expect(
      purchasingRepo.recordPurchase(ctx, {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        supplierId,
        storeId,
        autoGenerateInvoiceNumber: true,
        totalAmount: egp(60000n),
        initialPayment: egp(0n),
        paymentMethod: 'CASH',
        purchasedAt: new Date(),
        lines: [],
        newProducts: [
          {
            id: randomUUID(),
            name: 'منتج أول سليم',
            sku: 'OK-FIRST-01',
            categoryId,
            options: [],
            variants: [
              { id: randomUUID(), sku: 'OK-FIRST-01', attributes: {}, quantity: 1n, unitCost: egp(30000n) },
            ],
          },
          {
            id: randomUUID(),
            name: 'منتج ثاني بفئة غير موجودة',
            sku: 'BAD-CAT-02',
            categoryId: randomUUID(),
            options: [],
            variants: [
              { id: randomUUID(), sku: 'BAD-CAT-02', attributes: {}, quantity: 1n, unitCost: egp(30000n) },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/الفئة المحددة غير موجودة/);

    // Case C: single product (0 options) with >1 variants is rejected cleanly
    await expect(
      purchasingRepo.recordPurchase(ctx, {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        supplierId,
        storeId,
        autoGenerateInvoiceNumber: true,
        totalAmount: egp(40000n),
        initialPayment: egp(0n),
        paymentMethod: 'CASH',
        purchasedAt: new Date(),
        lines: [],
        newProducts: [
          {
            id: randomUUID(),
            name: 'منتج مفرد غير صالح',
            sku: 'BAD-SINGLE-01',
            categoryId,
            options: [],
            variants: [
              { id: randomUUID(), sku: 'BAD-SINGLE-01-A', attributes: {}, quantity: 1n, unitCost: egp(20000n) },
              { id: randomUUID(), sku: 'BAD-SINGLE-01-B', attributes: {}, quantity: 1n, unitCost: egp(20000n) },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/تركيبة واحدة فقط/);

    // Verify 100% clean database: ZERO partial rows anywhere
    expect(await db.selectFrom('products').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('product_variants').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('supplier_purchases').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('supplier_purchase_items').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('supplier_payments').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('inventory_items').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('stock_movements').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('journal_entries').select('id').where('tenant_id', '=', tenantId).execute()).toHaveLength(0);
    expect(await db.selectFrom('journal_lines').select('id').execute()).toHaveLength(0);
  });
});
