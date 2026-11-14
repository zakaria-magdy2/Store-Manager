import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(dirname(appDir));
let serverProcess;
let dataDir;
let baseUrl;
let cookie;
let serverLog = '';

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`App server exited with ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) return;
    } catch { /* Wait until the local server is listening. */ }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('App server did not become ready');
}

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const headers = { Origin: baseUrl };
  if (body) headers['Content-Type'] = 'application/json';
  if (authenticated && cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  return { response, payload };
}

before(async () => {
  dataDir = await mkdtemp(join(appDir, '.test-data-'));
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(appDir, 'server.mjs')], {
    cwd: workspace,
    env: { ...process.env, PORT: String(port), RETAILOS_DATA_DIR: dataDir, RETAILOS_COMPANY_NAME: 'متجر الاختبار', RETAILOS_COMPANY_CODE: 'RETAIL_TEST', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع الرئيسي' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serverProcess.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  await waitForApp().catch((error) => { throw new Error(`${error.message}\n${serverLog}`); });
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await Promise.race([once(serverProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('configured store, owner account, supplier ledger, products, stock receipt, and checkout persist in SQLite', async () => {
  const initial = await request('/api/bootstrap', { authenticated: false });
  assert.equal(initial.payload.configured, true);
  assert.equal(initial.payload.setupRequired, true);
  assert.equal(initial.payload.companyName, 'متجر الاختبار');

  const setup = await request('/api/setup', {
    method: 'POST',
    authenticated: false,
    body: {
      ownerUsername: 'owner_test', ownerName: 'مدير الاختبار', password: 'A-Long-Test-Password-2026',
    },
  });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));

  const login = await request('/api/login', {
    method: 'POST', authenticated: false,
    body: { username: 'owner_test', password: 'A-Long-Test-Password-2026' },
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.payload));
  assert.match(login.response.headers.get('set-cookie') ?? '', /HttpOnly/);
  cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0];
  const unauthenticatedBackup = await request('/api/backups/export', { method: 'POST', authenticated: false, body: { passphrase: 'a-strong-backup-passphrase' } });
  assert.equal(unauthenticatedBackup.response.status, 401);

  const encryptedBackupResponse = await fetch(`${baseUrl}/api/backups/export`, { method: 'POST', headers: { Origin: baseUrl, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'a-strong-backup-passphrase' }) });
  assert.equal(encryptedBackupResponse.status, 200);
  assert.match(encryptedBackupResponse.headers.get('content-disposition') ?? '', /attachment/);
  const encryptedBackup = Buffer.from(await encryptedBackupResponse.arrayBuffer());
  assert.equal(encryptedBackup.subarray(0, 5).toString(), 'RFBK1');
  assert.ok(encryptedBackup.length > 1000);
  const rejectedRestore = await fetch(`${baseUrl}/api/backups/restore`, { method: 'POST', headers: { Origin: baseUrl, Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': Buffer.from('a-strong-test-passphrase').toString('base64url'), 'X-RetailOS-Restore-Confirm': 'replace' }, body: Buffer.from('not a backup') });
  assert.equal(rejectedRestore.status, 400);
  assert.equal((await request('/api/data')).response.status, 200);

  const unauthenticated = await request('/api/data', { authenticated: false });
  assert.equal(unauthenticated.response.status, 401);

  const createdProduct = await request('/api/products', {
    method: 'POST',
    body: { name: 'قهوة اختبار', sku: 'COFFEE-TEST', variants: [{ sku: 'COFFEE-TEST-1', retailPrice: '12500', reorderPoint: '1' }] },
  });
  assert.equal(createdProduct.response.status, 201, JSON.stringify(createdProduct.payload));
  const sizedProduct = await request('/api/products', {
    method: 'POST',
    body: {
      name: 'Shirt',
      sku: 'SHIRT-TEST',
      options: [
        { key: 'size', name: 'المقاس', values: ['S', 'M'] },
        { key: 'color', name: 'اللون', values: ['Black', 'White'] },
      ],
      variants: [
        { sku: 'SHIRT-TEST-01', attributes: { size: 'S', color: 'Black' }, retailPrice: '8000', reorderPoint: '2' },
        { sku: 'SHIRT-TEST-02', attributes: { size: 'M', color: 'Black' }, retailPrice: '8000', reorderPoint: '2' },
        { sku: 'SHIRT-TEST-03', attributes: { size: 'S', color: 'White' }, retailPrice: '8000', reorderPoint: '2' },
        { sku: 'SHIRT-TEST-04', attributes: { size: 'M', color: 'White' }, retailPrice: '8500', reorderPoint: '2' },
      ],
    },
  });
  assert.equal(sizedProduct.response.status, 201, JSON.stringify(sizedProduct.payload));
  const createdService = await request('/api/products', {
    method: 'POST',
    body: { name: 'توصيل منزلي', sku: 'DELIVERY-TEST', itemKind: 'SERVICE', variants: [{ sku: 'DELIVERY-TEST-1', retailPrice: '3000', reorderPoint: '0' }] },
  });
  assert.equal(createdService.response.status, 201, JSON.stringify(createdService.payload));

  let data = await request('/api/data');
  assert.equal(data.response.status, 200, `${JSON.stringify(data.payload)}\n${serverLog}`);
  const product = data.payload.products.find((item) => item.id === createdProduct.payload.id);
  assert.ok(product);
  const productWithSizes = data.payload.products.find((item) => item.id === sizedProduct.payload.id);
  assert.deepEqual(productWithSizes.variants.map((item) => `${item.attributes.size}/${item.attributes.color}`), ['S/Black', 'M/Black', 'S/White', 'M/White']);
  assert.equal(productWithSizes.variants[3].price.amount, '8500');
  const expandedSizedProduct = await request(`/api/products/${sizedProduct.payload.id}`, {
    method: 'PATCH',
    body: {
      name: 'Shirt',
      sku: 'SHIRT-TEST',
      categoryId: null,
      options: [
        { key: 'size', name: 'المقاس', values: ['S', 'M', 'L'] },
        { key: 'color', name: 'اللون', values: ['Black', 'White', 'Navy'] },
      ],
      variants: [
        ...productWithSizes.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          barcode: v.barcode,
          attributes: v.attributes,
          retailPrice: v.price.amount,
          reorderPoint: v.reorderPoint,
        })),
        { sku: 'SHIRT-TEST-NVY-L', barcode: '2001234567893', attributes: { size: 'L', color: 'Navy' }, retailPrice: '8500', reorderPoint: '2' },
      ],
    },
  });
  assert.equal(expandedSizedProduct.response.status, 200, JSON.stringify(expandedSizedProduct.payload));
  data = await request('/api/data');
  const updatedSizedProduct = data.payload.products.find((item) => item.id === sizedProduct.payload.id);
  assert.equal(updatedSizedProduct.variants.length, 5);
  assert.ok(updatedSizedProduct.variants.some((v) => v.sku === 'SHIRT-TEST-NVY-L' && v.barcode === '2001234567893'));

  // Verify product metadata, image upload data URL, and variant retail price updates persist via PATCH
  const sampleImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const rejectedSvgProduct = await request('/api/products', {
    method: 'POST',
    body: {
      name: 'Unsafe SVG Product',
      sku: 'SVG-BAD',
      imagePath: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      variants: [{ sku: 'SVG-BAD-1', retailPrice: '1000', reorderPoint: '1' }],
    },
  });
  assert.equal(rejectedSvgProduct.response.status, 400);

  const editedSizedProduct = await request(`/api/products/${sizedProduct.payload.id}`, {
    method: 'PATCH',
    body: {
      name: 'Shirt Updated',
      sku: 'SHIRT-TEST-V2',
      categoryId: null,
      brand: 'BrandUpdated',
      description: 'Updated model description',
      imagePath: sampleImageDataUrl,
      options: updatedSizedProduct.options,
      variants: updatedSizedProduct.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        attributes: v.attributes,
        retailPrice: '9200',
        reorderPoint: '5',
      })),
    },
  });
  assert.equal(editedSizedProduct.response.status, 200, JSON.stringify(editedSizedProduct.payload));
  data = await request('/api/data');
  const reloadedEditedProduct = data.payload.products.find((item) => item.id === sizedProduct.payload.id);
  assert.equal(reloadedEditedProduct.name, 'Shirt Updated');
  assert.equal(reloadedEditedProduct.sku, 'SHIRT-TEST-V2');
  assert.equal(reloadedEditedProduct.brand, 'BrandUpdated');
  assert.equal(reloadedEditedProduct.description, 'Updated model description');
  assert.equal(reloadedEditedProduct.imagePath, sampleImageDataUrl);
  assert.ok(reloadedEditedProduct.variants.every((v) => v.price.amount === '9200' && v.reorderPoint === '5'));
  assert.equal(data.payload.products.find((item) => item.id === createdService.payload.id).itemKind, 'PRODUCT');
  const variant = product.variants[0];
  const storeId = data.payload.selectedStoreId;

  assert.equal(data.payload.capabilities.canManageUsers, true);
  const createdManager = await request('/api/users', { method: 'POST', body: { username: 'manager_test', password: 'Manager-Test-Password-2026', fullName: 'Test Manager', role: 'STORE_MANAGER', storeId } });
  assert.equal(createdManager.response.status, 201, JSON.stringify(createdManager.payload));
  const ownerCookie = cookie;
  const managerLogin = await request('/api/login', { method: 'POST', authenticated: false, body: { username: 'manager_test', password: 'Manager-Test-Password-2026' } });
  assert.equal(managerLogin.response.status, 200, JSON.stringify(managerLogin.payload));
  cookie = (managerLogin.response.headers.get('set-cookie') ?? '').split(';')[0];
  const managerData = await request('/api/data');
  assert.equal(managerData.payload.capabilities.canManageUsers, true);
  const createdCashier = await request('/api/users', { method: 'POST', body: { username: 'cashier_test', password: 'Cashier-Test-Password-2026', fullName: 'Test Cashier', phone: '+201012345678', employmentStartDate: '2024-02-01', role: 'CASHIER', storeId } });
  assert.equal(createdCashier.response.status, 201, JSON.stringify(createdCashier.payload));
  const cashierLogin = await request('/api/login', { method: 'POST', authenticated: false, body: { username: 'cashier_test', password: 'Cashier-Test-Password-2026' } });
  assert.equal(cashierLogin.response.status, 200, JSON.stringify(cashierLogin.payload));
  cookie = (cashierLogin.response.headers.get('set-cookie') ?? '').split(';')[0];
  const cashierData = await request('/api/data');
  assert.equal(cashierData.payload.capabilities.cashierMode, true);
  assert.equal(cashierData.payload.capabilities.canManageUsers, false);
  assert.equal(cashierData.payload.capabilities.canViewAccounting, false);
  assert.equal(cashierData.payload.capabilities.canViewExpenses, false);
  assert.equal(cashierData.payload.capabilities.canRefund, false);
  assert.equal((await request('/api/reports/top-products')).response.status, 403);
  assert.equal((await request('/api/audit-logs')).response.status, 403);
  assert.equal(cashierData.payload.suppliers.length, 0);
  assert.equal(cashierData.payload.accountingEntries.length, 0);
  assert.equal(cashierData.payload.expenses.length, 0);
  assert.equal(cashierData.payload.monthlyExpenses.length, 0);
  assert.equal(cashierData.payload.products.find((item) => item.id === createdProduct.payload.id).variants[0].wac, null);
  assert.equal((await request('/api/users', { method: 'POST', body: { username: 'blocked_staff', password: 'Blocked-Password-2026', fullName: 'Blocked Staff', role: 'CASHIER', storeId } })).response.status, 403);
  assert.notEqual((await request('/api/products', { method: 'POST', body: { name: 'Forbidden', sku: 'FORBIDDEN', variants: [{ sku: 'FORBIDDEN-1', retailPrice: '100', reorderPoint: '0' }] } })).response.status, 201);
  assert.equal((await request('/api/expenses', { method: 'POST', body: { idempotencyKey: 'e1c5bfee-0771-480d-8ae3-873a7b306671', storeId, categoryCode: 'UTILITIES', amount: '100', paymentMethod: 'CASH_DRAWER', expenseDate: '2026-11-04' } })).response.status, 403);
  assert.equal((await request('/api/inventory/receive', { method: 'POST', body: { storeId, variantId: '00000000-0000-4000-8000-000000000000', quantity: '1', unitCost: '1', currency: 'EGP' } })).response.status, 403);

  // Cashier shift permissions and workflow
  assert.equal((await request('/api/shifts')).response.status, 403, 'Cashier must be blocked from general shifts page');
  const cashierVariantId = cashierData.payload.products.find((item) => item.id === createdProduct.payload.id).variants[0].id;
  const blockedCheckoutWithoutShift = await request('/api/checkout', {
    method: 'POST',
    body: {
      storeId,
      idempotencyKey: 'e2f6a68f-036d-4f05-a47c-c3157d4c6df5',
      items: [{ variantId: cashierVariantId, quantity: '1' }],
      payment: { method: 'CASH', amount: '12500' },
    },
  });
  assert.equal(blockedCheckoutWithoutShift.response.status, 403, 'Cashier must be blocked from checkout without an active shift');
  const cashierShiftStart = await request('/api/shifts/start', { method: 'POST', body: { storeId, openingCash: '25000' } });
  assert.equal(cashierShiftStart.response.status, 201, JSON.stringify(cashierShiftStart.payload));
  const startedShiftId = cashierShiftStart.payload.shift.id;

  const currentShiftRes = await request('/api/shifts/current');
  assert.equal(currentShiftRes.response.status, 200);
  assert.equal(currentShiftRes.payload.currentShift?.id, startedShiftId);
  assert.equal(currentShiftRes.payload.currentShift?.openingCash, '25000');

  assert.equal((await request(`/api/shifts/${startedShiftId}/sales`)).response.status, 403, 'Cashier must be blocked from shift sales breakdown');

  const cashierShiftEnd = await request('/api/shifts/end', { method: 'POST', body: { shiftId: startedShiftId, actualCash: '25000', handoverCash: '25000' } });
  assert.equal(cashierShiftEnd.response.status, 200, JSON.stringify(cashierShiftEnd.payload));
  assert.equal(cashierShiftEnd.payload.shift.status, 'CLOSED');
  assert.equal((await request('/api/shifts/current')).payload.currentShift, null);

  cookie = (managerLogin.response.headers.get('set-cookie') ?? '').split(';')[0];
  const managerRoleEscalation = await request('/api/users', { method: 'POST', body: { username: 'auditor_test', password: 'Auditor-Test-Password-2026', fullName: 'Test Auditor', role: 'AUDITOR' } });
  assert.equal(managerRoleEscalation.response.status, 403);
  const cashierRoleEscalation = await request(`/api/users/${createdCashier.payload.id}`, { method: 'PATCH', body: { role: 'STORE_MANAGER', storeId, isActive: true } });
  assert.equal(cashierRoleEscalation.response.status, 403);
  assert.equal((await request('/api/audit-logs')).response.status, 403);
  cookie = ownerCookie;
  data = await request('/api/data');
  assert.ok(data.payload.users.some((item) => item.id === createdManager.payload.id && item.role === 'STORE_MANAGER'));
  const cashierRecord = data.payload.users.find((item) => item.id === createdCashier.payload.id && item.role === 'CASHIER');
  assert.ok(cashierRecord);
  assert.equal(cashierRecord.phone, '+201012345678');
  assert.equal(cashierRecord.employmentStartDate, '2024-02-01');
  assert.ok(cashierRecord.createdAt);
  const updateEmployeeProfile = await request(`/api/users/${createdCashier.payload.id}`, { method: 'PATCH', body: { phone: '01099998888', employmentStartDate: '2024-03-01' } });
  assert.equal(updateEmployeeProfile.response.status, 200);
  data = await request('/api/data');
  assert.equal(data.payload.users.find((item) => item.id === createdCashier.payload.id).phone, '01099998888');
  assert.equal(data.payload.users.find((item) => item.id === createdCashier.payload.id).employmentStartDate, '2024-03-01');

  const supplier = await request('/api/suppliers', { method: 'POST', body: { name: 'تاجر الاختبار', phone: '01000000000' } });
  assert.equal(supplier.response.status, 201, JSON.stringify(supplier.payload));
  const rejectedPurchase = await request('/api/purchases', { method: 'POST', body: { idempotencyKey: '8e25e905-32a0-4e26-8622-582c143f9a13', supplierId: supplier.payload.id, storeId, totalAmount: '1000', paidAmount: '500', items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: '1', unitCost: '1000' }] } });
  assert.equal(rejectedPurchase.response.status, 400);
  data = await request('/api/data');
  assert.equal(data.payload.suppliers[0].purchases.length, 0);
  assert.equal(data.payload.products.find((item) => item.id === product.id).variants[0].quantity, '0');
  const purchaseBody = { idempotencyKey: '32b03451-2015-4e59-935b-b8ff68c8b27d', supplierId: supplier.payload.id, storeId, invoiceNumber: 'INV-77', totalAmount: '14000', paidAmount: '4000', items: [{ variantId: variant.id, quantity: '2', unitCost: '7000' }] };
  const purchase = await request('/api/purchases', { method: 'POST', body: purchaseBody });
  assert.equal(purchase.response.status, 201, JSON.stringify(purchase.payload));
  const purchaseReplay = await request('/api/purchases', { method: 'POST', body: purchaseBody });
  assert.equal(purchaseReplay.response.status, 201, JSON.stringify(purchaseReplay.payload));
  const paymentBody = { idempotencyKey: '66a9f488-3eb5-4d93-b1a3-78539e2d2cd7', amount: '5000', paymentMethod: 'CASH' };
  const payment = await request(`/api/purchases/${purchase.payload.id}/payments`, { method: 'POST', body: paymentBody });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.payload));
  const paymentReplay = await request(`/api/purchases/${purchase.payload.id}/payments`, { method: 'POST', body: paymentBody });
  assert.equal(paymentReplay.response.status, 201, JSON.stringify(paymentReplay.payload));
  const overpayment = await request(`/api/purchases/${purchase.payload.id}/payments`, { method: 'POST', body: { idempotencyKey: '0130a09f-e12e-40c8-99c3-0ab1c7ca2ce6', amount: '6000', paymentMethod: 'CASH' } });
  assert.equal(overpayment.response.status, 400);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const previousMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 4)).toISOString().slice(0, 10);
  const daysInCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayZeroIndex = now.getUTCDate() - 1;
  const expectedDailyMonthlyExpense = (40000n / BigInt(daysInCurrentMonth)) + (dayZeroIndex < Number(40000n % BigInt(daysInCurrentMonth)) ? 1n : 0n);

  const expenseBody = { idempotencyKey: '41148f0d-f50c-4f62-8d9c-b3de2c36e7f6', storeId, categoryCode: 'UTILITIES', amount: '1750', paymentMethod: 'CASH_DRAWER', expenseDate: today, notes: 'فاتورة كهرباء' };
  const expense = await request('/api/expenses', { method: 'POST', body: expenseBody });
  assert.equal(expense.response.status, 201, JSON.stringify(expense.payload));
  const expenseReplay = await request('/api/expenses', { method: 'POST', body: expenseBody });
  assert.equal(expenseReplay.response.status, 201, JSON.stringify(expenseReplay.payload));
  const expenseKeyConflict = await request('/api/expenses', { method: 'POST', body: { ...expenseBody, amount: '2000' } });
  assert.equal(expenseKeyConflict.response.status, 409);

  const monthlyPeriod = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const obligationBody = { idempotencyKey: '45ce6cec-d82c-4b19-99c3-7d252c8901b8', storeId, categoryCode: 'RENT', name: 'إيجار المحل', dueDay: 5 };
  const obligation = await request('/api/recurring-expenses', { method: 'POST', body: obligationBody });
  assert.equal(obligation.response.status, 201, JSON.stringify(obligation.payload));
  const obligationReplay = await request('/api/recurring-expenses', { method: 'POST', body: obligationBody });
  assert.equal(obligationReplay.response.status, 201, JSON.stringify(obligationReplay.payload));
  const actualBody = { ...monthlyPeriod, amount: '40000' };
  const actual = await request(`/api/recurring-expenses/${obligation.payload.id}/actual`, { method: 'POST', body: actualBody });
  assert.equal(actual.response.status, 201, JSON.stringify(actual.payload));
  const actualReplay = await request(`/api/recurring-expenses/${obligation.payload.id}/actual`, { method: 'POST', body: actualBody });
  assert.equal(actualReplay.payload.id, actual.payload.id);
  const conflictingActual = await request(`/api/recurring-expenses/${obligation.payload.id}/actual`, { method: 'POST', body: { ...actualBody, amount: '41000' } });
  assert.equal(conflictingActual.response.status, 409);
  const monthlyPaymentBody = { idempotencyKey: '6ad40716-5b68-49e3-aa24-9e415ee5a54c', amount: '10000', paymentMethod: 'CASH_SAFE', referenceNumber: 'RENT-1' };
  const monthlyPayment = await request(`/api/monthly-expenses/${actual.payload.id}/payments`, { method: 'POST', body: monthlyPaymentBody });
  assert.equal(monthlyPayment.response.status, 201, JSON.stringify(monthlyPayment.payload));
  assert.equal(monthlyPayment.payload.remaining, '30000');
  const monthlyPaymentReplay = await request(`/api/monthly-expenses/${actual.payload.id}/payments`, { method: 'POST', body: monthlyPaymentBody });
  assert.equal(monthlyPaymentReplay.response.status, 201, JSON.stringify(monthlyPaymentReplay.payload));
  const monthlyOverpayment = await request(`/api/monthly-expenses/${actual.payload.id}/payments`, { method: 'POST', body: { ...monthlyPaymentBody, idempotencyKey: '53089cb0-5731-41ac-8768-e59e13c8477a', amount: '31000' } });
  assert.equal(monthlyOverpayment.response.status, 400);

  const deprecatedDirectReceive = await request('/api/inventory/receive', {
    method: 'POST',
    body: { storeId, variantId: variant.id, quantity: '3', unitCost: '9000', currency: 'EGP', sourceId: purchase.payload.id },
  });
  assert.equal(deprecatedDirectReceive.response.status, 410, JSON.stringify(deprecatedDirectReceive.payload));

  const secondPurchase = await request('/api/purchases', {
    method: 'POST',
    body: {
      idempotencyKey: 'a44a62d8-8f2a-4c36-9f6a-2c4d9f1b90e1',
      supplierId: supplier.payload.id,
      storeId,
      invoiceNumber: 'INV-78',
      totalAmount: '27000',
      paidAmount: '27000',
      items: [{ variantId: variant.id, quantity: '3', unitCost: '9000' }],
    },
  });
  assert.equal(secondPurchase.response.status, 201, JSON.stringify(secondPurchase.payload));
  data = await request('/api/data');
  assert.equal(data.payload.products.find((item) => item.id === product.id).variants[0].quantity, '5');

  const blockedOwnerCheckout = await request('/api/checkout', {
    method: 'POST',
    body: {
      storeId,
      idempotencyKey: 'f8d2651b-e1cd-4da7-9e55-6eab7581886f',
      items: [{ variantId: variant.id, quantity: '1' }],
      payment: { method: 'CASH', amount: '12500' },
    },
  });
  assert.equal(blockedOwnerCheckout.response.status, 403, 'Owner must also start a shift before checkout');
  const ownerShiftStart = await request('/api/shifts/start', { method: 'POST', body: { storeId, openingCash: '10000' } });
  assert.equal(ownerShiftStart.response.status, 201, JSON.stringify(ownerShiftStart.payload));

  const sale = await request('/api/checkout', {
    method: 'POST',
    body: {
      storeId,
      idempotencyKey: '49d2651b-e1cd-4da7-9e55-6eab7581886e',
      items: [{ variantId: variant.id, quantity: '1' }],
      payment: { method: 'CASH', amount: '12500' },
    },
  });
  assert.equal(sale.response.status, 201, JSON.stringify(sale.payload));
  assert.equal(sale.payload.total.amount, '12500');
  const ownerShiftSales = await request(`/api/shifts/${ownerShiftStart.payload.shift.id}/sales`);
  assert.equal(ownerShiftSales.response.status, 200, JSON.stringify(ownerShiftSales.payload));
  assert.equal(ownerShiftSales.payload.sales.length, 1);
  const saleHistory = await request(`/api/sales?storeId=${storeId}&limit=1`);
  assert.equal(saleHistory.response.status, 200, `${JSON.stringify(saleHistory.payload)}\n${serverLog}`);
  assert.ok(saleHistory.payload.payload.total >= 1, JSON.stringify(saleHistory.payload));
  const invoiceDetails = await request(`/api/sales/${sale.payload.id}`);
  assert.equal(invoiceDetails.response.status, 200, JSON.stringify(invoiceDetails.payload));
  assert.equal(invoiceDetails.payload.payload.saleNumber, sale.payload.saleNumber);
  assert.equal(invoiceDetails.payload.payload.items[0].name, 'قهوة اختبار');

  const serviceProduct = data.payload.products.find((item) => item.id === createdService.payload.id);
  const serviceSale = await request('/api/checkout', {
    method: 'POST',
    body: {
      storeId,
      idempotencyKey: 'd3f6a68f-036d-4f05-a47c-c3157d4c6df4',
      items: [{ variantId: serviceProduct.variants[0].id, quantity: '1' }],
      payment: { method: 'CASH', amount: '3000' },
    },
  });
  assert.equal(serviceSale.response.status, 400, JSON.stringify(serviceSale.payload));

  const returnBody = { idempotencyKey: '2fe80bd2-4f55-47b9-9b7c-9c0858884ab4', storeId, paymentMethod: 'CASH', items: [{ originalSaleItemId: sale.payload.items[0].id, quantity: '1' }] };
  const customerReturn = await request(`/api/sales/${sale.payload.id}/returns`, { method: 'POST', body: returnBody });
  assert.equal(customerReturn.response.status, 201, JSON.stringify(customerReturn.payload));
  assert.equal(customerReturn.payload.refundAmount, '12500');
  const returnReplay = await request(`/api/sales/${sale.payload.id}/returns`, { method: 'POST', body: returnBody });
  assert.equal(returnReplay.response.status, 201, JSON.stringify(returnReplay.payload));
  assert.equal(returnReplay.payload.id, customerReturn.payload.id);
  const overReturn = await request(`/api/sales/${sale.payload.id}/returns`, { method: 'POST', body: { ...returnBody, idempotencyKey: 'ccbc01d1-07c1-4601-9649-0321298a8efe' } });
  assert.equal(overReturn.response.status, 400);

  data = await request('/api/data');
  const firstPurchaseRecord = data.payload.suppliers[0].purchases.find((item) => item.id === purchase.payload.id);
  const purchaseItemId = firstPurchaseRecord.items[0].id;
  const supplierReturnBody = { idempotencyKey: '7ae8f9a9-9090-4212-ad8c-6405664cbd85', storeId, items: [{ purchaseItemId, quantity: '1' }] };
  const supplierReturn = await request(`/api/purchases/${purchase.payload.id}/returns`, { method: 'POST', body: supplierReturnBody });
  assert.equal(supplierReturn.response.status, 201, JSON.stringify(supplierReturn.payload) + "\\n" + serverLog);
  assert.equal(supplierReturn.payload.creditAmount, '7000');
  const supplierReturnReplay = await request(`/api/purchases/${purchase.payload.id}/returns`, { method: 'POST', body: supplierReturnBody });
  assert.equal(supplierReturnReplay.payload.id, supplierReturn.payload.id);
  const supplierOverReturn = await request(`/api/purchases/${purchase.payload.id}/returns`, { method: 'POST', body: { ...supplierReturnBody, idempotencyKey: '781c0b54-d12c-435d-b9a4-e2744d2f742c', items: [{ purchaseItemId, quantity: '2' }] } });
  assert.equal(supplierOverReturn.response.status, 400);

  data = await request('/api/data');
  const profitLoss = await request(`/api/reports/profit-loss?from=${today}&to=${today}`);
  assert.equal(profitLoss.response.status, 200, JSON.stringify(profitLoss.payload));
  assert.equal(profitLoss.payload.profitLoss.grossSales.amount, '12500');
  assert.equal(profitLoss.payload.profitLoss.returns.amount, '12500');
  assert.equal(profitLoss.payload.profitLoss.netSales.amount, '0');
  assert.equal(profitLoss.payload.profitLoss.cogs.amount, '1200');
  assert.equal(profitLoss.payload.profitLoss.directExpenses.amount, '1750');
  assert.equal(profitLoss.payload.profitLoss.monthlyExpenses.amount, '10000');
  assert.equal(profitLoss.payload.profitLoss.operatingProfit.amount, (-1200n - 1750n - 10000n).toString());
  assert.equal(profitLoss.payload.cashFlow.cashSales.amount, '0');
  assert.equal(profitLoss.payload.cashFlow.directExpenseOutflow.amount, '1750');
  assert.equal(profitLoss.payload.cashFlow.monthlyObligationOutflow.amount, '10000');
  assert.equal(profitLoss.payload.cashFlow.pendingUnpaidObligations.amount, '30000');
  const missingMonthlyActualReport = await request(`/api/reports/profit-loss?from=${previousMonthDate}&to=${previousMonthDate}`);
  assert.equal(missingMonthlyActualReport.response.status, 200);
  assert.equal(missingMonthlyActualReport.payload.missingMonthlyActuals.length, 1);
  assert.equal(missingMonthlyActualReport.payload.missingMonthlyActuals[0].name, '\u0625\u064a\u062c\u0627\u0631 \u0627\u0644\u0645\u062d\u0644');
  const invalidReportRange = await request('/api/reports/profit-loss?from=2026-11-05&to=2026-11-04');
  assert.equal(invalidReportRange.response.status, 400);

  const savedVariant = data.payload.products.find((item) => item.id === product.id).variants[0];
  assert.equal(savedVariant.quantity, '4');
  assert.equal(data.payload.sales.length, 1);
  assert.ok(data.payload.sales.some((item) => item.saleNumber === sale.payload.saleNumber));
  assert.equal(data.payload.products.find((item) => item.id === createdService.payload.id).variants[0].quantity, '0');
  const updatedFirstPurchase = data.payload.suppliers[0].purchases.find((item) => item.id === purchase.payload.id);
  assert.equal(updatedFirstPurchase.remainingAmount.amount, '-2000');
  assert.equal(updatedFirstPurchase.returnedCredit.amount, '7000');
  assert.equal(updatedFirstPurchase.items[0].returnableQuantity, '1');
  assert.equal(data.payload.supplierReturns.length, 1);
  assert.equal(updatedFirstPurchase.payments.length, 2);
  assert.equal(updatedFirstPurchase.items[0].quantity, '2');
  assert.equal(data.payload.accountingEntries.length, 9);
  assert.ok(data.payload.accountingEntries.every((entry) => entry.balanced));
  const purchaseJournal = data.payload.accountingEntries.find((entry) => entry.sourceType === 'PURCHASE' && entry.debitTotal === '14000');
  assert.ok(purchaseJournal);
  assert.equal(purchaseJournal.debitTotal, '14000');
  assert.equal(purchaseJournal.creditTotal, '14000');
  const supplierPaymentJournal = data.payload.accountingEntries.find((entry) => entry.sourceType === 'PURCHASE_PAYMENT');
  assert.equal(supplierPaymentJournal.debitTotal, '5000');
  assert.equal(supplierPaymentJournal.creditTotal, '5000');
  assert.equal(data.payload.accountingEntries.filter((entry) => entry.sourceType === 'SALE').length, 1);
  assert.equal(data.payload.expenses.length, 1);
  assert.equal(data.payload.expenses[0].amount.amount, '1750');
  const expenseJournal = data.payload.accountingEntries.find((entry) => entry.sourceType === 'EXPENSE' && entry.debitTotal === '1750');
  assert.ok(expenseJournal);
  assert.equal(expenseJournal.debitTotal, '1750');
  assert.equal(expenseJournal.creditTotal, '1750');
  const supplierReturnJournal = data.payload.accountingEntries.find((entry) => entry.sourceType === 'SUPPLIER_RETURN');
  assert.equal(supplierReturnJournal.debitTotal, '8200');
  assert.equal(supplierReturnJournal.creditTotal, '8200');
  assert.ok(supplierReturnJournal.lines.some((line) => line.accountCode === '5090' && line.side === 'DEBIT' && line.amount.amount === '1200'));
  const returnJournal = data.payload.accountingEntries.find((entry) => entry.sourceType === 'RETURN');
  assert.equal(returnJournal.debitTotal, '20700');
  assert.equal(returnJournal.creditTotal, '20700');
  assert.equal(data.payload.sales.find((item) => item.id === sale.payload.id).items[0].returnableQuantity, '0');
  assert.equal(data.payload.customerReturns.length, 1);
  assert.equal(data.payload.customerReturns[0].refundAmount.amount, '12500');
  assert.equal(data.payload.monthlyExpenses.length, 1);
  assert.equal(data.payload.monthlyExpenses[0].actual.remainingAmount.amount, '30000');
  assert.equal(data.payload.monthlyExpenses[0].actual.payments.length, 1);
  const expenseJournals = data.payload.accountingEntries.filter((entry) => entry.sourceType === 'EXPENSE');
  assert.equal(expenseJournals.length, 3);
  assert.ok(expenseJournals.every((entry) => entry.balanced));

  const additionalSale = await request('/api/checkout', { method: 'POST', body: {
    storeId, idempotencyKey: '0fb10e6a-72bf-44c1-a94e-30be21f953cb',
    items: [{ variantId: variant.id, quantity: '1' }], payment: { method: 'CASH', amount: '12500' },
  } });
  assert.equal(additionalSale.response.status, 201, JSON.stringify(additionalSale.payload));
  const searchedSales = await request(`/api/sales?storeId=${storeId}&search=COFFEE-TEST-1`);
  assert.equal(searchedSales.response.status, 200, JSON.stringify(searchedSales.payload));
  assert.equal(searchedSales.payload.payload.total, 2);
  assert.ok(searchedSales.payload.payload.sales.every((entry) => entry.items.some((item) => item.sku === 'COFFEE-TEST-1')));
  const topProducts = await request(`/api/reports/top-products?storeId=${storeId}`);
  assert.equal(topProducts.response.status, 200, JSON.stringify(topProducts.payload));
  assert.equal(topProducts.payload.topByUnits.name, 'قهوة اختبار');
  assert.equal(topProducts.payload.topByUnits.unitsSold, '1');
  assert.equal(topProducts.payload.topByUnits.netRevenue.amount, '12500');
  assert.ok(topProducts.payload.products.length >= 1);
  assert.ok(Array.isArray(topProducts.payload.mostPurchasedProducts));
  assert.equal(topProducts.payload.topPurchasedByUnits.name, 'قهوة اختبار');
  assert.equal(topProducts.payload.topPurchasedByUnits.unitsOrdered, '5');
  assert.equal(topProducts.payload.topPurchasedByUnits.returnedUnits, '1');
  assert.equal(topProducts.payload.topPurchasedByUnits.netUnitsReceived, '4');

  const dailyBackupsList = await request('/api/backups/daily');
  assert.equal(dailyBackupsList.response.status, 200, JSON.stringify(dailyBackupsList.payload));
  assert.equal(dailyBackupsList.payload.autoSchedule, 'DAILY_NIGHTLY');
  assert.equal(dailyBackupsList.payload.integrity.quickCheckOk, true);
  assert.equal(dailyBackupsList.payload.integrity.synchronousMode, 'FULL');
  assert.ok(dailyBackupsList.payload.backups.length >= 1);
  const runDailyNow = await request('/api/backups/daily/run-now', { method: 'POST', body: {} });
  assert.equal(runDailyNow.response.status, 201, JSON.stringify(runDailyNow.payload));
  assert.ok(runDailyNow.payload.backup.filename.endsWith('.sqlite'));
  const downloadDaily = await fetch(`${baseUrl}/api/backups/daily/${encodeURIComponent(runDailyNow.payload.backup.filename)}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(downloadDaily.status, 200);
  const dailyBytes = Buffer.from(await downloadDaily.arrayBuffer());
  assert.equal(dailyBytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');

  const blockedInsideMirror = await request('/api/backups/settings', {
    method: 'POST',
    body: { mirrorPath: join(dataDir, 'inside-mirror'), autoMirror: true },
  });
  assert.equal(blockedInsideMirror.response.status, 400);

  const externalMirrorDir = await mkdtemp(join(dirname(dataDir), 'retailos-external-mirror-'));
  try {
    const savedMirror = await request('/api/backups/settings', {
      method: 'POST',
      body: { mirrorPath: externalMirrorDir, autoMirror: true },
    });
    assert.equal(savedMirror.response.status, 200, JSON.stringify(savedMirror.payload));
    assert.equal(savedMirror.payload.mirror.mirrorPath, externalMirrorDir);
    const syncedMirror = await request('/api/backups/mirror/sync-now', { method: 'POST', body: {} });
    assert.equal(syncedMirror.response.status, 200, JSON.stringify(syncedMirror.payload));
    assert.equal(syncedMirror.payload.mirror.lastMirrorStatus, 'OK');
  } finally {
    await request('/api/backups/settings', { method: 'POST', body: { mirrorPath: '', autoMirror: false } });
    await rm(externalMirrorDir, { recursive: true, force: true });
  }

  const receipt80 = await request(`/api/sales/${additionalSale.payload.id}/receipt?width=80mm`);
  assert.equal(receipt80.response.status, 200, JSON.stringify(receipt80.payload));
  assert.equal(receipt80.payload.receipt.saleNumber, additionalSale.payload.saleNumber);
  assert.equal(receipt80.payload.receipt.paperWidth, '80mm');
  assert.ok(receipt80.payload.receipt.escPosBase64.length > 20);

  const secondStore = await request('/api/stores', {
    method: 'POST',
    body: { code: 'BRANCH2', name: 'فرع المعادي', address: 'المعادي - القاهرة', phone: '01099998888' },
  });
  assert.equal(secondStore.response.status, 201, JSON.stringify(secondStore.payload));
  assert.equal(secondStore.payload.code, 'BRANCH2');

  const stockTransfer = await request('/api/inventory/transfer', {
    method: 'POST',
    body: {
      fromStoreId: storeId,
      toStoreId: secondStore.payload.id,
      variantId: variant.id,
      quantity: '1',
    },
  });
  assert.equal(stockTransfer.response.status, 201, JSON.stringify(stockTransfer.payload));
  assert.equal(stockTransfer.payload.transferred, true);
  assert.equal(stockTransfer.payload.quantity, '1');

  const branch2Data = await request(`/api/data?storeId=${secondStore.payload.id}`);
  assert.equal(branch2Data.response.status, 200);
  assert.equal(branch2Data.payload.products.find((item) => item.id === product.id).variants[0].quantity, '1');

  const beforeCloseData = await request(`/api/data?storeId=${storeId}`);
  assert.equal(beforeCloseData.payload.products.find((item) => item.id === product.id).variants[0].quantity, '2');
  const expectedBookCash = BigInt(beforeCloseData.payload.drawerBookBalance.amount);
  const countedCash = (expectedBookCash - 500n).toString();
  const shiftClose = await request('/api/accounting/shift-close', {
    method: 'POST',
    body: {
      idempotencyKey: '5f18e6ef-7d98-4019-a9f8-6159d5ef9d83',
      storeId,
      actualCashAmount: countedCash,
      notes: 'عجز تجريبي في جرد الوردية',
    },
  });
  assert.equal(shiftClose.response.status, 201, JSON.stringify(shiftClose.payload));
  assert.equal(shiftClose.payload.status, 'SHORTAGE');
  assert.equal(shiftClose.payload.variance.amount, '-500');

  const treasuryTransfer = await request('/api/accounting/treasury-transfer', {
    method: 'POST',
    body: {
      idempotencyKey: 'c920d366-b4f2-4a2b-86d1-8fd73493bd3f',
      storeId,
      fromAccount: '1010',
      toAccount: '1015',
      amount: '3000',
      notes: 'توريد نقدية للخزينة الرئيسية',
    },
  });
  assert.equal(treasuryTransfer.response.status, 201, JSON.stringify(treasuryTransfer.payload));
  assert.equal(treasuryTransfer.payload.transferred, true);

  const damageWriteOff = await request('/api/inventory/damage', {
    method: 'POST',
    body: {
      idempotencyKey: '79a7f375-52cf-491d-a0f6-6c260d1f0a11',
      storeId,
      variantId: variant.id,
      quantity: '1',
      reason: 'تلف عبوة أثناء العرض',
    },
  });
  assert.equal(damageWriteOff.response.status, 201, JSON.stringify(damageWriteOff.payload));
  assert.equal(damageWriteOff.payload.resultingQuantity, '1');
  assert.equal(damageWriteOff.payload.lossAmount.amount, '8200');

  const stockAdjust = await request('/api/inventory/adjust', {
    method: 'POST',
    body: {
      idempotencyKey: '18b8d570-3b31-4287-9f64-7fd3d291a022',
      storeId,
      variantId: variant.id,
      targetQuantity: '2',
      unitCost: '8200',
      reason: 'فائض جرد فعلي',
    },
  });
  assert.equal(stockAdjust.response.status, 201, JSON.stringify(stockAdjust.payload));
  assert.equal(stockAdjust.payload.resultingQuantity, '2');
  assert.equal(stockAdjust.payload.delta, '1');

  const csvResponse = await fetch(`${baseUrl}/api/reports/export.csv?type=inventory&storeId=${storeId}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(csvResponse.status, 200);
  const csvBuffer = Buffer.from(await csvResponse.arrayBuffer());
  assert.deepEqual([...csvBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = csvBuffer.toString('utf8');
  assert.ok(csvText.includes('COFFEE-TEST-1'));

  assert.ok(beforeCloseData.payload.accountingPeriods.length >= 1);
  const periodClose = await request('/api/accounting/periods/close', {
    method: 'POST',
    body: {
      periodId: beforeCloseData.payload.accountingPeriods[0].id,
    },
  });
  assert.equal(periodClose.response.status, 200, JSON.stringify(periodClose.payload));
  assert.equal(periodClose.payload.status, 'CLOSED');

  const blockedClosedPeriodPost = await request('/api/accounting/treasury-transfer', {
    method: 'POST',
    body: {
      idempotencyKey: '6d20d366-b4f2-4a2b-86d1-8fd73493bd99',
      storeId,
      fromAccount: '1010',
      toAccount: '1015',
      amount: '1000',
    },
  });
  assert.equal(blockedClosedPeriodPost.response.status, 409);

  const auditLogResponse = await request(`/api/audit-logs?storeId=${storeId}&limit=100`);
  assert.equal(auditLogResponse.response.status, 200, JSON.stringify(auditLogResponse.payload));
  assert.equal(auditLogResponse.payload.chainVerification.valid, true);
  assert.ok(auditLogResponse.payload.chainVerification.checkedCount >= 17);
  const loggedActions = new Set(auditLogResponse.payload.entries.map((entry) => entry.action));
  for (const expectedAction of [
    'OWNER_SETUP',
    'AUTH_LOGIN_SUCCESS',
    'BACKUP_EXPORTED',
    'PRODUCT_CREATED',
    'USER_CREATED',
    'USER_UPDATED',
    'PURCHASE_RECORDED',
    'SUPPLIER_PAYMENT_RECORDED',
    'SUPPLIER_RETURN_RECORDED',
    'SALE_COMPLETED',
    'STORE_CREATED',
    'INVENTORY_TRANSFERRED',
    'SHIFT_CLOSED',
    'TREASURY_TRANSFERRED',
    'INVENTORY_DAMAGE_RECORDED',
    'INVENTORY_ADJUSTED',
    'ACCOUNTING_PERIOD_CLOSED',
  ]) {
    assert.ok(loggedActions.has(expectedAction), `Expected audit log to contain ${expectedAction}`);
  }

  const incorrectPasswordChange = await request('/api/account/password', { method: 'POST', body: { currentPassword: 'wrong-current-password', newPassword: 'New-Owner-Password-2026' } });
  assert.equal(incorrectPasswordChange.response.status, 400);
  const passwordChange = await request('/api/account/password', { method: 'POST', body: { currentPassword: 'A-Long-Test-Password-2026', newPassword: 'New-Owner-Password-2026' } });
  assert.equal(passwordChange.response.status, 200, JSON.stringify(passwordChange.payload));
  assert.equal((await request('/api/data')).response.status, 401);
  const relogin = await request('/api/login', { method: 'POST', authenticated: false, body: { username: 'owner_test', password: 'New-Owner-Password-2026' } });
  assert.equal(relogin.response.status, 200, JSON.stringify(relogin.payload));

  // Verify attendance deduplication across check-in + multiple shifts and late-day calculation against shiftStartTime.
  const ownerCookieAfter = relogin.response.headers.get('set-cookie').split(';')[0];
  cookie = ownerCookieAfter;
  const freshCashier = await request('/api/users', {
    method: 'POST',
    body: {
      username: 'attendance_cashier',
      password: 'Attendance-Cashier-2026',
      fullName: 'Attendance Cashier',
      role: 'CASHIER',
      storeId,
      shiftStartTime: '09:00',
      lateGraceMinutes: 10,
    },
  });
  assert.equal(freshCashier.response.status, 201, JSON.stringify(freshCashier.payload));

  const cashierLogin2 = await request('/api/login', {
    method: 'POST',
    authenticated: false,
    body: { username: 'attendance_cashier', password: 'Attendance-Cashier-2026' },
  });
  assert.equal(cashierLogin2.response.status, 200);
  cookie = cashierLogin2.response.headers.get('set-cookie').split(';')[0];

  const tzOffset = -120;
  const checkInRes = await request('/api/attendance/check-in', { method: 'POST', body: { tzOffset } });
  assert.ok(checkInRes.response.status === 200 || checkInRes.response.status === 201);
  const repeatCheckInRes = await request('/api/attendance/check-in', { method: 'POST', body: { tzOffset } });
  assert.equal(repeatCheckInRes.response.status, 200);
  assert.equal(repeatCheckInRes.payload.alreadyCheckedIn, true);

  // Cashier starts & closes two shifts in the same day; must still count as 1 unique employee present today.
  const shift1 = await request('/api/shifts/start', { method: 'POST', body: { storeId, openingCash: '0', tzOffset } });
  assert.equal(shift1.response.status, 201, JSON.stringify(shift1.payload));
  const endShift1 = await request('/api/shifts/end', { method: 'POST', body: { shiftId: shift1.payload.shift.id, actualCash: '0', handoverCash: '0' } });
  assert.equal(endShift1.response.status, 200);
  const shift2 = await request('/api/shifts/start', { method: 'POST', body: { storeId, openingCash: '0', tzOffset } });
  assert.equal(shift2.response.status, 201, JSON.stringify(shift2.payload));

  cookie = ownerCookieAfter;
  // Owner starts (or restarts) a shift too; owner shift starts must never inflate employee presentCount.
  const ownerStateBefore = await request(`/api/data?storeId=${storeId}&tzOffset=${tzOffset}`);
  if (ownerStateBefore.payload.activeShift?.id) {
    const closePrevOwnerShift = await request('/api/shifts/end', {
      method: 'POST',
      body: { shiftId: ownerStateBefore.payload.activeShift.id, actualCash: '0', handoverCash: '0' },
    });
    assert.equal(closePrevOwnerShift.response.status, 200);
  }
  const ownerShift = await request('/api/shifts/start', { method: 'POST', body: { storeId, openingCash: '0', tzOffset } });
  assert.equal(ownerShift.response.status, 201, JSON.stringify(ownerShift.payload));
  const attDashboard = await request(`/api/data?storeId=${storeId}&tzOffset=${tzOffset}`);
  assert.equal(attDashboard.response.status, 200);
  const uniqueCashierAttendance = attDashboard.payload.todayAttendance.filter((a) => a.userId === freshCashier.payload.id);
  assert.equal(uniqueCashierAttendance.length, 1);
  assert.ok(!attDashboard.payload.todayAttendance.some((a) => a.userId !== freshCashier.payload.id && a.username === 'owner_test'));

  const checkInUtcMs = Date.parse(checkInRes.payload.checkInAt);
  const shiftedLocal = new Date(checkInUtcMs - tzOffset * 60000);
  const arrivalTotalMinutes = shiftedLocal.getUTCHours() * 60 + shiftedLocal.getUTCMinutes();
  const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const currentLocalMonth = shiftedLocal.toISOString().slice(0, 7);

  // Schedule on-time: shift starts at exact arrival minute + 5 min grace => 0 late days, 1 on-time day.
  const setOnTimeSchedule = await request('/api/users/shift-schedule', {
    method: 'PATCH',
    body: { userIds: [freshCashier.payload.id], shiftStartTime: toHHMM(arrivalTotalMinutes), lateGraceMinutes: 5 },
  });
  assert.equal(setOnTimeSchedule.response.status, 200, JSON.stringify(setOnTimeSchedule.payload));
  assert.equal(setOnTimeSchedule.payload.updatedCount, 1);

  const historyOnTime = await request(`/api/attendance/history?userId=${freshCashier.payload.id}&month=${currentLocalMonth}&tzOffset=${tzOffset}`);
  assert.equal(historyOnTime.response.status, 200, JSON.stringify(historyOnTime.payload));
  assert.equal(historyOnTime.payload.summary.totalDays, 1);
  assert.equal(historyOnTime.payload.summary.onTimeDays, 1);
  assert.equal(historyOnTime.payload.summary.lateDays, 0);
  assert.equal(historyOnTime.payload.history.length, 1);
  assert.equal(historyOnTime.payload.history[0].status, 'ON_TIME');

  if (arrivalTotalMinutes >= 2) {
    // Schedule 2 minutes before arrival with 0 grace => 1 late day, >= 2 late minutes.
    const setLateSchedule = await request('/api/users/shift-schedule', {
      method: 'PATCH',
      body: { userIds: [freshCashier.payload.id], shiftStartTime: toHHMM(arrivalTotalMinutes - 2), lateGraceMinutes: 0 },
    });
    assert.equal(setLateSchedule.response.status, 200);
    const historyLate = await request(`/api/attendance/history?userId=${freshCashier.payload.id}&month=${currentLocalMonth}&tzOffset=${tzOffset}`);
    assert.equal(historyLate.response.status, 200);
    assert.equal(historyLate.payload.summary.totalDays, 1);
    assert.equal(historyLate.payload.summary.lateDays, 1);
    assert.equal(historyLate.payload.summary.onTimeDays, 0);
    assert.ok(historyLate.payload.summary.totalLateMinutes >= 2);
    assert.equal(historyLate.payload.history[0].status, 'LATE');
  }
});

test('executes full professional stocktake lifecycle with permissions, blind count, barcode scan, atomic reconciliation, and CSV export', async () => {
  const stkDataDir = await mkdtemp(join(appDir, '.test-stk-data-'));
  const stkPort = await reservePort();
  const stkUrl = `http://127.0.0.1:${stkPort}`;
  let stkLog = '';
  const stkServer = spawn(process.execPath, [join(appDir, 'server.mjs')], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(stkPort),
      RETAILOS_DATA_DIR: stkDataDir,
      RETAILOS_COMPANY_NAME: 'متجر الجرد',
      RETAILOS_COMPANY_CODE: 'STK_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  stkServer.stderr.on('data', (chunk) => { stkLog += chunk.toString(); });

  const stkReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: stkUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${stkUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    let stkReady = false;
    for (let i = 0; i < 240; i += 1) {
      if (stkServer.exitCode !== null) throw new Error(`stkServer exited early (${stkServer.exitCode}): ${stkLog}`);
      try {
        const res = await fetch(`${stkUrl}/api/bootstrap`);
        if (res.ok) { stkReady = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(stkReady, `stkServer did not become ready: ${stkLog}`);

    assert.equal((await stkReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'stk_owner', ownerName: 'مالك الجرد', password: 'Stocktake-Owner-2026' },
    })).response.status, 201, stkLog);

    const loginOwner = await stkReq('/api/login', {
      method: 'POST',
      body: { username: 'stk_owner', password: 'Stocktake-Owner-2026' },
    });
    assert.equal(loginOwner.response.status, 200);
    const ownerCookie = loginOwner.response.headers.get('set-cookie').split(';')[0];

    const initialData = await stkReq('/api/data', { cookieStr: ownerCookie });
    assert.equal(initialData.response.status, 200);
    assert.equal(initialData.payload.capabilities.canAdjustInventory, true);
    const storeId = initialData.payload.selectedStoreId;

    // Create Cashier & verify 403 isolation
    const createdCashier = await stkReq('/api/users', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { username: 'stk_cashier', password: 'Stocktake-Cashier-2026', fullName: 'كاشير الجرد', role: 'CASHIER', storeId },
    });
    assert.equal(createdCashier.response.status, 201);
    const loginCashier = await stkReq('/api/login', {
      method: 'POST',
      body: { username: 'stk_cashier', password: 'Stocktake-Cashier-2026' },
    });
    assert.equal(loginCashier.response.status, 200);
    const cashierCookie = loginCashier.response.headers.get('set-cookie').split(';')[0];

    const cashierData = await stkReq('/api/data', { cookieStr: cashierCookie });
    assert.equal(cashierData.payload.capabilities.canAdjustInventory, false);
    assert.equal((await stkReq(`/api/stocktakes?storeId=${storeId}`, { cookieStr: cashierCookie })).response.status, 403);
    assert.equal((await stkReq('/api/stocktakes', { method: 'POST', cookieStr: cashierCookie, body: { storeId, scope: 'FULL' } })).response.status, 403);

    // Create supplier & 3 products (A shortage, B surplus, Z zero-WAC surplus)
    const supplier = await stkReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'مورد الجرد' } });
    assert.equal(supplier.response.status, 201);

    const prodA = await stkReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'تيشيرت جرد أ', sku: 'STK-PROD-A', barcode: '622990011001', variants: [{ sku: 'STK-VAR-A', barcode: '622990011001', retailPrice: '10000', reorderPoint: '1' }] },
    });
    const prodB = await stkReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'بنطلون جرد ب', sku: 'STK-PROD-B', barcode: '622990011002', variants: [{ sku: 'STK-VAR-B', barcode: '622990011002', retailPrice: '15000', reorderPoint: '1' }] },
    });
    const prodZ = await stkReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'كاب جرد صفر', sku: 'STK-PROD-Z', barcode: '622990011003', variants: [{ sku: 'STK-VAR-Z', barcode: '622990011003', retailPrice: '5000', reorderPoint: '0' }] },
    });
    assert.equal(prodA.response.status, 201);
    assert.equal(prodB.response.status, 201);
    assert.equal(prodZ.response.status, 201);

    const catalogAfterProducts = await stkReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const varAId = catalogAfterProducts.payload.products.find((p) => p.id === prodA.payload.id).variants[0].id;
    const varBId = catalogAfterProducts.payload.products.find((p) => p.id === prodB.payload.id).variants[0].id;
    const varZId = catalogAfterProducts.payload.products.find((p) => p.id === prodZ.payload.id).variants[0].id;

    // Receive A (10 @ 2000) & B (5 @ 4000) via purchase
    const purchaseRes = await stkReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        supplierId: supplier.payload.id,
        storeId,
        totalAmount: '40000',
        paidAmount: '0',
        items: [
          { variantId: varAId, quantity: '10', unitCost: '2000' },
          { variantId: varBId, quantity: '5', unitCost: '4000' },
        ],
      },
    });
    assert.equal(purchaseRes.response.status, 201, JSON.stringify(purchaseRes.payload));

    // Create FULL blind stocktake
    const createdDraft = await stkReq('/api/stocktakes', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, title: 'جرد شامل اختباري', scope: 'FULL', blindMode: true, includeZeroStock: true },
    });
    assert.equal(createdDraft.response.status, 201, JSON.stringify(createdDraft.payload));
    const sessionId = createdDraft.payload.session.id;
    assert.equal(createdDraft.payload.session.status, 'DRAFT');
    assert.equal(createdDraft.payload.session.blindHidden, true);

    const lineA = createdDraft.payload.lines.find((l) => l.variantId === varAId);
    const lineB = createdDraft.payload.lines.find((l) => l.variantId === varBId);
    const lineZ = createdDraft.payload.lines.find((l) => l.variantId === varZId);
    assert.ok(lineA && lineB && lineZ);
    assert.equal(lineA.expectedQuantity, null);

    // ?review=1 exposes expected qty for manager inspection
    const reviewDraft = await stkReq(`/api/stocktakes/${sessionId}?review=1`, { cookieStr: ownerCookie });
    assert.equal(reviewDraft.response.status, 200);
    assert.equal(reviewDraft.payload.session.blindHidden, false);
    assert.equal(reviewDraft.payload.lines.find((l) => l.id === lineA.id).expectedQuantity, 10);

    // Disable blindMode via settings
    const unblinded = await stkReq(`/api/stocktakes/${sessionId}/settings`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { blindMode: false },
    });
    assert.equal(unblinded.response.status, 200);
    assert.equal(unblinded.payload.session.blindHidden, false);

    // Barcode scan A with delta=8 (-2 shortage @ 2000 = -4000)
    const scannedA = await stkReq(`/api/stocktakes/${sessionId}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { scanCode: '622990011001', delta: 8 },
    });
    assert.equal(scannedA.response.status, 200, JSON.stringify(scannedA.payload));
    const updatedA = scannedA.payload.lines.find((l) => l.id === lineA.id);
    assert.equal(updatedA.countedQuantity, 8);
    assert.equal(updatedA.varianceQty, -2);
    assert.equal(updatedA.scannedCount, 1);

    // Unknown barcode returns 404
    assert.equal((await stkReq(`/api/stocktakes/${sessionId}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { scanCode: 'NO-SUCH-BARCODE-999' },
    })).response.status, 404);

    // Count B=6 (+1 @ 4000) and Z=2 (+2 @ 0 WAC)
    const patchedBZ = await stkReq(`/api/stocktakes/${sessionId}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: {
        lines: [
          { lineId: lineB.id, countedQuantity: 6, reason: 'زيادة بالرف' },
          { lineId: lineZ.id, countedQuantity: 2 },
        ],
      },
    });
    assert.equal(patchedBZ.response.status, 200);
    assert.equal(patchedBZ.payload.session.missingCostCount, 1);

    // Reject commit if 0-WAC surplus lacks overrideUnitCost
    assert.equal((await stkReq(`/api/stocktakes/${sessionId}/commit`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: crypto.randomUUID(), uncountedStrategy: 'SKIP_UNCOUNTED' },
    })).response.status, 400);

    // Set override cost 1500 minor units (15.00 EGP) for Z
    const patchedZCost = await stkReq(`/api/stocktakes/${sessionId}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { lines: [{ lineId: lineZ.id, overrideUnitCost: '1500', reason: 'بونص مورد' }] },
    });
    assert.equal(patchedZCost.response.status, 200);
    assert.equal(patchedZCost.payload.session.missingCostCount, 0);

    // Atomic commit
    const commitKey = crypto.randomUUID();
    const committed = await stkReq(`/api/stocktakes/${sessionId}/commit`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: commitKey, uncountedStrategy: 'SKIP_UNCOUNTED', notes: 'اعتماد نهائي' },
    });
    assert.equal(committed.response.status, 200, JSON.stringify(committed.payload));
    assert.equal(committed.payload.session.status, 'COMMITTED');
    assert.equal(committed.payload.session.surplusQty, 3);
    assert.equal(committed.payload.session.shortageQty, 2);
    assert.equal(committed.payload.session.totalSurplusCost.amount, '7000');
    assert.equal(committed.payload.session.totalShortageCost.amount, '4000');
    assert.equal(committed.payload.session.netVarianceCost.amount, '3000');
    assert.ok(committed.payload.session.journalEntryId);

    // Idempotent replay succeeds
    const replay = await stkReq(`/api/stocktakes/${sessionId}/commit`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: commitKey, uncountedStrategy: 'SKIP_UNCOUNTED' },
    });
    assert.equal(replay.response.status, 200);

    // New commit key or post-commit edit rejects with 409
    assert.equal((await stkReq(`/api/stocktakes/${sessionId}/commit`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: crypto.randomUUID(), uncountedStrategy: 'SKIP_UNCOUNTED' },
    })).response.status, 409);
    assert.equal((await stkReq(`/api/stocktakes/${sessionId}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { lines: [{ lineId: lineA.id, countedQuantity: 99 }] },
    })).response.status, 409);

    // Verify live stock reflects physical counts
    const dataAfter = await stkReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const getQty = (pid) => Number(dataAfter.payload.products.find((p) => p.id === pid).variants[0].quantity);
    assert.equal(getQty(prodA.payload.id), 8);
    assert.equal(getQty(prodB.payload.id), 6);
    assert.equal(getQty(prodZ.payload.id), 2);

    // Verify CSV export starts with UTF-8 BOM
    const csvRes = await fetch(`${stkUrl}/api/stocktakes/${sessionId}/export.csv`, {
      headers: { Origin: stkUrl, Cookie: ownerCookie },
    });
    assert.equal(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    const csvText = csvBuf.slice(3).toString('utf8');
    assert.match(csvText, /تيشيرت جرد أ/);
    assert.ok(csvText.includes(createdDraft.payload.session.sessionNumber));

    // Partial stocktake dynamic scan + cancel flow
    const partialDraft = await stkReq('/api/stocktakes', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, scope: 'PARTIAL', title: 'جرد انتقائي للباركود' },
    });
    assert.equal(partialDraft.response.status, 201);
    assert.equal(partialDraft.payload.lines.length, 0);
    const partialScan = await stkReq(`/api/stocktakes/${partialDraft.payload.session.id}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { scanCode: '622990011001', delta: 3 },
    });
    assert.equal(partialScan.response.status, 200);
    assert.equal(partialScan.payload.lines.length, 1);
    assert.equal(partialScan.payload.lines[0].countedQuantity, 3);
    const cancelled = await stkReq(`/api/stocktakes/${partialDraft.payload.session.id}/cancel`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {},
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.payload.session.status, 'CANCELLED');

    // Closed accounting period blocks stocktake commit with 409
    const draftForPeriodClose = await stkReq('/api/stocktakes', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, scope: 'FULL', includeZeroStock: false },
    });
    assert.equal(draftForPeriodClose.response.status, 201);
    const lineInOpenPeriod = draftForPeriodClose.payload.lines.find((l) => l.variantId === varAId);
    await stkReq(`/api/stocktakes/${draftForPeriodClose.payload.session.id}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { lines: [{ lineId: lineInOpenPeriod.id, countedQuantity: 7 }] },
    });
    const periodClose = await stkReq('/api/accounting/periods/close', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { periodId: dataAfter.payload.accountingPeriods[0].id },
    });
    assert.equal(periodClose.response.status, 200);
    assert.equal((await stkReq(`/api/stocktakes/${draftForPeriodClose.payload.session.id}/commit`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: crypto.randomUUID(), uncountedStrategy: 'SKIP_UNCOUNTED' },
    })).response.status, 409);

    // Verify audit logs recorded STOCKTAKE_CREATED, STOCKTAKE_COMMITTED, STOCKTAKE_CANCELLED
    const auditRes = await stkReq(`/api/audit-logs?storeId=${storeId}&limit=100`, { cookieStr: ownerCookie });
    assert.equal(auditRes.response.status, 200);
    const actions = new Set(auditRes.payload.entries.map((e) => e.action));
    assert.ok(actions.has('STOCKTAKE_CREATED'));
    assert.ok(actions.has('STOCKTAKE_COMMITTED'));
    assert.ok(actions.has('STOCKTAKE_CANCELLED'));
  } finally {
    if (stkServer.exitCode === null) {
      stkServer.kill('SIGTERM');
      await Promise.race([once(stkServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await rm(stkDataDir, { recursive: true, force: true }).catch(() => {});
  }
});
