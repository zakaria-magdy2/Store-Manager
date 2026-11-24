import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServerApp } from '../server.mjs';
import { cleanupTempDir, createTestTempDir } from './e2e-server-harness.mjs';

const require = createRequire(new URL('../../../packages/infrastructure/package.json', import.meta.url));
const Database = require('better-sqlite3');

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

function signLicenseToken(privateKeyPem, payload) {
  const payloadB64u = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${payloadB64u}`;
  const sigB64u = sign(null, Buffer.from(signingInput, 'utf8'), privateKeyPem).toString('base64url');
  return `${signingInput}.${sigB64u}`;
}

test('P1/P2 financial audit fixes: cross-actor shift drawer movements, single-shift store guard, cross-day supplier payment edit/method/void across ledger & invoice details, and expense edit notes/ref conflict', async (t) => {
  const dataDir = await createTestTempDir('retailos-fin-audit-fixes-');
  const freePort = await getFreePort();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const machineId = 'ROS-ABCD-2345-WXYZ';

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
    licensePublicKey: publicKey,
    licenseIdentityProvider: () => ({ machineId, isHardwareBacked: true }),
  });

  const baseUrl = app.origin;
  let activeCookie = '';
  const apiJson = async (path, options = {}) => {
    const cookieToUse = options.cookie ?? activeCookie;
    const headers = {
      Origin: baseUrl,
      'Content-Type': 'application/json',
      ...(cookieToUse ? { Cookie: cookieToUse } : {}),
      ...(options.headers ?? {}),
    };
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const setCookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie };
  };

  try {
    // Activate license & setup OWNER account + separate CASHIER account
    const licToken = signLicenseToken(privateKey, {
      licenseId: randomUUID(),
      customerName: 'شركة اختبار المراجعة المالية',
      machineId,
      issuedAt: new Date(Date.now() - 86400_000).toISOString(),
      expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
      planName: 'الباقة السنوية',
    });
    const actRes = await apiJson('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify({ token: licToken }),
    });
    assert.equal(actRes.status, 200);

    const setupRes = await apiJson('/api/setup', {
      method: 'POST',
      body: JSON.stringify({
        ownerName: 'مدير المتجر',
        ownerUsername: 'owner_fin',
        password: 'OwnerPassword123!',
      }),
    });
    assert.equal(setupRes.status, 201);

    const ownerLogin = await apiJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_fin', password: 'OwnerPassword123!' }),
    });
    assert.equal(ownerLogin.status, 200);
    const ownerCookie = ownerLogin.cookie;
    activeCookie = ownerCookie;

    const bootData = await apiJson('/api/data', { cookie: ownerCookie });
    assert.equal(bootData.status, 200);
    const storeId = bootData.body.selectedStoreId;

    // Create a distinct CASHIER user assigned to the store
    const cashierCreate = await apiJson('/api/users', {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({
        username: 'cashier_fin',
        fullName: 'كاشير الوردية',
        password: 'CashierPassword123!',
        role: 'CASHIER',
        storeId,
      }),
    });
    assert.equal(cashierCreate.status, 201);

    const cashierLogin = await apiJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'cashier_fin', password: 'CashierPassword123!' }),
    });
    assert.equal(cashierLogin.status, 200);
    const cashierCookie = cashierLogin.cookie;

    // Setup category & supplier as OWNER
    const cat = await apiJson('/api/categories', { method: 'POST', cookie: ownerCookie, body: JSON.stringify({ name: 'أحذية' }) });
    assert.equal(cat.status, 201);
    const sup = await apiJson('/api/suppliers', { method: 'POST', cookie: ownerCookie, body: JSON.stringify({ name: 'مورد المراجعة' }) });
    assert.equal(sup.status, 201);

    // =========================================================================
    // TEST 1 (P1): Cross-actor shift drawer movements & single open shift per store
    // Cashier opens shift (1000 EGP); Owner attempts second shift (blocked 409);
    // Owner records drawer expense (100 EGP), cash supplier payment (200 EGP),
    // and treasury transfer (150 EGP). Cashier closes at 550 EGP -> variance = 0!
    // =========================================================================
    const shiftStart = await apiJson('/api/shifts/start', {
      method: 'POST',
      cookie: cashierCookie,
      body: JSON.stringify({ storeId, openingCash: '100000' }), // 1000.00 EGP opened by CASHIER
    });
    assert.equal(shiftStart.status, 201);

    // Owner cannot open a second shift in the same store while cashier's shift is OPEN
    const secondShiftAttempt = await apiJson('/api/shifts/start', {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ storeId, openingCash: '50000' }),
    });
    assert.equal(secondShiftAttempt.status, 409);

    // 1a. OWNER (different user!) records 100 EGP expense from CASH_DRAWER during cashier's shift
    const expRes = await apiJson('/api/expenses', {
      method: 'POST',
      cookie: ownerCookie,
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

    // Cashier queries their open shift -> expectedCash = 1000 - 100 = 900 EGP (90000 piasters)
    const curShiftAfterExp = await apiJson('/api/shifts/current', { cookie: cashierCookie });
    assert.equal(curShiftAfterExp.status, 200);
    assert.equal(curShiftAfterExp.body.currentShift.expectedCash, '90000');
    assert.equal(curShiftAfterExp.body.currentShift.cashExpenses, '10000');

    // 1b. OWNER records purchase (1000 EGP total, 200 EGP paid CASH from drawer) -> expected = 700 EGP
    const purchaseRes = await apiJson('/api/purchases', {
      method: 'POST',
      cookie: ownerCookie,
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

    const curShiftAfterSup = await apiJson('/api/shifts/current', { cookie: cashierCookie });
    assert.equal(curShiftAfterSup.body.currentShift.expectedCash, '70000');
    assert.equal(curShiftAfterSup.body.currentShift.cashSupplierPayments, '20000');

    // 1c. OWNER records treasury transfer from drawer (1010) to safe (1015) of 150 EGP -> expected = 550 EGP
    const transferRes = await apiJson('/api/accounting/treasury-transfer', {
      method: 'POST',
      cookie: ownerCookie,
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

    const curShiftAfterTransfer = await apiJson('/api/shifts/current', { cookie: cashierCookie });
    assert.equal(curShiftAfterTransfer.body.currentShift.expectedCash, '55000');
    assert.equal(curShiftAfterTransfer.body.currentShift.cashTransfersNet, '-15000');

    // 1d. OWNER (different user!) rings up a CASH POS sale (350 EGP) and processes a CASH customer return
    // wait: let's also verify Owner can checkout while Cashier's shift is open in the store!
    const dataForSale = await apiJson('/api/data', { cookie: ownerCookie });
    const shoeVariantId = dataForSale.body.products[0].variants[0].id;
    const ownerSaleInCashierShift = await apiJson('/api/checkout', {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({
        storeId,
        idempotencyKey: randomUUID(),
        items: [{ variantId: shoeVariantId, quantity: '2' }], // 2 * 350 = 700.00 EGP (70000)
        paymentMethod: 'CASH',
        amountPaidMinor: '70000',
      }),
    });
    assert.equal(ownerSaleInCashierShift.status, 201);

    // And OWNER processes a 1-unit CASH customer return (350.00 EGP = 35000) during Cashier's open shift
    const ownerReturnInCashierShift = await apiJson(`/api/sales/${ownerSaleInCashierShift.body.id}/returns`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({
        storeId,
        idempotencyKey: randomUUID(),
        paymentMethod: 'CASH',
        items: [{ originalSaleItemId: ownerSaleInCashierShift.body.items[0].id, quantity: '1' }],
      }),
    });
    assert.equal(ownerReturnInCashierShift.status, 201);

    // Expected drawer cash = 55000 + 70000 (cash sale) - 35000 (cash return) = 90000
    const curShiftAfterOwnerSaleReturn = await apiJson('/api/shifts/current', { cookie: cashierCookie });
    assert.equal(curShiftAfterOwnerSaleReturn.body.currentShift.cashSales, '70000');
    assert.equal(curShiftAfterOwnerSaleReturn.body.currentShift.cashReturns, '35000');
    assert.equal(curShiftAfterOwnerSaleReturn.body.currentShift.expectedCash, '90000');

    // Verify /api/shifts shows 90000 while open
    const historyOpen = await apiJson(`/api/shifts?storeId=${storeId}`, { cookie: ownerCookie });
    assert.equal(historyOpen.status, 200);
    assert.equal(historyOpen.body.shifts[0].expectedCash, '90000');

    // 1e. CASHIER closes shift with actualCash = 90000 -> variance MUST be 0!
    const closeRes = await apiJson('/api/shifts/end', {
      method: 'POST',
      cookie: cashierCookie,
      body: JSON.stringify({
        shiftId: shiftStart.body.shift.id,
        actualCash: '90000',
        handoverCash: '90000',
      }),
    });
    assert.equal(closeRes.status, 200);
    assert.equal(closeRes.body.shift.expectedCash, '90000');
    assert.equal(closeRes.body.shift.variance, '0');

    // =========================================================================
    // TEST 3 (P2): Expense edit idempotency rejects conflicting notes / referenceNumber with 409
    // =========================================================================
    const expEditKey = randomUUID();
    const editExp1 = await apiJson(`/api/expenses/${expRes.body.id}`, {
      method: 'PATCH',
      cookie: ownerCookie,
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
      cookie: ownerCookie,
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
      cookie: ownerCookie,
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
      cookie: ownerCookie,
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
    // TEST 2 (P1): Cross-day supplier payment edit / method change / void matches
    // ledger 1010/1020 per day AND invoice details / payment history / purchase report
    // =========================================================================
    const day1 = '2026-11-25';
    const day2 = '2026-11-26';
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 25, 10, 0, 0) });
    let dayOwnerCookie = (await apiJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_fin', password: 'OwnerPassword123!' }),
    })).cookie;

    // Record a 1000 EGP unpaid purchase, then pay 500 EGP on day1
    const p2Res = await apiJson('/api/purchases', {
      method: 'POST',
      cookie: dayOwnerCookie,
      body: JSON.stringify({
        supplierId: sup.body.id,
        storeId,
        idempotencyKey: randomUUID(),
        invoiceNumber: 'INV-CROSSDAY-001',
        totalAmount: '100000',
        paidAmount: '0',
        paymentMethod: 'CASH',
        items: [{
          variantId: (await apiJson('/api/data', { cookie: dayOwnerCookie })).body.products[0].variants[0].id,
          quantity: '5',
          unitCost: '20000',
        }],
      }),
    });
    assert.equal(p2Res.status, 201);

    const payRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments`, {
      method: 'POST',
      cookie: dayOwnerCookie,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        amount: '50000', // 500.00 EGP
        paymentMethod: 'CASH',
      }),
    });
    assert.equal(payRes.status, 201);

    // Advance system clock to Day 2 (2026-11-26) and edit the payment from 500 EGP to 300 EGP
    t.mock.timers.setTime(Date.UTC(2026, 10, 26, 10, 0, 0));
    dayOwnerCookie = (await apiJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_fin', password: 'OwnerPassword123!' }),
    })).cookie;
    activeCookie = dayOwnerCookie;

    const editPayRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments/${payRes.body.id}`, {
      method: 'PATCH',
      cookie: dayOwnerCookie,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        amount: '30000', // 300.00 EGP
        paymentMethod: 'CASH',
      }),
    });
    assert.equal(editPayRes.status, 200);

    // Verify invoice details & payment history view in /api/data reflects edited amount + original paidAt + updatedAt
    const dataAfterEdit = await apiJson('/api/data');
    const p2Entry = dataAfterEdit.body.suppliers[0].purchases.find((p) => p.id === p2Res.body.id);
    assert.ok(p2Entry);
    assert.equal(p2Entry.paidAmount.amount, '30000');
    assert.equal(p2Entry.remainingAmount.amount, '70000');
    assert.equal(p2Entry.payments.length, 1);
    assert.equal(p2Entry.payments[0].id, payRes.body.id);
    assert.equal(p2Entry.payments[0].amount.amount, '30000');
    assert.ok(String(p2Entry.payments[0].paidAt).startsWith(day1));
    assert.ok(String(p2Entry.payments[0].updatedAt).startsWith(day2));

    // Verify /api/reports/purchases reflects updated paidAmount & balanceDue
    const purReportAfterEdit = await apiJson(`/api/reports/purchases?storeId=${storeId}&from=${day1}&to=${day2}`);
    assert.equal(purReportAfterEdit.status, 200);
    assert.equal(purReportAfterEdit.body.suppliers[0].paidAmount.amount, '30000');
    assert.equal(purReportAfterEdit.body.suppliers[0].balanceDue.amount, '70000');

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

    // Change payment method from CASH (1010) to BANK_TRANSFER (1020) on Day 2, then void it on Day 2
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

    // After void: invoice details show 0 active payments, 0 paidAmount, 100000 remainingAmount
    const dataAfterVoid = await apiJson('/api/data');
    const p2AfterVoid = dataAfterVoid.body.suppliers[0].purchases.find((p) => p.id === p2Res.body.id);
    assert.equal(p2AfterVoid.paidAmount.amount, '0');
    assert.equal(p2AfterVoid.remainingAmount.amount, '100000');
    assert.equal(p2AfterVoid.payments.length, 0);

    // After void: combined Day 1 + Day 2 must reconcile to 0 across Trial Balance (1010 & 1020), P&L, and Financial Map
    const tbAfterVoid = await apiJson(`/api/reports/trial-balance?storeId=${storeId}&from=${day1}&to=${day2}`);
    const a1010Void = tbAfterVoid.body.accounts.find((a) => a.accountCode === '1010');
    const a1020Void = tbAfterVoid.body.accounts.find((a) => a.accountCode === '1020');
    assert.equal(BigInt(a1010Void.periodDebit.amount) - BigInt(a1010Void.periodCredit.amount), 0n);
    assert.equal(BigInt(a1020Void.periodDebit.amount) - BigInt(a1020Void.periodCredit.amount), 0n);

    const plAfterVoid = await apiJson(`/api/reports/profit-loss?storeId=${storeId}&from=${day1}&to=${day2}`);
    assert.equal(plAfterVoid.body.supplierPayments.totalPaid.amount, '0');

    // =========================================================================
    // TEST 5 (P1): Supplier payment & audit log are atomic inside one DB transaction
    // Inject a fault into audit_logs for SUPPLIER_PAYMENT_RECORDED -> payment & journal roll back completely!
    // Removing the fault and retrying with the exact same idempotencyKey succeeds and writes the audit log.
    // =========================================================================
    const faultDb = new Database(app.databasePath);
    const atomicPayIdemKey = randomUUID();
    try {
      const paymentsCountBefore = faultDb.prepare('SELECT COUNT(*) AS cnt FROM supplier_payments WHERE purchase_id = ?').get(p2Res.body.id).cnt;
      const journalsCountBefore = faultDb.prepare('SELECT COUNT(*) AS cnt FROM journal_entries').get().cnt;

      faultDb.exec(`
        CREATE TRIGGER trg_test_fail_supplier_payment_audit
        BEFORE INSERT ON audit_logs
        WHEN NEW.action = 'SUPPLIER_PAYMENT_RECORDED'
        BEGIN
          SELECT RAISE(ABORT, 'injected audit_logs failure for supplier payment');
        END;
      `);

      const failedPayRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments`, {
        method: 'POST',
        cookie: dayOwnerCookie,
        body: JSON.stringify({
          idempotencyKey: atomicPayIdemKey,
          amount: '25000',
          paymentMethod: 'CASH',
        }),
      });
      // SQLite RAISE(ABORT) produces SQLITE_CONSTRAINT_TRIGGER, mapped to 409 Conflict by server.mjs.
      assert.equal(failedPayRes.status, 409);

      // Verify 100% atomic rollback: zero new rows in supplier_payments and zero new rows in journal_entries
      const paymentsCountAfterFail = faultDb.prepare('SELECT COUNT(*) AS cnt FROM supplier_payments WHERE purchase_id = ?').get(p2Res.body.id).cnt;
      const journalsCountAfterFail = faultDb.prepare('SELECT COUNT(*) AS cnt FROM journal_entries').get().cnt;
      assert.equal(paymentsCountAfterFail, paymentsCountBefore);
      assert.equal(journalsCountAfterFail, journalsCountBefore);

      // Remove fault trigger and retry with the EXACT SAME idempotencyKey
      faultDb.exec('DROP TRIGGER trg_test_fail_supplier_payment_audit;');
    } finally {
      faultDb.close();
    }

    const retriedPayRes = await apiJson(`/api/purchases/${p2Res.body.id}/payments`, {
      method: 'POST',
      cookie: dayOwnerCookie,
      body: JSON.stringify({
        idempotencyKey: atomicPayIdemKey,
        amount: '25000',
        paymentMethod: 'CASH',
      }),
    });
    assert.equal(retriedPayRes.status, 201);

    const auditAfterRetry = await apiJson('/api/audit-logs?action=SUPPLIER_PAYMENT_RECORDED&limit=10', { cookie: dayOwnerCookie });
    assert.equal(auditAfterRetry.status, 200);
    assert.equal(auditAfterRetry.body.chainVerification.valid, true);
    assert.ok(auditAfterRetry.body.entries.some((e) => e.entityId === retriedPayRes.body.id && e.action === 'SUPPLIER_PAYMENT_RECORDED'));
  } finally {
    t.mock.timers.reset();
    await app.shutdown();
    await cleanupTempDir(dataDir);
  }
});
