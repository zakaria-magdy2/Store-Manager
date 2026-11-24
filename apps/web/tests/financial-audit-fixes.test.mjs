import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServerApp } from '../server.mjs';
import { cleanupTempDir, createTestTempDir } from './e2e-server-harness.mjs';

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const chosen = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePort(chosen));
    });
  });
}

test('P1/P2 financial audit fixes: shift drawer movements, cross-day supplier payment edit/method/void reconciliation, and expense edit notes/ref conflict', async (t) => {
  const dataDir = await createTestTempDir('retailos-fin-audit-fixes-');
  const freePort = await getFreePort();
  const currentNowMs = Date.UTC(2026, 10, 22, 10, 0, 0); // 2026-11-22 10:00 UTC

  process.env.NODE_ENV = 'test';
  process.env.PORT = String(freePort);
  process.env.RETAILOS_DATA_DIR = dataDir;
  process.env.RETAILOS_DB_PATH = join(dataDir, 'retailos.sqlite');
  process.env.RETAILOS_COMPANY_NAME = 'شركة اختبار المراجعة المالية';
  process.env.RETAILOS_COMPANY_CODE = 'FINFIX';
  process.env.RETAILOS_CURRENCY = 'EGP';
  process.env.RETAILOS_STORE_NAME = 'الفرع الرئيسي';

  const app = await createServerApp({
    host: '127.0.0.1',
    port: freePort,
    dataDir,
    watermarkSecret: randomBytes(32).toString('hex'),
    dailyBackupSecret: randomBytes(32).toString('base64url'),
    nowProvider: () => currentNowMs,
    betaTrialConfig: {
      enabled: true,
      autoLogin: true,
      issuedAt: new Date(Date.UTC(2026, 10, 20, 0, 0, 0)).toISOString(),
      expiresAt: new Date(Date.UTC(2026, 10, 30, 0, 0, 0)).toISOString(),
    },
  });

  const baseUrl = app.origin;
  const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };
  const apiJson = async (path, options = {}) => {
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    const bootData = await apiJson('/api/data');
    assert.equal(bootData.status, 200);
    const storeId = bootData.body.selectedStoreId;

    // Setup category & supplier
    const cat = await apiJson('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'أحذية' }) });
    assert.equal(cat.status, 201);
    const sup = await apiJson('/api/suppliers', { method: 'POST', body: JSON.stringify({ name: 'مورد المراجعة' }) });
    assert.equal(sup.status, 201);

    // =========================================================================
    // TEST 1 (P1): Shift close expected cash includes drawer expenses, supplier payments, & treasury transfers
    // =========================================================================
    const shiftStart = await apiJson('/api/shifts/start', {
      method: 'POST',
      body: JSON.stringify({ storeId, openingCash: '100000' }), // 1000.00 EGP
    });
    assert.equal(shiftStart.status, 201);

    // 1a. Record 100 EGP expense from CASH_DRAWER
    const expRes = await apiJson('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        storeId,
        idempotencyKey: randomUUID(),
        categoryCode: 'UTILITIES',
        amount: '10000', // 100.00 EGP
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-11-22',
        notes: 'كهرباء المحل',
      }),
    });
    assert.equal(expRes.status, 201);

    // Verify open shift expectedCash = 1000 - 100 = 900 EGP (90000 piasters)
    const curShiftAfterExp = await apiJson('/api/shifts/current');
    assert.equal(curShiftAfterExp.status, 200);
    assert.equal(curShiftAfterExp.body.currentShift.expectedCash, '90000');
    assert.equal(curShiftAfterExp.body.currentShift.cashExpenses, '10000');

    // 1b. Record purchase (1000 EGP total, 200 EGP paid CASH from drawer) -> expected = 700 EGP
    const purchaseRes = await apiJson('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: sup.body.id,
        storeId,
        idempotencyKey: randomUUID(),
        invoiceNumber: 'INV-SHIFT-001',
        totalAmount: '100000',
        paidAmount: '20000', // 200.00 EGP from CASH drawer
        paymentMethod: 'CASH',
        items: [],
        newProducts: [{
          name: 'حذاء مراجعة',
          sku: 'AUD-SHOE-1',
          categoryId: cat.body.id,
          options: [{ key: 'option_1', name: 'المقاس', values: ['42'] }],
          variants: [{ sku: 'AUD-SHOE-1-42', attributes: { option_1: '42' }, quantity: '5', unitCost: '20000', retailPrice: '35000', reorderPoint: '1' }],
        }],
      }),
    });
    assert.equal(purchaseRes.status, 201);

    const curShiftAfterSup = await apiJson('/api/shifts/current');
    assert.equal(curShiftAfterSup.body.currentShift.expectedCash, '70000');
    assert.equal(curShiftAfterSup.body.currentShift.cashSupplierPayments, '20000');

    // 1c. Record treasury transfer from drawer (1010) to safe (1015) of 150 EGP -> expected = 550 EGP
    const transferRes = await apiJson('/api/accounting/treasury-transfer', {
      method: 'POST',
      body: JSON.stringify({
        storeId,
        idempotencyKey: randomUUID(),
        fromAccount: '1010',
        toAccount: '1015',
        amount: '15000', // 150.00 EGP
        notes: 'توريد للخزينة',
      }),
    });
    assert.equal(transferRes.status, 201);

    const curShiftAfterTransfer = await apiJson('/api/shifts/current');
    assert.equal(curShiftAfterTransfer.body.currentShift.expectedCash, '55000');
    assert.equal(curShiftAfterTransfer.body.currentShift.cashTransfersNet, '-15000');

    // Also verify /api/shifts shows 55000 while open
    const historyOpen = await apiJson(`/api/shifts?storeId=${storeId}`);
    assert.equal(historyOpen.status, 200);
    assert.equal(historyOpen.body.shifts[0].expectedCash, '55000');

    // 1d. Close shift with actualCash = 55000 -> variance MUST be 0!
    const closeRes = await apiJson('/api/shifts/end', {
      method: 'POST',
      body: JSON.stringify({
        shiftId: shiftStart.body.shift.id,
        actualCash: '55000',
        handoverCash: '55000',
      }),
    });
    assert.equal(closeRes.status, 200);
    assert.equal(closeRes.body.shift.expectedCash, '55000');
    assert.equal(closeRes.body.shift.variance, '0');

    // =========================================================================
    // TEST 3 (P2): Expense edit idempotency rejects conflicting notes / referenceNumber with 409
    // =========================================================================
    const expEditKey = randomUUID();
    const editExp1 = await apiJson(`/api/expenses/${expRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: expEditKey,
        categoryCode: 'UTILITIES',
        amount: '20000',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-11-22',
        notes: 'ملاحظة أولى',
        referenceNumber: 'REF-001',
      }),
    });
    assert.equal(editExp1.status, 200);

    // Exact replay succeeds with 200
    const editExpReplay = await apiJson(`/api/expenses/${expRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: expEditKey,
        categoryCode: 'UTILITIES',
        amount: '20000',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-11-22',
        notes: 'ملاحظة أولى',
        referenceNumber: 'REF-001',
      }),
    });
    assert.equal(editExpReplay.status, 200);

    // Same idempotencyKey with different notes MUST fail with 409 Conflict
    const editExpConflictNotes = await apiJson(`/api/expenses/${expRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: expEditKey,
        categoryCode: 'UTILITIES',
        amount: '20000',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-11-22',
        notes: 'ملاحظة مختلفة',
        referenceNumber: 'REF-001',
      }),
    });
    assert.equal(editExpConflictNotes.status, 409);

    // Same idempotencyKey with different referenceNumber MUST fail with 409 Conflict
    const editExpConflictRef = await apiJson(`/api/expenses/${expRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: expEditKey,
        categoryCode: 'UTILITIES',
        amount: '20000',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: '2026-11-22',
        notes: 'ملاحظة أولى',
        referenceNumber: 'REF-999',
      }),
    });
    assert.equal(editExpConflictRef.status, 409);

    // =========================================================================
    // TEST 2 (P1): Cross-day supplier payment edit / method change / void matches ledger 1010/1020 per day
    // =========================================================================
    // Simulate Day 1 = 2026-11-25 (payment of 500 EGP) and Day 2 = 2026-11-26 (edit to 300 EGP, method switch, void)
    const day1 = '2026-11-25';
    const day2 = '2026-11-26';
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 25, 10, 0, 0) });

    // Record a 1000 EGP unpaid purchase, then pay 500 EGP on day1
    const p2Res = await apiJson('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: sup.body.id,
        storeId,
        idempotencyKey: randomUUID(),
        invoiceNumber: 'INV-CROSSDAY-001',
        totalAmount: '100000',
        paidAmount: '0',
        paymentMethod: 'CASH',
        items: [{
          variantId: (await apiJson('/api/data')).body.products[0].variants[0].id,
          quantity: '5',
          unitCost: '20000',
        }],
      }),
    });
    assert.equal(p2Res.status, 201);

    const payRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        amount: '50000', // 500.00 EGP
        paymentMethod: 'CASH',
      }),
    });
    assert.equal(payRes.status, 201);

    // Advance system clock to Day 2 (2026-11-26) and edit the payment from 500 EGP to 300 EGP
    t.mock.timers.setTime(Date.UTC(2026, 10, 26, 10, 0, 0));

    const editPayRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments/${payRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        amount: '30000', // 300.00 EGP
        paymentMethod: 'CASH',
      }),
    });
    assert.equal(editPayRes.status, 200);

    // Check Day 1 alone: Trial Balance 1010 net = -50000, P&L totalSupplierPaid = 50000, Financial Map supplier net out = 50000
    const tbDay1 = await apiJson(`/api/reports/trial-balance?storeId=${storeId}&from=${day1}&to=${day1}`);
    const acc1010Day1 = tbDay1.body.accounts.find((a) => a.accountCode === '1010');
    const net1010Day1 = BigInt(acc1010Day1.periodDebit.amount) - BigInt(acc1010Day1.periodCredit.amount);
    assert.equal(net1010Day1, -50000n);

    const plDay1 = await apiJson(`/api/reports/profit-loss?storeId=${storeId}&from=${day1}&to=${day1}`);
    assert.equal(plDay1.body.supplierPayments.totalPaid.amount, '50000');
    assert.equal(plDay1.body.cashPosition.supplierPayments.amount, '50000');

    const fmDay1 = await apiJson(`/api/reports/financial-map?storeId=${storeId}&from=${day1}&to=${day1}`);
    const fmDay1SupNetOut = fmDay1.body.timeline
      .filter((e) => e.type === 'SUPPLIER_PAYMENT')
      .reduce((s, e) => s + BigInt(e.amountOut) - BigInt(e.amountIn), 0n);
    assert.equal(fmDay1SupNetOut, 50000n);

    // Check Day 2 alone: Trial Balance 1010 net = +20000, P&L totalSupplierPaid = -20000, Financial Map supplier net out = -20000
    const tbDay2 = await apiJson(`/api/reports/trial-balance?storeId=${storeId}&from=${day2}&to=${day2}`);
    const acc1010Day2 = tbDay2.body.accounts.find((a) => a.accountCode === '1010');
    const net1010Day2 = BigInt(acc1010Day2.periodDebit.amount) - BigInt(acc1010Day2.periodCredit.amount);
    assert.equal(net1010Day2, 20000n);

    const plDay2 = await apiJson(`/api/reports/profit-loss?storeId=${storeId}&from=${day2}&to=${day2}`);
    assert.equal(plDay2.body.supplierPayments.totalPaid.amount, '-20000');
    assert.equal(plDay2.body.cashPosition.supplierPayments.amount, '-20000');

    const fmDay2 = await apiJson(`/api/reports/financial-map?storeId=${storeId}&from=${day2}&to=${day2}`);
    const fmDay2SupNetOut = fmDay2.body.timeline
      .filter((e) => e.type === 'SUPPLIER_PAYMENT')
      .reduce((s, e) => s + BigInt(e.amountOut) - BigInt(e.amountIn), 0n);
    assert.equal(fmDay2SupNetOut, -20000n);

    // Check Combined Day 1 + Day 2: net 1010 = -30000, P&L = 30000, Financial Map = 30000
    const tbBoth = await apiJson(`/api/reports/trial-balance?storeId=${storeId}&from=${day1}&to=${day2}`);
    const acc1010Both = tbBoth.body.accounts.find((a) => a.accountCode === '1010');
    assert.equal(BigInt(acc1010Both.periodDebit.amount) - BigInt(acc1010Both.periodCredit.amount), -30000n);
    const plBoth = await apiJson(`/api/reports/profit-loss?storeId=${storeId}&from=${day1}&to=${day2}`);
    assert.equal(plBoth.body.supplierPayments.totalPaid.amount, '30000');

    // Change payment method from CASH (1010) to ELECTRONIC (1020) on Day 2, then void it on Day 2
    const switchMethodRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments/${payRes.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        amount: '30000',
        paymentMethod: 'BANK_TRANSFER',
      }),
    });
    assert.equal(switchMethodRes.status, 200);

    const voidRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments/${payRes.body.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    assert.equal(voidRes.status, 200);

    // After void: combined Day 1 + Day 2 must reconcile to 0 across Trial Balance (1010 & 1020), P&L, and Financial Map
    const tbAfterVoid = await apiJson(`/api/reports/trial-balance?storeId=${storeId}&from=${day1}&to=${day2}`);
    const a1010Void = tbAfterVoid.body.accounts.find((a) => a.accountCode === '1010');
    const a1020Void = tbAfterVoid.body.accounts.find((a) => a.accountCode === '1020');
    assert.equal(BigInt(a1010Void.periodDebit.amount) - BigInt(a1010Void.periodCredit.amount), 0n);
    assert.equal(BigInt(a1020Void.periodDebit.amount) - BigInt(a1020Void.periodCredit.amount), 0n);

    const plAfterVoid = await apiJson(`/api/reports/profit-loss?storeId=${storeId}&from=${day1}&to=${day2}`);
    assert.equal(plAfterVoid.body.supplierPayments.totalPaid.amount, '0');
  } finally {
    t.mock.timers.reset();
    await app.shutdown();
    await cleanupTempDir(dataDir);
  }
});
