import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogService,
  CheckoutService,
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
import { SqliteSaleRepository } from '../src/database/repositories/sqlite-sale.repository.js';
import { SqlitePurchasingRepository } from '../src/database/repositories/sqlite-purchasing.repository.js';
import { SqliteSupplierReturnRepository } from '../src/database/repositories/sqlite-supplier-return.repository.js';
import { SqliteReturnRepository } from '../src/database/repositories/sqlite-return.repository.js';
import { SqliteExpenseRepository } from '../src/database/repositories/sqlite-expense.repository.js';
import { SqliteRecurringExpenseRepository } from '../src/database/repositories/sqlite-recurring-expense.repository.js';

function egp(minor: bigint): Money {
  return Money.fromMinor(minor, 'EGP');
}

describe('Financial & Accounting SQLite Integration Tests (Phase 5)', () => {
  let dbManager: SqliteDatabaseManager;
  let ctx: ScopedExecutionContext;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    const migration = await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    expect(migration.success).toBe(true);

    const db = dbManager.getDb();
    const tenantRepo = new SqliteTenantRepository(db);
    const storeRepo = new SqliteStoreRepository(db);
    const categoryRepo = new SqliteCategoryRepository(db);
    const productRepo = new SqliteProductRepository(db);
    const variantRepo = new SqliteProductVariantRepository(db);

    const tenant = Tenant.create({
      id: 'tenant-fin-1',
      name: 'Finance Tenant',
      code: 'FIN_TENANT',
      currency: 'EGP',
    });
    await tenantRepo.save(tenant);

    ctx = new ScopedExecutionContext({
      tenantId: 'tenant-fin-1',
      userId: 'user-fin-1',
      storeId: 'store-fin-1',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'fin-test-corr',
    });

    await storeRepo.save(
      ctx,
      Store.create({
        id: 'store-fin-1',
        tenantId: 'tenant-fin-1',
        name: 'Main Finance Branch',
        code: 'FIN01',
      }),
    );

    await db
      .insertInto('users')
      .values({
        id: 'user-fin-1',
        tenant_id: 'tenant-fin-1',
        store_id: 'store-fin-1',
        username: 'owner_fin',
        password_hash: 'hash',
        full_name: 'Finance Owner',
        role: 'OWNER',
      })
      .execute();

    const catalogService = new CatalogService(categoryRepo, productRepo, variantRepo);
    await catalogService.createProduct(ctx, {
      id: 'prod-1',
      name: 'Samsung Charger 25W',
      sku: 'SAM-25W-BASE',
      variants: [
        {
          id: 'var-1',
          sku: 'SAM-25W',
          barcode: '6220001112223',
          retailPrice: egp(50000n),
        },
      ],
    });

    await db
      .insertInto('suppliers')
      .values({
        id: 'sup-1',
        tenant_id: 'tenant-fin-1',
        name: 'Delta Electronics Distribution',
        phone: '01000000001',
        notes: null,
        is_active: 1,
      })
      .execute();
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('records supplier purchases, updates WAC, processes partial payments, and posts supplier returns with 5090 valuation variance', async () => {
    const db = dbManager.getDb();
    const purchasingRepo = new SqlitePurchasingRepository(db);
    const supplierReturnRepo = new SqliteSupplierReturnRepository(db);
    const inventoryRepo = new SqliteInventoryRepository(db);

    // 1. Purchase #1: 10 units @ 200.00 EGP = 2000.00 EGP, initial cash payment 500.00 EGP
    await purchasingRepo.recordPurchase(ctx, {
      id: 'pur-1',
      idempotencyKey: 'idem-pur-1',
      supplierId: 'sup-1',
      storeId: 'store-fin-1',
      invoiceNumber: 'INV-1001',
      totalAmount: egp(200000n),
      initialPayment: egp(50000n),
      paymentMethod: 'CASH',
      purchasedAt: new Date('2026-11-01T10:00:00.000Z'),
      lines: [
        {
          variantId: 'var-1',
          quantity: 10n,
          unitCost: egp(20000n),
        },
      ],
    });

    // Idempotent replay with exact same payload succeeds without duplicating stock
    await purchasingRepo.recordPurchase(ctx, {
      id: 'pur-1-replay',
      idempotencyKey: 'idem-pur-1',
      supplierId: 'sup-1',
      storeId: 'store-fin-1',
      invoiceNumber: 'INV-1001',
      totalAmount: egp(200000n),
      initialPayment: egp(50000n),
      paymentMethod: 'CASH',
      purchasedAt: new Date('2026-11-01T10:00:00.000Z'),
      lines: [
        {
          variantId: 'var-1',
          quantity: 10n,
          unitCost: egp(20000n),
        },
      ],
    });

    // Conflicting payload with same idempotency key must reject
    await expect(
      purchasingRepo.recordPurchase(ctx, {
        id: 'pur-1-conflict',
        idempotencyKey: 'idem-pur-1',
        supplierId: 'sup-1',
        storeId: 'store-fin-1',
        invoiceNumber: 'INV-1001-DIFF',
        totalAmount: egp(200000n),
        initialPayment: egp(50000n),
        paymentMethod: 'CASH',
        purchasedAt: new Date('2026-11-01T10:00:00.000Z'),
        lines: [
          {
            variantId: 'var-1',
            quantity: 10n,
            unitCost: egp(20000n),
          },
        ],
      }),
    ).rejects.toThrow(/مفتاح العملية مستخدم/);

    // 2. Purchase #2: 10 units @ 300.00 EGP = 3000.00 EGP on credit (0 initial payment)
    // WAC becomes (10 * 20000 + 10 * 30000) / 20 = 25000 (250.00 EGP)
    await purchasingRepo.recordPurchase(ctx, {
      id: 'pur-2',
      idempotencyKey: 'idem-pur-2',
      supplierId: 'sup-1',
      storeId: 'store-fin-1',
      invoiceNumber: 'INV-1002',
      totalAmount: egp(300000n),
      initialPayment: egp(0n),
      paymentMethod: 'CASH',
      purchasedAt: new Date('2026-11-02T10:00:00.000Z'),
      lines: [
        {
          variantId: 'var-1',
          quantity: 10n,
          unitCost: egp(30000n),
        },
      ],
    });

    const levelAfterPurchases = await inventoryRepo.getPosition(ctx, 'store-fin-1', 'var-1');
    expect(levelAfterPurchases?.quantityOnHand).toBe(20n);
    expect(levelAfterPurchases?.wacCost.amount).toBe(25000n);

    // 3. Supplier partial payment on Purchase #1 (remaining is 1500.00 EGP; pay 600.00 EGP)
    await purchasingRepo.recordSupplierPayment(ctx, {
      id: 'spay-1',
      idempotencyKey: 'idem-spay-1',
      purchaseId: 'pur-1',
      amount: egp(60000n),
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: 'BNK-77',
      paidAt: new Date('2026-11-03T10:00:00.000Z'),
    });

    // Overpayment beyond remaining 900.00 EGP must reject
    await expect(
      purchasingRepo.recordSupplierPayment(ctx, {
        id: 'spay-over',
        idempotencyKey: 'idem-spay-over',
        purchaseId: 'pur-1',
        amount: egp(100000n),
        paymentMethod: 'CASH',
        paidAt: new Date('2026-11-03T11:00:00.000Z'),
      }),
    ).rejects.toThrow(/المبلغ أكبر من المديونية المتبقية/);

    // 4. Return 2 units from Purchase #1 (original unit_cost = 20000, current WAC = 25000)
    // Supplier payable reduction = 40000, inventory credit at WAC = 50000, debit 5090 variance = 10000
    const returnResult = await supplierReturnRepo.record(ctx, {
      id: 'sret-1',
      idempotencyKey: 'idem-sret-1',
      purchaseId: 'pur-1',
      storeId: 'store-fin-1',
      occurredAt: new Date('2026-11-04T10:00:00.000Z'),
      lines: [
        {
          purchaseItemId: 'pur-1:item:0',
          quantity: 2n,
        },
      ],
    });

    expect(returnResult.creditAmount).toBe(40000n);

    const levelAfterReturn = await inventoryRepo.getPosition(ctx, 'store-fin-1', 'var-1');
    expect(levelAfterReturn?.quantityOnHand).toBe(18n);
    expect(levelAfterReturn?.wacCost.amount).toBe(25000n);

    // Verify journal entry for SUPPLIER_RETURN includes 5090 variance and is balanced
    const sretJournal = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('source_type', '=', 'SUPPLIER_RETURN')
      .where('source_id', '=', 'sret-1')
      .executeTakeFirstOrThrow();

    const sretLines = await db
      .selectFrom('journal_lines')
      .selectAll()
      .where('journal_entry_id', '=', sretJournal.id)
      .execute();

    const totalDebits = sretLines
      .filter((l) => l.entry_type === 'DEBIT')
      .reduce((s, l) => s + BigInt(l.amount), 0n);
    const totalCredits = sretLines
      .filter((l) => l.entry_type === 'CREDIT')
      .reduce((s, l) => s + BigInt(l.amount), 0n);

    expect(totalDebits).toBe(50000n);
    expect(totalCredits).toBe(50000n);
    expect(
      sretLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:5090' &&
          l.entry_type === 'DEBIT' &&
          BigInt(l.amount) === 10000n,
      ),
    ).toBe(true);
  });

  it('processes linked customer sales returns, restores WAC inventory, reverses COGS, and prevents over-returns', async () => {
    const db = dbManager.getDb();
    const purchasingRepo = new SqlitePurchasingRepository(db);
    const saleRepo = new SqliteSaleRepository(db);
    const returnRepo = new SqliteReturnRepository(db);
    const inventoryRepo = new SqliteInventoryRepository(db);
    const variantRepo = new SqliteProductVariantRepository(db);
    const productRepo = new SqliteProductRepository(db);
    const storeRepo = new SqliteStoreRepository(db);
    const tenantRepo = new SqliteTenantRepository(db);

    // Receive 5 units @ 200.00 EGP
    await purchasingRepo.recordPurchase(ctx, {
      id: 'pur-sale-1',
      idempotencyKey: 'idem-pur-sale-1',
      supplierId: 'sup-1',
      storeId: 'store-fin-1',
      totalAmount: egp(100000n),
      initialPayment: egp(100000n),
      paymentMethod: 'CASH',
      purchasedAt: new Date('2026-11-01T09:00:00.000Z'),
      lines: [{ variantId: 'var-1', quantity: 5n, unitCost: egp(20000n) }],
    });

    // Sell 3 units @ 500.00 EGP = 1500.00 EGP via CheckoutService
    const checkoutService = new CheckoutService(
      saleRepo,
      saleRepo,
      variantRepo,
      productRepo,
      storeRepo,
      tenantRepo,
    );

    const cart = Cart.empty('EGP').addItem({
      lineId: 'line-1',
      variantId: 'var-1',
      productId: 'prod-1',
      productName: 'Samsung Charger 25W',
      sku: 'SAM-25W',
      unitPrice: egp(50000n),
      quantity: 3n,
    });

    const completedSale = await checkoutService.checkout(ctx, {
      saleId: 'sale-fin-1',
      saleNumber: 'POS-FIN-1',
      storeId: 'store-fin-1',
      cart,
      payments: [{ method: 'CASH', amount: egp(150000n) }],
      idempotencyKey: 'idem-sale-fin-1',
    });

    expect(completedSale.items[0]?.unitCostSnapshot.amount).toBe(20000n);

    // Return 1 unit from sale-fin-1:item:0
    const custReturn = await returnRepo.record(ctx, {
      id: 'cret-1',
      idempotencyKey: 'idem-cret-1',
      storeId: 'store-fin-1',
      originalSaleId: 'sale-fin-1',
      paymentMethod: 'CASH',
      occurredAt: new Date('2026-11-01T14:00:00.000Z'),
      lines: [
        {
          originalSaleItemId: 'sale-fin-1:item:0',
          quantity: 1n,
        },
      ],
    });

    expect(custReturn.refundAmount).toBe(50000n);

    // Stock should be 5 - 3 + 1 = 3 units
    const stockAfterReturn = await inventoryRepo.getPosition(ctx, 'store-fin-1', 'var-1');
    expect(stockAfterReturn?.quantityOnHand).toBe(3n);

    // Attempting to return 3 more units when only 2 remain returnable must fail
    await expect(
      returnRepo.record(ctx, {
        id: 'cret-over',
        idempotencyKey: 'idem-cret-over',
        storeId: 'store-fin-1',
        originalSaleId: 'sale-fin-1',
        paymentMethod: 'CASH',
        occurredAt: new Date('2026-11-01T15:00:00.000Z'),
        lines: [
          {
            originalSaleItemId: 'sale-fin-1:item:0',
            quantity: 3n,
          },
        ],
      }),
    ).rejects.toThrow(/كمية المرتجع أكبر من الكمية المتبقية/);
  });

  it('records direct expenses and recurring monthly obligations with upfront recognition and non-double-counted settlements', async () => {
    const db = dbManager.getDb();
    const expenseRepo = new SqliteExpenseRepository(db);
    const recurringRepo = new SqliteRecurringExpenseRepository(db);

    // 1. Direct daily expense: 150.00 EGP paid from cash drawer (1010)
    await expenseRepo.record(ctx, {
      id: 'exp-1',
      idempotencyKey: 'idem-exp-1',
      storeId: 'store-fin-1',
      categoryCode: 'SUPPLIES',
      amount: 15000n,
      currency: 'EGP',
      paymentMethod: 'CASH_DRAWER',
      expenseDate: '2026-11-05',
      notes: 'مستلزمات نظافة للفرع',
    });

    const expJournal = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('source_type', '=', 'EXPENSE')
      .where('source_id', '=', 'exp-1')
      .executeTakeFirstOrThrow();

    const expLines = await db
      .selectFrom('journal_lines')
      .selectAll()
      .where('journal_entry_id', '=', expJournal.id)
      .execute();

    expect(
      expLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:6090' &&
          l.entry_type === 'DEBIT' &&
          BigInt(l.amount) === 15000n,
      ),
    ).toBe(true);
    expect(
      expLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:1010' &&
          l.entry_type === 'CREDIT' &&
          BigInt(l.amount) === 15000n,
      ),
    ).toBe(true);

    // 2. Create recurring monthly obligation (Rent)
    const obligationId = await recurringRepo.create(ctx, {
      id: 'rec-1',
      idempotencyKey: 'idem-rec-1',
      storeId: 'store-fin-1',
      categoryCode: 'RENT',
      name: 'إيجار المعرض الرئيسي',
      dueDay: 5,
      currency: 'EGP',
    });
    expect(obligationId).toBe('rec-1');

    // 3. Confirm November actual obligation upfront at 9000.00 EGP (900000 minor)
    const confirmed = await recurringRepo.confirmActual(ctx, {
      obligationId: 'rec-1',
      year: 2026,
      month: 11,
      amount: 900000n,
      confirmedAt: new Date('2026-11-05T12:00:00.000Z'),
    });
    expect(confirmed.amount).toBe(900000n);

    // Verify full 9000.00 EGP is recognized in 6090 and 2020
    const recJournal = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('idempotency_key', '=', 'monthly-accrual:rec-1:2026-11')
      .executeTakeFirstOrThrow();

    const recLines = await db
      .selectFrom('journal_lines')
      .selectAll()
      .where('journal_entry_id', '=', recJournal.id)
      .execute();

    expect(
      recLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:6090' &&
          l.entry_type === 'DEBIT' &&
          BigInt(l.amount) === 900000n,
      ),
    ).toBe(true);
    expect(
      recLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:2020' &&
          l.entry_type === 'CREDIT' &&
          BigInt(l.amount) === 900000n,
      ),
    ).toBe(true);

    // 4. Pay partial 4000.00 EGP then remaining 5000.00 EGP; must debit 2020 and credit 1015 (NOT 6090 again)
    const partialPay = await recurringRepo.pay(ctx, {
      id: 'occ-pay-1',
      idempotencyKey: 'idem-occ-pay-1',
      actualId: confirmed.id,
      amount: 400000n,
      paymentMethod: 'CASH_SAFE',
      paidAt: new Date('2026-11-06T12:00:00.000Z'),
    });
    expect(partialPay.remaining).toBe(500000n);

    const finalPay = await recurringRepo.pay(ctx, {
      id: 'occ-pay-2',
      idempotencyKey: 'idem-occ-pay-2',
      actualId: confirmed.id,
      amount: 500000n,
      paymentMethod: 'CASH_SAFE',
      paidAt: new Date('2026-11-10T12:00:00.000Z'),
    });
    expect(finalPay.remaining).toBe(0n);

    const settleJournal = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('idempotency_key', '=', 'monthly-payment:idem-occ-pay-2')
      .executeTakeFirstOrThrow();

    const settleLines = await db
      .selectFrom('journal_lines')
      .selectAll()
      .where('journal_entry_id', '=', settleJournal.id)
      .execute();

    expect(
      settleLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:2020' &&
          l.entry_type === 'DEBIT' &&
          BigInt(l.amount) === 500000n,
      ),
    ).toBe(true);
    expect(
      settleLines.some(
        (l) =>
          l.account_id === 'tenant-fin-1:account:1015' &&
          l.entry_type === 'CREDIT' &&
          BigInt(l.amount) === 500000n,
      ),
    ).toBe(true);
    expect(settleLines.some((l) => l.account_id === 'tenant-fin-1:account:6090')).toBe(false);

    // Any further settlement on a fully paid occurrence must reject
    await expect(
      recurringRepo.pay(ctx, {
        id: 'occ-pay-over',
        idempotencyKey: 'idem-occ-pay-over',
        actualId: confirmed.id,
        amount: 100n,
        paymentMethod: 'CASH_SAFE',
        paidAt: new Date('2026-11-11T12:00:00.000Z'),
      }),
    ).rejects.toThrow(/مبلغ السداد أكبر من المتبقي على الالتزام/);
  });

  it('enforces monthly accounting periods, closed-period lock, and database-level journal immutability', async () => {
    const db = dbManager.getDb();
    const expenseRepo = new SqliteExpenseRepository(db);

    // 1. Record an expense in October 2026 -> creates monthly period 2026-10
    await expenseRepo.record(ctx, {
      id: 'exp-oct-1',
      idempotencyKey: 'idem-exp-oct-1',
      storeId: 'store-fin-1',
      categoryCode: 'UTILITIES',
      amount: 15000n,
      currency: 'EGP',
      paymentMethod: 'CASH_DRAWER',
      expenseDate: '2026-10-15',
      notes: 'فاتورة كهرباء أكتوبر',
    });

    const octPeriod = await db
      .selectFrom('accounting_periods')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('name', '=', '2026-10')
      .executeTakeFirstOrThrow();
    expect(octPeriod.start_date).toBe('2026-10-01');
    expect(octPeriod.end_date).toBe('2026-10-31');
    expect(octPeriod.status).toBe('OPEN');

    // 2. Close October 2026 period
    await db
      .updateTable('accounting_periods')
      .set({
        status: 'CLOSED',
        closed_at: '2026-11-01T00:00:00.000Z',
        closed_by_user_id: 'user-fin-1',
      })
      .where('id', '=', octPeriod.id)
      .execute();

    // 3. Reopening or deleting a CLOSED accounting period must be blocked by SQLite trigger
    await expect(
      db
        .updateTable('accounting_periods')
        .set({ status: 'OPEN' })
        .where('id', '=', octPeriod.id)
        .execute(),
    ).rejects.toThrow(/AccountingPeriodClosed/);

    // 4. Posting into closed October 2026 must fail, while posting into November 2026 succeeds
    await expect(
      expenseRepo.record(ctx, {
        id: 'exp-oct-2',
        idempotencyKey: 'idem-exp-oct-2',
        storeId: 'store-fin-1',
        categoryCode: 'UTILITIES',
        amount: 5000n,
        currency: 'EGP',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-10-20',
      }),
    ).rejects.toThrow(/الفترة المحاسبية مقفلة/);

    await expenseRepo.record(ctx, {
      id: 'exp-nov-1',
      idempotencyKey: 'idem-exp-nov-1',
      storeId: 'store-fin-1',
      categoryCode: 'UTILITIES',
      amount: 18000n,
      currency: 'EGP',
      paymentMethod: 'CASH_DRAWER',
      expenseDate: '2026-11-05',
    });

    // 5. Mutating or deleting journal_lines or journal_entries must be rejected by SQLite triggers
    const journalEntry = await db
      .selectFrom('journal_entries')
      .selectAll()
      .where('tenant_id', '=', 'tenant-fin-1')
      .where('source_id', '=', 'exp-nov-1')
      .executeTakeFirstOrThrow();

    await expect(
      db
        .updateTable('journal_lines')
        .set({ amount: 99999n })
        .where('journal_entry_id', '=', journalEntry.id)
        .execute(),
    ).rejects.toThrow(/journal_lines is append-only/);

    await expect(
      db.deleteFrom('journal_entries').where('id', '=', journalEntry.id).execute(),
    ).rejects.toThrow(/journal_entries is append-only/);
  });
});
