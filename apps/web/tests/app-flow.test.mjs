import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabaseManager } from '@retailos/infrastructure';

function cairoDateIso(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(dirname(appDir));
let serverProcess;
let dataDir;
let baseUrl;
let cookie;
let serverLog = '';

const { publicKey: flowLicensePublicKey, privateKey: flowLicensePrivateKey } =
  generateKeyPairSync('ed25519');
const flowLicensePublicKeyPem = flowLicensePublicKey.export({ type: 'spki', format: 'pem' }).toString();

function signFlowLicenseToken(payload, privateKey = flowLicensePrivateKey) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function testLicenseEnv(extraEnv) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    RETAILOS_TEST_LICENSE_PUBLIC_KEY: flowLicensePublicKeyPem,
    ...extraEnv,
  };
}

async function activateTestLicense(url, { days = 365, customerName = 'متجر الاختبار' } = {}) {
  const statusRes = await fetch(`${url}/api/license/status`);
  assert.equal(statusRes.status, 200, `License status check failed at ${url}`);
  const statusBody = await statusRes.json();
  if (statusBody.status === 'ACTIVE') return statusBody;
  const now = Date.now();
  const token = signFlowLicenseToken({
    licenseId: `TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerName,
    machineId: statusBody.machineId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 24 * 60 * 60 * 1000).toISOString(),
    planName: 'Test Annual Plan',
  });
  const actRes = await fetch(`${url}/api/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ token }),
  });
  const actBody = await actRes.json();
  assert.equal(actRes.status, 200, `License activation failed: ${JSON.stringify(actBody)}`);
  return actBody;
}

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
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
  serverProcess = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: testLicenseEnv({ PORT: String(port), RETAILOS_DATA_DIR: dataDir, RETAILOS_COMPANY_NAME: 'متجر الاختبار', RETAILOS_COMPANY_CODE: 'RETAIL_TEST', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع الرئيسي' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  await waitForApp().catch((error) => { throw new Error(`${error.message}\n${serverLog}`); });
  await activateTestLicense(baseUrl);
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

  // Verify clearing a barcode to null, removing an unused option/variant, and reactivating it persist via PATCH
  const deactivatedVariant = reloadedEditedProduct.variants.find((v) => v.sku === 'SHIRT-TEST-NVY-L');
  assert.ok(deactivatedVariant);
  const clearAndArchiveRes = await request(`/api/products/${sizedProduct.payload.id}`, {
    method: 'PATCH',
    body: {
      name: 'Shirt Updated',
      sku: 'SHIRT-TEST-V2',
      categoryId: null,
      brand: 'BrandUpdated',
      description: 'Updated model description',
      imagePath: sampleImageDataUrl,
      options: [
        { key: 'size', name: 'المقاس', values: ['S', 'M'] },
        { key: 'color', name: 'اللون', values: ['Black', 'White'] },
      ],
      variants: reloadedEditedProduct.variants
        .filter((v) => v.id !== deactivatedVariant.id)
        .map((v) => ({
          id: v.id,
          sku: v.sku,
          barcode: null,
          attributes: v.attributes,
          retailPrice: '9200',
          reorderPoint: '5',
        })),
    },
  });
  assert.equal(clearAndArchiveRes.response.status, 200, JSON.stringify(clearAndArchiveRes.payload));
  data = await request('/api/data');
  const afterArchiveProduct = data.payload.products.find((item) => item.id === sizedProduct.payload.id);
  assert.equal(afterArchiveProduct.options[0].values.includes('L'), false);
  assert.equal(afterArchiveProduct.variants.find((v) => v.id === deactivatedVariant.id)?.isActive, false);

  const reactivateRes = await request(`/api/products/${sizedProduct.payload.id}`, {
    method: 'PATCH',
    body: {
      name: 'Shirt Updated',
      sku: 'SHIRT-TEST-V2',
      categoryId: null,
      brand: 'BrandUpdated',
      description: 'Updated model description',
      imagePath: sampleImageDataUrl,
      options: [
        { key: 'size', name: 'المقاس', values: ['S', 'M', 'L'] },
        { key: 'color', name: 'اللون', values: ['Black', 'White', 'Navy'] },
      ],
      variants: [
        ...afterArchiveProduct.variants.filter((v) => v.isActive).map((v) => ({
          id: v.id,
          sku: v.sku,
          barcode: v.barcode,
          attributes: v.attributes,
          retailPrice: '9200',
          reorderPoint: '5',
        })),
        {
          id: deactivatedVariant.id,
          sku: deactivatedVariant.sku,
          barcode: null,
          attributes: deactivatedVariant.attributes,
          retailPrice: '9200',
          reorderPoint: '5',
        },
      ],
    },
  });
  assert.equal(reactivateRes.response.status, 200, JSON.stringify(reactivateRes.payload));
  data = await request('/api/data');
  const afterReactivateProduct = data.payload.products.find((item) => item.id === sizedProduct.payload.id);
  const reactivatedTarget = afterReactivateProduct.variants.find((v) => v.id === deactivatedVariant.id);
  assert.equal(reactivatedTarget?.isActive, true);
  assert.equal(reactivatedTarget?.barcode, null);

  // Oversized JSON payload returns clean 413 JSON response without dropping connection
  const oversizedRes = await request(`/api/products/${sizedProduct.payload.id}`, {
    method: 'PATCH',
    body: { name: 'Oversized', description: 'X'.repeat(2_200_000) },
  });
  assert.equal(oversizedRes.response.status, 413);
  assert.ok(oversizedRes.payload?.error);
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
  assert.equal(cashierData.payload.capabilities.canRefund, true);
  assert.equal(cashierData.payload.capabilities.canReturnSale, true);
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
  const today = cairoDateIso(now);
  const [cy, cm] = today.split('-').map(Number);
  const previousMonthDate = new Date(Date.UTC(cy, cm - 2, 4)).toISOString().slice(0, 10);

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
  assert.equal(data.payload.accountingEntries.length, 8);
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
  assert.equal(expenseJournals.length, 2);
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
  assert.ok(runDailyNow.payload.backup.filename.endsWith('.rfbackup'));
  assert.equal(runDailyNow.payload.backup.encrypted, true);
  const downloadDaily = await fetch(`${baseUrl}/api/backups/daily/${encodeURIComponent(runDailyNow.payload.backup.filename)}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(downloadDaily.status, 200);
  const dailyBytes = Buffer.from(await downloadDaily.arrayBuffer());
  assert.notEqual(dailyBytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');
  assert.equal(dailyBytes.subarray(0, 5).toString('utf8'), 'RFBK1');

  const malformedUriRes = await fetch(`${baseUrl}/%E0%A4%A`);
  assert.equal(malformedUriRes.status, 400);

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
    const mirroredLatestBytes = await readFile(join(externalMirrorDir, 'retailos-latest.rfbackup'));
    assert.equal(mirroredLatestBytes.subarray(0, 5).toString('utf8'), 'RFBK1');
    assert.notEqual(mirroredLatestBytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');
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
  const stkServer = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: testLicenseEnv({
      PORT: String(stkPort),
      RETAILOS_DATA_DIR: stkDataDir,
      RETAILOS_COMPANY_NAME: 'متجر الجرد',
      RETAILOS_COMPANY_CODE: 'STK_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
    }),
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
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(stkReady, `stkServer did not become ready: ${stkLog}`);
    await activateTestLicense(stkUrl);

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

    // Default FULL stocktake (omitting includeZeroStock) must include only available stock (>0) and exclude zero-stock prodZ
    const defaultOnlyInStock = await stkReq('/api/stocktakes', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, scope: 'FULL' },
    });
    assert.equal(defaultOnlyInStock.response.status, 201, JSON.stringify(defaultOnlyInStock.payload));
    assert.equal(defaultOnlyInStock.payload.session.includeZeroStock, false);
    assert.equal(defaultOnlyInStock.payload.lines.length, 2);
    assert.ok(defaultOnlyInStock.payload.lines.some((l) => l.variantId === varAId));
    assert.ok(defaultOnlyInStock.payload.lines.some((l) => l.variantId === varBId));
    assert.equal(defaultOnlyInStock.payload.lines.some((l) => l.variantId === varZId), false);
    await stkReq(`/api/stocktakes/${defaultOnlyInStock.payload.session.id}/cancel`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {},
    });

    // Create FULL blind stocktake (with explicit includeZeroStock: true)
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
    // No-scanner catalog pick with atomic initial count + increment
    const manualPick = await stkReq(`/api/stocktakes/${partialDraft.payload.session.id}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { addVariantId: varBId, addDelta: 4 },
    });
    assert.equal(manualPick.response.status, 200);
    assert.equal(manualPick.payload.lines.length, 2);
    const lineBManual = manualPick.payload.lines.find((l) => l.variantId === varBId);
    assert.equal(lineBManual.countedQuantity, 4);
    const manualPickBump = await stkReq(`/api/stocktakes/${partialDraft.payload.session.id}/lines`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { addVariantId: varBId, addDelta: 2 },
    });
    assert.equal(manualPickBump.response.status, 200);
    assert.equal(manualPickBump.payload.lines.find((l) => l.variantId === varBId).countedQuantity, 6);
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

test('supports unpriced product catalog creation, supplier purchase wholesale+retail pricing with optional target profit %, and POS checkout guard', async () => {
  const purDataDir = await mkdtemp(join(appDir, '.test-purchase-pricing-'));
  const purPort = await reservePort();
  const purUrl = `http://127.0.0.1:${purPort}`;
  let purLog = '';
  const purServer = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: testLicenseEnv({
      PORT: String(purPort),
      RETAILOS_DATA_DIR: purDataDir,
      RETAILOS_COMPANY_NAME: 'متجر التسعير',
      RETAILOS_COMPANY_CODE: 'PRC_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  purServer.stderr.on('data', (chunk) => { purLog += chunk.toString(); });

  const purReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: purUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${purUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    let purReady = false;
    for (let i = 0; i < 240; i += 1) {
      if (purServer.exitCode !== null) throw new Error(`purServer exited early (${purServer.exitCode}): ${purLog}`);
      try {
        const res = await fetch(`${purUrl}/api/bootstrap`);
        if (res.ok) { purReady = true; break; }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(purReady, `purServer did not become ready: ${purLog}`);
    await activateTestLicense(purUrl);

    assert.equal((await purReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'prc_owner', ownerName: 'مالك التسعير', password: 'Pricing-Owner-2026' },
    })).response.status, 201, purLog);

    const loginOwner = await purReq('/api/login', {
      method: 'POST',
      body: { username: 'prc_owner', password: 'Pricing-Owner-2026' },
    });
    assert.equal(loginOwner.response.status, 200);
    const ownerCookie = loginOwner.response.headers.get('set-cookie').split(';')[0];

    const initialData = await purReq('/api/data', { cookieStr: ownerCookie });
    const storeId = initialData.payload.selectedStoreId;

    const supplier = await purReq('/api/suppliers', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'تاجر الجملة التجريبي' },
    });
    assert.equal(supplier.response.status, 201);

    // 1. Add 3 unpriced products (retailPrice: '0')
    const p1 = await purReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'جاكيت شتوي', sku: 'JKT-01', variants: [{ sku: 'JKT-01-BASE', retailPrice: '0', reorderPoint: '1' }] },
    });
    const p2 = await purReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'بلوفر صوف', sku: 'PLV-02', variants: [{ sku: 'PLV-02-BASE', retailPrice: '0', reorderPoint: '1' }] },
    });
    const p3 = await purReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'تيشيرت بانتظار التسعير', sku: 'TSH-03', variants: [{ sku: 'TSH-03-BASE', retailPrice: '0', reorderPoint: '1' }] },
    });
    assert.equal(p1.response.status, 201);
    assert.equal(p2.response.status, 201);
    assert.equal(p3.response.status, 201);

    const cat1 = await purReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const v1 = cat1.payload.products.find((p) => p.id === p1.payload.id).variants[0];
    const v2 = cat1.payload.products.find((p) => p.id === p2.payload.id).variants[0];
    const v3 = cat1.payload.products.find((p) => p.id === p3.payload.id).variants[0];
    assert.equal(v1.price.amount, '0');
    assert.equal(v3.price.amount, '0');

    // 2. Receive purchase WITH targetProfitPercent: 100 and explicit retailPrice for v1 & v2, leaving v3 unpriced
    const purchase1 = await purReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        supplierId: supplier.payload.id,
        storeId,
        totalAmount: '60000', // 1*30000 + 2*15000 = 600.00 EGP
        paidAmount: '0',
        targetProfitPercent: 100,
        items: [
          { variantId: v1.id, quantity: '1', unitCost: '30000', retailPrice: '60000' },
          { variantId: v2.id, quantity: '2', unitCost: '15000', retailPrice: '30000' },
        ],
      },
    });
    assert.equal(purchase1.response.status, 201, JSON.stringify(purchase1.payload));

    const purchase2 = await purReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        supplierId: supplier.payload.id,
        storeId,
        totalAmount: '10000',
        paidAmount: '0',
        items: [
          { variantId: v3.id, quantity: '2', unitCost: '5000' }, // retailPrice omitted => remains unpriced (0)
        ],
      },
    });
    assert.equal(purchase2.response.status, 201, JSON.stringify(purchase2.payload));

    const afterPur = await purReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const prod1After = afterPur.payload.products.find((p) => p.id === p1.payload.id);
    const prod2After = afterPur.payload.products.find((p) => p.id === p2.payload.id);
    const prod3After = afterPur.payload.products.find((p) => p.id === p3.payload.id);
    assert.equal(prod1After.variants[0].price.amount, '60000');
    assert.equal(prod2After.variants[0].price.amount, '30000');
    assert.equal(prod3After.variants[0].price.amount, '0');

    const supAfter = afterPur.payload.suppliers.find((s) => s.id === supplier.payload.id);
    const savedPur1 = supAfter.purchases.find((p) => p.id === purchase1.payload.id);
    const savedPur2 = supAfter.purchases.find((p) => p.id === purchase2.payload.id);
    assert.equal(savedPur1.targetProfitPercent, 100);
    assert.equal(savedPur1.expectedRetailTotal.amount, '120000');
    assert.equal(savedPur1.items.find((l) => l.sku === 'JKT-01-BASE').retailPrice.amount, '60000');
    assert.equal(savedPur1.items.find((l) => l.sku === 'PLV-02-BASE').retailPrice.amount, '30000');
    assert.equal(savedPur2.targetProfitPercent, null);
    assert.equal(savedPur2.expectedRetailTotal, null);
    assert.equal(savedPur2.items[0].retailPrice, null);

    // 3. Open shift & verify unpriced item checkout is rejected with 400 while priced item checkout succeeds
    const shiftStart = await purReq('/api/shifts/start', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, openingCash: '0', idempotencyKey: crypto.randomUUID() },
    });
    assert.equal(shiftStart.response.status, 201);

    const blockedSale = await purReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        storeId,
        items: [{ variantId: v3.id, quantity: '1' }],
        payment: { method: 'CASH', amount: '1000' },
      },
    });
    assert.equal(blockedSale.response.status, 400);
    assert.match(blockedSale.payload.error, /لم يتم تسعيره/);

    const okSale = await purReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        storeId,
        items: [{ variantId: v1.id, quantity: '1' }],
        payment: { method: 'CASH', amount: '60000' },
      },
    });
    assert.equal(okSale.response.status, 201, JSON.stringify(okSale.payload));

    // 4. Editing product from Products page can later price prod3
    const editProd3 = await purReq(`/api/products/${p3.payload.id}`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: {
        name: 'تيشيرت تم تسعيره بالتعديل',
        sku: 'TSH-03',
        categoryId: null,
        brand: null,
        description: null,
        imagePath: null,
        options: [],
        variants: [{ id: v3.id, sku: 'TSH-03-BASE', barcode: null, attributes: {}, retailPrice: '12500', reorderPoint: '1' }],
      },
    });
    assert.equal(editProd3.response.status, 200, JSON.stringify(editProd3.payload));
    const afterEdit = await purReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(afterEdit.payload.products.find((p) => p.id === p3.payload.id).variants[0].price.amount, '12500');
  } finally {
    if (purServer.exitCode === null) {
      purServer.kill('SIGTERM');
      await Promise.race([once(purServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await rm(purDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('updates all financial views (sales summary, shifts, shift sales, dashboard, growth forecast) after customer returns and exposes itemized supplier payments in profit-loss report', async () => {
  const finDataDir = await mkdtemp(join(appDir, '.test-fin-returns-'));
  const finPort = await reservePort();
  const finUrl = `http://127.0.0.1:${finPort}`;
  let finLog = '';
  const finServer = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: testLicenseEnv({
      PORT: String(finPort),
      RETAILOS_DATA_DIR: finDataDir,
      RETAILOS_COMPANY_NAME: 'متجر الحسابات المتكاملة',
      RETAILOS_COMPANY_CODE: 'FIN_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  finServer.stderr.on('data', (chunk) => { finLog += chunk.toString(); });

  const finReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: finUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${finUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    let finReady = false;
    for (let i = 0; i < 240; i += 1) {
      if (finServer.exitCode !== null) throw new Error(`finServer exited early (${finServer.exitCode}): ${finLog}`);
      try {
        const res = await fetch(`${finUrl}/api/bootstrap`);
        if (res.ok) { finReady = true; break; }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(finReady, `finServer did not become ready: ${finLog}`);
    await activateTestLicense(finUrl);

    assert.equal((await finReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'fin_owner', ownerName: 'مالك المتجر', password: 'Finance-Owner-2026' },
    })).response.status, 201, finLog);

    const loginOwner = await finReq('/api/login', {
      method: 'POST',
      body: { username: 'fin_owner', password: 'Finance-Owner-2026' },
    });
    assert.equal(loginOwner.response.status, 200);
    const ownerCookie = loginOwner.response.headers.get('set-cookie').split(';')[0];

    const initialData = await finReq('/api/data', { cookieStr: ownerCookie });
    const storeId = initialData.payload.selectedStoreId;

    const supplier = await finReq('/api/suppliers', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'شركة النور للتوريد' },
    });
    assert.equal(supplier.response.status, 201);

    const product = await finReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'معطف جلد فاخر', sku: 'COAT-01', variants: [{ sku: 'COAT-01-L', retailPrice: '50000', reorderPoint: '2' }] },
    });
    assert.equal(product.response.status, 201);
    const catAfterProd = await finReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const variantId = catAfterProd.payload.products.find((p) => p.id === product.payload.id).variants[0].id;

    // Purchase 50 units at 200.00 EGP = 10,000.00 EGP (1000000 minor), initial paid 0, then pay 5,000.00 EGP (500000 minor)
    const purchase = await finReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        supplierId: supplier.payload.id,
        idempotencyKey: crypto.randomUUID(),
        invoiceNumber: 'INV-FIN-5000',
        totalAmount: '1000000',
        paidAmount: '0',
        paymentMethod: 'CASH',
        items: [{ variantId, quantity: '50', unitCost: '20000', retailPrice: '50000' }],
      },
    });
    assert.equal(purchase.response.status, 201, JSON.stringify(purchase.payload));

    const pay5000 = await finReq(`/api/purchases/${purchase.payload.id}/payments`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        amount: '500000',
        paymentMethod: 'CASH',
        referenceNumber: 'PAY-5000',
      },
    });
    assert.equal(pay5000.response.status, 201, JSON.stringify(pay5000.payload));

    // Open a shift with 100.00 EGP opening cash, sell 2 coats @ 500.00 EGP = 1,000.00 EGP (100000 minor)
    const shiftStart = await finReq('/api/shifts/start', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, openingCash: '10000' },
    });
    assert.equal(shiftStart.response.status, 201);
    const shiftId = shiftStart.payload.shift.id;

    const saleRes = await finReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        idempotencyKey: crypto.randomUUID(),
        items: [{ variantId, quantity: '2' }],
        payment: { method: 'CASH', amount: '100000' },
      },
    });
    assert.equal(saleRes.response.status, 201, JSON.stringify(saleRes.payload));
    const saleId = saleRes.payload.id;
    const saleItemId = saleRes.payload.items[0].id;

    // Pre-return assertions
    const today = cairoDateIso();
    const preSales = await finReq(`/api/sales?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(preSales.payload.payload.summary.netSales.amount, '100000');
    assert.equal(preSales.payload.payload.summary.cogs.amount, '40000');
    assert.equal(preSales.payload.payload.summary.grossProfit.amount, '60000');

    // Partial customer return: 1 unit (500.00 EGP = 50000 minor) while shift is OPEN
    const partialReturn = await finReq(`/api/sales/${saleId}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        storeId,
        paymentMethod: 'CASH',
        items: [{ originalSaleItemId: saleItemId, quantity: '1' }],
      },
    });
    assert.equal(partialReturn.response.status, 201, JSON.stringify(partialReturn.payload));
    assert.equal(partialReturn.payload.refundAmount, '50000');

    // Verify ALL endpoints updated consistently after partial return
    const postData = await finReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const stockQty = postData.payload.products.find((p) => p.id === product.payload.id).variants[0].quantity;
    assert.equal(stockQty, '49');
    assert.equal(postData.payload.summary.todayRevenue.amount, '50000');
    assert.equal(postData.payload.sales[0].netTotal.amount, '50000');
    assert.equal(postData.payload.sales[0].returnedAmount.amount, '50000');
    assert.equal(postData.payload.sales[0].returnStatus, 'PARTIAL');
    assert.equal(postData.payload.sales[0].cogs.amount, '20000');
    assert.equal(postData.payload.sales[0].grossProfit.amount, '30000');

    const postSales = await finReq(`/api/sales?storeId=${storeId}&from=${today}&to=${today}`, { cookieStr: ownerCookie });
    assert.equal(postSales.payload.payload.summary.grossSales.amount, '100000');
    assert.equal(postSales.payload.payload.summary.returnsTotal.amount, '50000');
    assert.equal(postSales.payload.payload.summary.netSales.amount, '50000');
    assert.equal(postSales.payload.payload.summary.cogs.amount, '20000');
    assert.equal(postSales.payload.payload.summary.grossProfit.amount, '30000');
    assert.equal(postSales.payload.payload.sales[0].netTotal.amount, '50000');
    assert.equal(postSales.payload.payload.sales[0].returnStatus, 'PARTIAL');

    const currentShift = await finReq('/api/shifts/current', { cookieStr: ownerCookie });
    assert.equal(currentShift.payload.currentShift.totalSales, '50000');
    assert.equal(currentShift.payload.currentShift.returnsTotal, '50000');
    assert.equal(currentShift.payload.currentShift.expectedCash, '60000');

    const shiftsList = await finReq(`/api/shifts?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(shiftsList.payload.shifts[0].salesRevenue, '50000');
    assert.equal(shiftsList.payload.shifts[0].grossProfit, '30000');
    assert.equal(shiftsList.payload.shifts[0].returnedTotal, '50000');
    assert.equal(shiftsList.payload.shifts[0].expectedCash, '60000');
    assert.equal(shiftsList.payload.summary.totalSales, '50000');
    assert.equal(shiftsList.payload.summary.totalProfit, '30000');

    const shiftSales = await finReq(`/api/shifts/${shiftId}/sales`, { cookieStr: ownerCookie });
    assert.equal(shiftSales.payload.sales[0].total, '50000');
    assert.equal(shiftSales.payload.sales[0].originalTotal, '100000');
    assert.equal(shiftSales.payload.sales[0].returnedAmount, '50000');
    assert.equal(shiftSales.payload.sales[0].grossProfit, '30000');
    assert.equal(shiftSales.payload.sales[0].returnStatus, 'PARTIAL');

    const forecast = await finReq(`/api/reports/growth-forecast?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(forecast.payload.currentMonth.revenue, '50000');
    assert.equal(forecast.payload.currentMonth.profit, '30000');

    const pl = await finReq(`/api/reports/profit-loss?storeId=${storeId}&from=${today}&to=${today}`, { cookieStr: ownerCookie });
    assert.equal(pl.payload.profitLoss.netSales.amount, '50000');
    assert.equal(pl.payload.profitLoss.cogs.amount, '20000');
    assert.equal(pl.payload.profitLoss.grossProfit.amount, '30000');
    assert.equal(pl.payload.supplierPayments.totalPaid.amount, '500000');
    assert.equal(pl.payload.supplierPayments.items.length, 1);
    assert.equal(pl.payload.supplierPayments.items[0].supplierName, 'شركة النور للتوريد');
    assert.equal(pl.payload.supplierPayments.items[0].amount.amount, '500000');
    assert.equal(pl.payload.cashPosition.netCashRemaining.amount, '-450000');

    const finMapPartial = await finReq(`/api/reports/financial-map?storeId=${storeId}&from=${today}&to=${today}&tzOffset=0`, { cookieStr: ownerCookie });
    assert.equal(finMapPartial.response.status, 200);
    assert.equal(finMapPartial.payload.summary.totalSupplierPaid, '500000');
    assert.equal(finMapPartial.payload.summary.netSales, '50000');
    assert.equal(finMapPartial.payload.summary.operatingProfit, pl.payload.profitLoss.operatingProfit.amount);
    const supPaymentEvent = finMapPartial.payload.timeline.find((e) => e.type === 'SUPPLIER_PAYMENT');
    assert.ok(supPaymentEvent, 'Expected supplier payment event in financial map timeline');
    assert.ok(supPaymentEvent.title.includes('سددت') && supPaymentEvent.title.includes('5000.00'), supPaymentEvent.title);
    assert.ok(supPaymentEvent.details.includes('سددت') && supPaymentEvent.details.includes('شركة النور للتوريد'), supPaymentEvent.details);

    // Close shift & return remaining 1 unit AFTER closing, confirming shift sales/profit become 0 & FULL return
    const shiftEnd = await finReq('/api/shifts/end', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { shiftId, actualCash: '60000', handoverCash: '60000' },
    });
    assert.equal(shiftEnd.response.status, 200);

    const fullReturn = await finReq(`/api/sales/${saleId}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: crypto.randomUUID(),
        storeId,
        paymentMethod: 'CASH',
        items: [{ originalSaleItemId: saleItemId, quantity: '1' }],
      },
    });
    assert.equal(fullReturn.response.status, 201);

    const finalShifts = await finReq(`/api/shifts?storeId=${storeId}&from=${today}&to=${today}&tzOffset=0`, { cookieStr: ownerCookie });
    assert.equal(finalShifts.payload.shifts[0].salesRevenue, '0');
    assert.equal(finalShifts.payload.shifts[0].grossProfit, '0');
    assert.equal(finalShifts.payload.shifts[0].returnedTotal, '100000');

    const finalShiftSales = await finReq(`/api/shifts/${shiftId}/sales`, { cookieStr: ownerCookie });
    assert.equal(finalShiftSales.payload.sales[0].total, '0');
    assert.equal(finalShiftSales.payload.sales[0].returnStatus, 'FULL');

    const finalFinMap = await finReq(`/api/reports/financial-map?storeId=${storeId}&from=${today}&to=${today}&tzOffset=0`, { cookieStr: ownerCookie });
    assert.equal(finalFinMap.payload.summary.netSales, '0');
    assert.equal(finalFinMap.payload.summary.operatingProfit, '0');
    assert.equal(finalFinMap.payload.summary.netCashFlow, '-500000');

    const finalData = await finReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(finalData.payload.products.find((p) => p.id === product.payload.id).variants[0].quantity, '50');
    assert.equal(finalData.payload.summary.todayRevenue.amount, '0');
  } finally {
    if (finServer.exitCode === null) {
      finServer.kill('SIGTERM');
      await Promise.race([once(finServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await rm(finDataDir, { recursive: true, force: true }).catch(() => {});
  }
});


test('keeps /api/sales strictly pure while separating profit-loss expenses and financial-map full cash & inventory trail', async () => {
  const sepDataDir = await mkdtemp(join(appDir, '.test-sep-reports-'));
  const sepPort = await reservePort();
  const sepUrl = `http://127.0.0.1:${sepPort}`;
  let sepLog = '';
  const sepServer = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: testLicenseEnv({
      PORT: String(sepPort),
      RETAILOS_DATA_DIR: sepDataDir,
      RETAILOS_COMPANY_NAME: 'متجر الفصل المالي',
      RETAILOS_COMPANY_CODE: 'SEP_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  sepServer.stderr.on('data', (chunk) => { sepLog += chunk.toString(); });

  const sepReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: sepUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${sepUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    let sepReady = false;
    for (let i = 0; i < 240; i += 1) {
      if (sepServer.exitCode !== null) throw new Error(`sepServer exited early (${sepServer.exitCode}): ${sepLog}`);
      try {
        const res = await fetch(`${sepUrl}/api/bootstrap`);
        if (res.ok) { sepReady = true; break; }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(sepReady, `sepServer did not become ready: ${sepLog}`);
    await activateTestLicense(sepUrl);

    assert.equal((await sepReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'sep_owner', ownerName: 'صاحب المتجر', password: 'Sep-Owner-Password-2026' },
    })).response.status, 201, sepLog);

    const loginRes = await sepReq('/api/login', {
      method: 'POST',
      body: { username: 'sep_owner', password: 'Sep-Owner-Password-2026' },
    });
    assert.equal(loginRes.response.status, 200);
    const ownerCookie = loginRes.response.headers.get('set-cookie').split(';')[0];

    const initialData = await sepReq('/api/data', { cookieStr: ownerCookie });
    const storeId = initialData.payload.selectedStoreId;
    const supRes = await sepReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر الفواتير' } });
    assert.equal(supRes.response.status, 201);

    const prodRes = await sepReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'جاكيت شتوي', sku: 'JKT-SEP-1', variants: [{ sku: 'JKT-SEP-1-L', retailPrice: '40000', reorderPoint: '1' }] },
    });
    assert.equal(prodRes.response.status, 201);

    const d1 = await sepReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const variantId = d1.payload.products.find((p) => p.id === prodRes.payload.id).variants[0].id;

    const purRes = await sepReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        supplierId: supRes.payload.id,
        idempotencyKey: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1',
        invoiceNumber: 'PUR-SEP-01',
        totalAmount: '200000',
        paidAmount: '50000',
        paymentMethod: 'CASH',
        items: [{ variantId, quantity: '10', unitCost: '20000', retailPrice: '40000' }],
      },
    });
    assert.equal(purRes.response.status, 201, JSON.stringify(purRes.payload));

    const d2 = await sepReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const supRecord = d2.payload.suppliers.find((s) => s.id === supRes.payload.id);
    const purchaseRecord = supRecord.purchases.find((p) => p.id === purRes.payload.id);
    const purchaseItemId = purchaseRecord.items[0].id;

    assert.equal((await sepReq('/api/shifts/start', { method: 'POST', cookieStr: ownerCookie, body: { storeId, openingCash: '0' } })).response.status, 201);

    const saleRes = await sepReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        idempotencyKey: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaa2',
        items: [{ variantId, quantity: '3' }],
        payment: { method: 'CASH', amount: '120000' },
      },
    });
    assert.equal(saleRes.response.status, 201, JSON.stringify(saleRes.payload));

    const custRetRes = await sepReq(`/api/sales/${saleRes.payload.id}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaa3',
        storeId,
        paymentMethod: 'CASH',
        items: [{ originalSaleItemId: saleRes.payload.items[0].id, quantity: '1' }],
      },
    });
    assert.equal(custRetRes.response.status, 201, JSON.stringify(custRetRes.payload));

    const supRetRes = await sepReq(`/api/purchases/${purRes.payload.id}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaa4',
        storeId,
        items: [{ purchaseItemId, quantity: '2' }],
      },
    });
    assert.equal(supRetRes.response.status, 201, JSON.stringify(supRetRes.payload));

    const today = cairoDateIso();
    const expRes = await sepReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaa5',
        storeId,
        categoryCode: 'UTILITIES',
        amount: '50000',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: today,
        notes: 'كهرباء المحل',
      },
    });
    assert.equal(expRes.response.status, 201, JSON.stringify(expRes.payload));

    const dmgRes = await sepReq('/api/inventory/damage', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'aaaaaaaa-6666-4666-8666-aaaaaaaaaaa6',
        storeId,
        variantId,
        quantity: '1',
        reason: 'قطعة تالفة',
      },
    });
    assert.equal(dmgRes.response.status, 201, JSON.stringify(dmgRes.payload));

    const salesReport = await sepReq(`/api/sales?storeId=${storeId}&from=${today}&to=${today}`, { cookieStr: ownerCookie });
    assert.equal(salesReport.response.status, 200);
    assert.equal(salesReport.payload.payload.summary.invoiceCount, 1);
    assert.equal(salesReport.payload.payload.summary.returnsCount, 1);
    assert.equal(salesReport.payload.payload.summary.grossUnits, '3');
    assert.equal(salesReport.payload.payload.summary.returnedUnits, '1');
    assert.equal(salesReport.payload.payload.summary.netUnits, '2');
    assert.equal(salesReport.payload.payload.summary.netSales.amount, '80000');
    assert.equal(salesReport.payload.payload.summary.cogs.amount, '40000');
    assert.equal(salesReport.payload.payload.summary.grossProfit.amount, '40000');

    const plReport = await sepReq(`/api/reports/profit-loss?storeId=${storeId}&from=${today}&to=${today}`, { cookieStr: ownerCookie });
    assert.equal(plReport.response.status, 200);
    assert.equal(plReport.payload.profitLoss.netSales.amount, '80000');
    assert.equal(plReport.payload.profitLoss.cogs.amount, '40000');
    assert.equal(plReport.payload.profitLoss.directExpenses.amount, '50000');
    assert.equal(plReport.payload.profitLoss.inventoryAdjustmentsLoss.amount, '20000');
    assert.equal(plReport.payload.profitLoss.operatingProfit.amount, '-30000');
    assert.equal(plReport.payload.expenseItems.length, 1);
    assert.equal(plReport.payload.expenseItems[0].amount.amount, '50000');
    assert.equal(plReport.payload.supplierPayments.initialPaid.amount, '50000');
    assert.equal(plReport.payload.supplierPayments.installmentPaid.amount, '0');

    const fmReport = await sepReq(`/api/reports/financial-map?storeId=${storeId}&from=${today}&to=${today}`, { cookieStr: ownerCookie });
    assert.equal(fmReport.response.status, 200);
    assert.equal(fmReport.payload.summary.netSales, '80000');
    assert.equal(fmReport.payload.summary.totalCogs, '40000');
    assert.equal(fmReport.payload.summary.totalPurchasesBilled, '200000');
    assert.equal(fmReport.payload.summary.totalSupplierPaid, '50000');
    assert.equal(fmReport.payload.summary.totalExpensesPaid, '50000');
    assert.equal(fmReport.payload.summary.inventoryAdjustmentsLoss, '20000');
    assert.equal(fmReport.payload.summary.operatingProfit, '-30000');
    assert.equal(fmReport.payload.summary.netCashFlow, '-20000');
    assert.equal(fmReport.payload.summary.runningFinalCash, '-20000');

    const types = fmReport.payload.timeline.map((e) => e.type);
    for (const expectedType of ['SUPPLIER_PURCHASE', 'SUPPLIER_PAYMENT', 'SALE', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'EXPENSE', 'INVENTORY_EVENT']) {
      assert.ok(types.includes(expectedType), `Expected timeline to include ${expectedType}, got ${types.join(', ')}`);
    }
    assert.equal(fmReport.payload.timeline[0].stepNumber, fmReport.payload.timeline.length);
    assert.equal(fmReport.payload.timeline.at(-1).stepNumber, 1);
    assert.equal(fmReport.payload.timeline[0].runningCash, fmReport.payload.summary.runningFinalCash);
    assert.ok(fmReport.payload.timeline[0].timestamp >= fmReport.payload.timeline.at(-1).timestamp);
    const supPayEvent = fmReport.payload.timeline.find((e) => e.type === 'SUPPLIER_PAYMENT');
    assert.ok(supPayEvent.title.includes('سددت'));
  } finally {
    if (sepServer.exitCode === null) sepServer.kill('SIGTERM');
    await once(sepServer, 'exit').catch(() => {});
    await rm(sepDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('release readiness: full paged history (>200 purchases, journals, returns, expenses) and SQLite-persistent auth throttling across restart', async () => {
  const rrDataDir = await mkdtemp(join(appDir, '.test-readiness-'));
  let rrPort = await reservePort();
  let rrUrl = `http://127.0.0.1:${rrPort}`;
  let rrLog = '';

  const startSrv = async () => {
    const child = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({
        PORT: String(rrPort),
        RETAILOS_DATA_DIR: rrDataDir,
        RETAILOS_COMPANY_NAME: 'متجر الجاهزية',
        RETAILOS_COMPANY_CODE: 'READINESS',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { rrLog += chunk.toString(); });
    for (let i = 0; i < 160; i += 1) {
      if (child.exitCode !== null) throw new Error(`rrServer exited (${child.exitCode}): ${rrLog}`);
      try {
        const res = await fetch(`${rrUrl}/api/bootstrap`);
        if (res.ok) {
          await activateTestLicense(rrUrl);
          return child;
        }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`rrServer did not become ready: ${rrLog}`);
  };

  let rrServer = await startSrv();
  const rrReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: rrUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${rrUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    assert.equal((await rrReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'rr_owner', ownerName: 'مدير الجاهزية', password: 'Readiness-Password-2026' },
    })).response.status, 201, rrLog);

    const loginOk = await rrReq('/api/login', {
      method: 'POST',
      body: { username: 'rr_owner', password: 'Readiness-Password-2026' },
    });
    assert.equal(loginOk.response.status, 200);
    const ownerCookie = loginOk.response.headers.get('set-cookie').split(';')[0];

    const data0 = await rrReq('/api/data', { cookieStr: ownerCookie });
    const storeId = data0.payload.selectedStoreId;
    const cat = await rrReq('/api/categories', { method: 'POST', cookieStr: ownerCookie, body: { name: 'ملابس' } });
    const prod = await rrReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'قميص جاهز',
        sku: 'RR-SHIRT',
        categoryId: cat.payload.id,
        hasVariants: false,
        options: [],
        variants: [{ sku: 'RR-SHIRT-1', retailPrice: '10000', reorderPoint: '1', attributes: {} }],
      },
    });
    assert.equal(prod.response.status, 201);
    const d1 = await rrReq('/api/data', { cookieStr: ownerCookie });
    const variantId = d1.payload.products[0].variants[0].id;
    const sup = await rrReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'مورد السجل الكامل' } });

    // Create 205 supplier purchases (10000 total, 2000 paid each => 2050000 total, 410000 paid, 1640000 due)
    for (let idx = 1; idx <= 205; idx += 1) {
      const nHex = idx.toString(16).padStart(4, '0');
      const res = await rrReq('/api/purchases', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: {
          idempotencyKey: `cccccccc-1111-4111-8111-00000000${nHex}`,
          supplierId: sup.payload.id,
          storeId,
          invoiceNumber: `PINV-${String(idx).padStart(3, '0')}`,
          totalAmount: '10000',
          paidAmount: '2000',
          paymentMethod: 'CASH',
          items: [{ variantId, quantity: '1', unitCost: '10000' }],
        },
      });
      assert.equal(res.response.status, 201, `Purchase ${idx} failed`);
    }

    // Bootstrap keeps only 200 rows in window, yet carries accurate full SQL totals for all 205 invoices
    const bootstrapData = await rrReq('/api/data', { cookieStr: ownerCookie });
    const bootSup = bootstrapData.payload.suppliers.find((s) => s.id === sup.payload.id);
    assert.equal(bootSup.purchases.length, 200);
    assert.equal(bootSup.purchaseCount, 205);
    assert.equal(bootSup.purchasesComplete, false);
    assert.equal(bootSup.totalPurchased, '2050000');
    assert.equal(bootSup.totalPaid, '410000');
    assert.equal(bootSup.balanceDue, '1640000');

    // Paged /api/purchases reaches invoices 201..205 beyond the 200-row cap & searches oldest invoice PINV-001
    const tailPage = await rrReq(`/api/purchases?storeId=${storeId}&offset=200&limit=50`, { cookieStr: ownerCookie });
    assert.equal(tailPage.response.status, 200);
    assert.equal(tailPage.payload.payload.total, 205);
    assert.equal(tailPage.payload.payload.purchases.length, 5);
    assert.equal(tailPage.payload.payload.summary.totalPurchased.amount, '2050000');
    assert.equal(tailPage.payload.payload.summary.balanceDue.amount, '1640000');

    const oldestSearch = await rrReq(`/api/purchases?storeId=${storeId}&search=PINV-001`, { cookieStr: ownerCookie });
    assert.equal(oldestSearch.response.status, 200);
    assert.equal(oldestSearch.payload.payload.total, 1);
    assert.equal(oldestSearch.payload.payload.purchases[0].invoiceNumber, 'PINV-001');

    // Verify /api/journal-entries supports filtering & paging across >205 journal entries
    const jePage = await rrReq(`/api/journal-entries?storeId=${storeId}&sourceType=PURCHASE&offset=200&limit=20`, { cookieStr: ownerCookie });
    assert.equal(jePage.response.status, 200);
    assert.equal(jePage.payload.payload.total, 205);
    assert.equal(jePage.payload.payload.entries.length, 5);
    assert.ok(jePage.payload.payload.entries.every((e) => e.balanced));

    // Verify /api/customer-returns & /api/expenses endpoints respond cleanly with totals
    const retList = await rrReq(`/api/customer-returns?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(retList.response.status, 200);
    assert.equal(retList.payload.payload.total, 0);

    const todayStr = cairoDateIso();
    await rrReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'cccccccc-2222-4222-8222-000000000001',
        storeId,
        categoryCode: 'OTHER',
        amount: '3500',
        paymentMethod: 'CASH_DRAWER',
        expenseDate: todayStr,
        notes: 'مصروف جاهزية',
      },
    });
    const expList = await rrReq(`/api/expenses?storeId=${storeId}&search=${encodeURIComponent('جاهزية')}`, { cookieStr: ownerCookie });
    assert.equal(expList.response.status, 200);
    assert.equal(expList.payload.payload.total, 1);
    assert.equal(expList.payload.payload.totalAmount.amount, '3500');

    // Verify persistent SQLite auth throttling survives server process restart
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const bad = await rrReq('/api/login', {
        method: 'POST',
        body: { username: 'rr_owner', password: 'Wrong-Password-Attempt' },
      });
      assert.equal(bad.response.status, 401);
    }
    const lockedBeforeRestart = await rrReq('/api/login', {
      method: 'POST',
      body: { username: 'rr_owner', password: 'Readiness-Password-2026' },
    });
    assert.equal(lockedBeforeRestart.response.status, 429);

    rrServer.kill('SIGTERM');
    await once(rrServer, 'exit').catch(() => {});
    rrPort = await reservePort();
    rrUrl = `http://127.0.0.1:${rrPort}`;
    rrServer = await startSrv();

    const lockedAfterRestart = await rrReq('/api/login', {
      method: 'POST',
      body: { username: 'rr_owner', password: 'Readiness-Password-2026' },
    });
    assert.equal(lockedAfterRestart.response.status, 429);
  } finally {
    if (rrServer && rrServer.exitCode === null) {
      rrServer.kill('SIGTERM');
      await once(rrServer, 'exit').catch(() => {});
    }
    await rm(rrDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('multi-unit sale with line and cart discounts keeps P&L, Financial Map, Sales, and Shifts aligned via net_revenue', async () => {
  const discDataDir = await mkdtemp(join(appDir, '.test-discount-'));
  const discPort = await reservePort();
  const discUrl = `http://127.0.0.1:${discPort}`;
  let discLog = '';

  const stopChild = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => {});
  };

  const startSrv = async () => {
    const child = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({
        PORT: String(discPort),
        RETAILOS_DATA_DIR: discDataDir,
        RETAILOS_COMPANY_NAME: 'متجر الخصومات',
        RETAILOS_COMPANY_CODE: 'DISC',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { discLog += chunk.toString(); });
    for (let i = 0; i < 240; i += 1) {
      if (child.exitCode !== null) throw new Error(`discServer exited (${child.exitCode}): ${discLog}`);
      try {
        const res = await fetch(`${discUrl}/api/bootstrap`);
        if (res.ok) {
          await activateTestLicense(discUrl);
          return child;
        }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`discServer did not become ready: ${discLog}`);
  };

  const discServer = await startSrv();
  const dReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: discUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${discUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    assert.equal((await dReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'disc_owner', ownerName: 'مدير الخصم', password: 'Discount-Password-2026' },
    })).response.status, 201, discLog);

    const loginRes = await dReq('/api/login', {
      method: 'POST',
      body: { username: 'disc_owner', password: 'Discount-Password-2026' },
    });
    assert.equal(loginRes.response.status, 200);
    const ownerCookie = loginRes.response.headers.get('set-cookie').split(';')[0];

    const data0 = await dReq('/api/data', { cookieStr: ownerCookie });
    const storeId = data0.payload.selectedStoreId;
    const cat = await dReq('/api/categories', { method: 'POST', cookieStr: ownerCookie, body: { name: 'ملابس' } });
    const prod = await dReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'بنطلون خصم',
        sku: 'DISC-PANT',
        categoryId: cat.payload.id,
        hasVariants: false,
        options: [],
        variants: [{ sku: 'DISC-PANT-1', retailPrice: '10000', reorderPoint: '1', attributes: {} }],
      },
    });
    assert.equal(prod.response.status, 201);
    const d1 = await dReq('/api/data', { cookieStr: ownerCookie });
    const variantId = d1.payload.products[0].variants[0].id;
    const sup = await dReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'مورد الخصومات' } });
    const pur = await dReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'dddddddd-1111-4111-8111-000000000001',
        supplierId: sup.payload.id,
        storeId,
        invoiceNumber: 'DPUR-1',
        totalAmount: '16000',
        paidAmount: '16000',
        paymentMethod: 'CASH',
        items: [{ variantId, quantity: '4', unitCost: '4000' }],
      },
    });
    assert.equal(pur.response.status, 201);

    const shiftRes = await dReq('/api/shifts/start', { method: 'POST', cookieStr: ownerCookie, body: { storeId, openingCash: '0' } });
    assert.equal(shiftRes.response.status, 201);

    const saleRes = await dReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        idempotencyKey: 'dddddddd-2222-4222-8222-000000000002',
        items: [{ variantId, quantity: '2' }],
        payment: { method: 'CASH', amount: '20000' },
      },
    });
    assert.equal(saleRes.response.status, 201, JSON.stringify(saleRes.payload));

    // Record a second multi-unit sale (qty=2, line_discount=3000, cart_discount_share=1000, net_revenue=16000)
    // alongside sale #1 (qty=2, net_revenue=20000). Combined netSales=36000, cogs=16000, profit=20000
    // (buggy qty*discount SQL would yield 32000 instead of 36000).
    const sale2Res = await dReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        idempotencyKey: 'dddddddd-3333-4333-8333-000000000003',
        cartDiscount: '1000',
        items: [{ variantId, quantity: '2', lineDiscount: '3000' }],
        payment: { method: 'CASH', amount: '16000' },
      },
    });
    assert.equal(sale2Res.response.status, 201, JSON.stringify(sale2Res.payload));
    assert.equal(sale2Res.payload.total.amount, '16000');
    assert.equal(sale2Res.payload.discountTotal.amount, '4000');

    const todayStr = cairoDateIso();
    const [pl, fm, salesPage, shiftsRes] = await Promise.all([
      dReq(`/api/reports/profit-loss?from=${todayStr}&to=${todayStr}`, { cookieStr: ownerCookie }),
      dReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie }),
      dReq(`/api/sales?storeId=${storeId}&limit=10`, { cookieStr: ownerCookie }),
      dReq(`/api/shifts?storeId=${storeId}`, { cookieStr: ownerCookie }),
    ]);

    assert.equal(pl.response.status, 200);
    assert.equal(pl.payload.profitLoss.grossSales.amount, '40000');
    assert.equal(pl.payload.profitLoss.discounts.amount, '4000');
    assert.equal(pl.payload.profitLoss.netSales.amount, '36000');
    assert.equal(pl.payload.profitLoss.cogs.amount, '16000');
    assert.equal(pl.payload.profitLoss.grossProfit.amount, '20000');
    assert.equal(pl.payload.profitLoss.operatingProfit.amount, '20000');

    assert.equal(fm.response.status, 200);
    assert.equal(fm.payload.summary.netSales, '36000');
    assert.equal(fm.payload.summary.totalCogs, '16000');
    assert.equal(fm.payload.summary.operatingProfit, '20000');
    assert.equal(fm.payload.summary.netCashFlow, '20000');

    assert.equal(salesPage.response.status, 200);
    assert.equal(salesPage.payload.payload.summary.netSales.amount, '36000');
    assert.equal(salesPage.payload.payload.summary.grossProfit.amount, '20000');
    assert.equal(salesPage.payload.payload.summary.operatingProfit.amount, '20000');

    assert.equal(shiftsRes.response.status, 200);
    assert.equal(shiftsRes.payload.summary.totalSales, '36000');
    assert.equal(shiftsRes.payload.summary.totalProfit, '20000');
  } finally {
    await stopChild(discServer);
    await rm(discDataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('adversarial POS stress suite: race conditions, dirty inputs, discounted partial return, cross-shift swap, last-item concurrency, crash rollback, RBAC & expense soft-delete', async () => {
  const sDir = await mkdtemp(join(appDir, '.test-stress-'));
  const sPort = await reservePort();
  const sUrl = `http://127.0.0.1:${sPort}`;
  let sLog = '';

  const stopSrv = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => {});
  };

  const startSrv = async () => {
    const child = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({
        PORT: String(sPort),
        RETAILOS_DATA_DIR: sDir,
        RETAILOS_COMPANY_NAME: 'متجر الضغط',
        RETAILOS_COMPANY_CODE: 'STRESS',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'فرع الضغط',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { sLog += chunk.toString(); });
    child.stderr.on('data', (chunk) => { sLog += chunk.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (child.exitCode !== null) throw new Error(`stressServer exited (${child.exitCode}): ${sLog}`);
      try {
        const res = await fetch(`${sUrl}/api/bootstrap`);
        if (res.ok) {
          await activateTestLicense(sUrl);
          return child;
        }
      } catch { /* transient failure: keep waiting or fall back */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`stressServer did not become ready: ${sLog}`);
  };

  let sServer = await startSrv();
  const sReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: sUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${sUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch { /* non-JSON body stays as text */ }
    return { response, payload };
  };

  try {
    assert.equal((await sReq('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'st_owner', ownerName: 'مدير الاختبار الشاق', password: 'Stress-Owner-Password-2026' },
    })).response.status, 201, sLog);

    const ownerLogin = await sReq('/api/login', {
      method: 'POST',
      body: { username: 'st_owner', password: 'Stress-Owner-Password-2026' },
    });
    assert.equal(ownerLogin.response.status, 200);
    const ownerCookie = ownerLogin.response.headers.get('set-cookie').split(';')[0];

    const data0 = await sReq('/api/data', { cookieStr: ownerCookie });
    const storeId = data0.payload.selectedStoreId;

    // Create Cashier user for Scenario 5 & Scenario 7
    const cashierCreate = await sReq('/api/users', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { username: 'st_cashier', password: 'Cashier-Password-2026', fullName: 'كاشير اختبار', role: 'CASHIER', storeId },
    });
    assert.equal(cashierCreate.response.status, 201);
    const cashierLogin = await sReq('/api/login', {
      method: 'POST',
      body: { username: 'st_cashier', password: 'Cashier-Password-2026' },
    });
    assert.equal(cashierLogin.response.status, 200);
    const cashierCookie = cashierLogin.response.headers.get('set-cookie').split(';')[0];

    const cat = await sReq('/api/categories', { method: 'POST', cookieStr: ownerCookie, body: { name: 'أحذية وحقائب' } });
    const shoeProd = await sReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'حذاء جلدي',
        sku: 'ST-SHOE',
        categoryId: cat.payload.id,
        hasVariants: true,
        options: [{ key: 'size', name: 'المقاس', values: ['42', '44'] }],
        variants: [
          { sku: 'ST-SHOE-42', barcode: '6221000000042', retailPrice: '50000', reorderPoint: '1', attributes: { size: '42' } },
          { sku: 'ST-SHOE-44', barcode: '6221000000044', retailPrice: '65000', reorderPoint: '1', attributes: { size: '44' } },
        ],
      },
    });
    assert.equal(shoeProd.response.status, 201);
    const bagProd = await sReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'حقيبة يد',
        sku: 'ST-BAG',
        categoryId: cat.payload.id,
        hasVariants: false,
        options: [],
        variants: [{ sku: 'ST-BAG-1', barcode: '6221000000999', retailPrice: '50000', reorderPoint: '1', attributes: {} }],
      },
    });
    assert.equal(bagProd.response.status, 201);
    const scarceProd = await sReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'حذاء قطعة أخيرة',
        sku: 'ST-LAST',
        categoryId: cat.payload.id,
        hasVariants: false,
        options: [],
        variants: [{ sku: 'ST-LAST-1', retailPrice: '20000', reorderPoint: '0', attributes: {} }],
      },
    });
    assert.equal(scarceProd.response.status, 201);

    const d1 = await sReq('/api/data', { cookieStr: ownerCookie });
    const shoeVariants = d1.payload.products.find((p) => p.id === shoeProd.payload.id).variants;
    const varShoe42 = shoeVariants.find((v) => v.sku === 'ST-SHOE-42').id;
    const varShoe44 = shoeVariants.find((v) => v.sku === 'ST-SHOE-44').id;
    const varBag = d1.payload.products.find((p) => p.id === bagProd.payload.id).variants[0].id;
    const varLast = d1.payload.products.find((p) => p.id === scarceProd.payload.id).variants[0].id;

    const sup = await sReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'مورد الضغط' } });
    const purRes = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: 'eeeeeeee-0001-4001-8001-000000000001',
        supplierId: sup.payload.id,
        storeId,
        invoiceNumber: 'SPUR-1',
        // 4*30000 + 2*35000 + 2*30000 + 1*10000 = 260000; initial paid 60000 -> due 200000
        totalAmount: '260000',
        paidAmount: '60000',
        paymentMethod: 'CASH',
        items: [
          { variantId: varShoe42, quantity: '4', unitCost: '30000' },
          { variantId: varShoe44, quantity: '2', unitCost: '35000' },
          { variantId: varBag, quantity: '2', unitCost: '30000' },
          { variantId: varLast, quantity: '1', unitCost: '10000' },
        ],
      },
    });
    assert.equal(purRes.response.status, 201, JSON.stringify(purRes.payload));
    const purDbId = purRes.payload.id;

    // -------------------------------------------------------------------------
    // SCENARIO 1: 5 parallel requests in <1s (Start Shift, Checkout, Payment, Close Shift)
    // -------------------------------------------------------------------------
    const startKey = randomUUID();
    const startBurst = await Promise.all(
      Array.from({ length: 5 }, () => sReq('/api/shifts/start', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: { storeId, idempotencyKey: startKey, openingCash: '10000' },
      })),
    );
    const createdShifts = startBurst.filter((r) => r.response.status === 201);
    const replayedShifts = startBurst.filter((r) => r.response.status === 200 || r.response.status === 201);
    assert.equal(createdShifts.length, 1, 'Exactly one shift start should create');
    assert.equal(replayedShifts.length, 5, 'All identical idempotency retries should succeed');
    const shift1Id = createdShifts[0].payload.shift.id;
    assert.ok(startBurst.every((r) => r.payload.shift.id === shift1Id));

    // Also verify cashier starts shift concurrently with different keys (distinct shift, 1 per user max)
    const cashierStartBurst = await Promise.all(
      Array.from({ length: 5 }, () => sReq('/api/shifts/start', {
        method: 'POST',
        cookieStr: cashierCookie,
        body: { storeId, openingCash: '0' },
      })),
    );
    assert.equal(cashierStartBurst.filter((r) => r.response.status === 201).length, 1);
    assert.equal(cashierStartBurst.filter((r) => r.response.status === 409).length, 4);

    // 5 parallel identical supplier payments with SAME idempotencyKey -> 1 payment applied
    const payKey = randomUUID();
    const payBurst = await Promise.all(
      Array.from({ length: 5 }, () => sReq(`/api/purchases/${purDbId}/payments`, {
        method: 'POST',
        cookieStr: ownerCookie,
        body: { idempotencyKey: payKey, amount: '40000', paymentMethod: 'CASH' },
      })),
    );
    assert.ok(payBurst.every((r) => r.response.status === 201));
    assert.equal(new Set(payBurst.map((r) => r.payload.id)).size, 1, 'Only 1 supplier payment record created');

    // -------------------------------------------------------------------------
    // SCENARIO 2 & 3: Dirty input rejection + Discounted 2-item sale -> Partial Return
    // -------------------------------------------------------------------------
    for (const dirtyBody of [
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '6221000000042' }], payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: "' OR 1=1" }], payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '-1' }], payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '19.99999' }], payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '1' }], cartDiscount: '19.99999', payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '1' }], cartDiscount: '6221000000042', payment: { method: 'CASH', amount: '50000' } },
      { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varShoe42, quantity: '1' }], cartDiscount: '50000', payment: { method: 'CASH', amount: '0' } },
    ]) {
      const dirtyRes = await sReq('/api/checkout', { method: 'POST', cookieStr: ownerCookie, body: dirtyBody });
      assert.equal(dirtyRes.response.status, 400, `Dirty checkout should fail 400: ${JSON.stringify(dirtyBody)}`);
    }

    // 5 parallel identical discounted checkouts: 1 Shoe42 (50000) + 1 Bag (50000) with 10000 cartDiscount = 90000
    const sale1Key = randomUUID();
    const checkoutBurst = await Promise.all(
      Array.from({ length: 5 }, () => sReq('/api/checkout', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: {
          storeId,
          idempotencyKey: sale1Key,
          cartDiscount: '10000',
          items: [
            { variantId: varShoe42, quantity: '1' },
            { variantId: varBag, quantity: '1' },
          ],
          payment: { method: 'CASH', amount: '90000' },
        },
      })),
    );
    assert.ok(checkoutBurst.every((r) => r.response.status === 201), JSON.stringify(checkoutBurst.map((r) => r.payload)));
    assert.equal(new Set(checkoutBurst.map((r) => r.payload.id)).size, 1, 'Race burst must produce exactly 1 invoice');
    const sale1 = checkoutBurst[0].payload;
    assert.equal(sale1.total.amount, '90000');
    assert.equal(sale1.discountTotal.amount, '10000');

    // Return 1 discounted Bag (allocated discount 5000 -> netRevenue 45000, COGS 30000)
    const bagLineId = sale1.items.find((i) => i.sku === 'ST-BAG-1').id;
    const partialRet = await sReq(`/api/sales/${sale1.id}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: randomUUID(),
        storeId,
        paymentMethod: 'CASH',
        items: [{ originalSaleItemId: bagLineId, quantity: '1' }],
      },
    });
    assert.equal(partialRet.response.status, 201, JSON.stringify(partialRet.payload));
    assert.equal(partialRet.payload.refundAmount, '45000', 'Pro-rata refund must equal 450.00 EGP (not 500.00)');

    // -------------------------------------------------------------------------
    // Close Shift #1 concurrently 5 times -> only 1 closes with expectedCash = 10000 + 90000 - 45000 = 55000
    // -------------------------------------------------------------------------
    const closeKey = randomUUID();
    const closeBurst = await Promise.all(
      Array.from({ length: 5 }, () => sReq('/api/shifts/end', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: { idempotencyKey: closeKey, shiftId: shift1Id, actualCash: '55000', handoverCash: '55000' },
      })),
    );
    assert.ok(closeBurst.every((r) => r.response.status === 200));
    assert.equal(closeBurst[0].payload.shift.expectedCash, '55000');

    // Snapshot Shift #1 before cross-shift exchange
    const shiftsBeforeSwap = await sReq(`/api/shifts?storeId=${storeId}`, { cookieStr: ownerCookie });
    const sh1Before = shiftsBeforeSwap.payload.shifts.find((s) => s.id === shift1Id);
    assert.equal(sh1Before.status, 'CLOSED');
    assert.equal(sh1Before.expectedCash, '55000');
    assert.equal(sh1Before.salesRevenue, '45000');
    assert.equal(sh1Before.returnedTotal, '45000');

    // -------------------------------------------------------------------------
    // SCENARIO 4: Cross-Closed-Shift Variant Swap (Shoe42 worth 45000 -> Shoe44 priced 65000, +20000 CASH diff)
    // -------------------------------------------------------------------------
    const sh2Res = await sReq('/api/shifts/start', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, idempotencyKey: randomUUID(), openingCash: '20000' },
    });
    assert.equal(sh2Res.response.status, 201);
    const shift2Id = sh2Res.payload.shift.id;

    const shoe42LineId = sale1.items.find((i) => i.sku === 'ST-SHOE-42').id;
    const swapRes = await sReq(`/api/sales/${sale1.id}/exchange`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: randomUUID(),
        storeId,
        paymentMethod: 'CASH',
        returnedItems: [{ originalSaleItemId: shoe42LineId, quantity: '1' }],
        replacementItems: [{ variantId: varShoe44, quantity: '1' }],
        notes: 'استبدال مقاس 42 إلى 44',
      },
    });
    assert.equal(swapRes.response.status, 201, JSON.stringify(swapRes.payload));
    assert.equal(swapRes.payload.returnedAmount, '45000');
    assert.equal(swapRes.payload.replacementTotal, '65000');
    assert.equal(swapRes.payload.netDifference, '20000');
    assert.equal(swapRes.payload.direction, 'CUSTOMER_PAYS');

    // Closed Shift #1 MUST remain completely unchanged; Shift #2 drawer MUST reflect +20000 (opening 20000 -> 40000)
    const shiftsAfterSwap = await sReq(`/api/shifts?storeId=${storeId}`, { cookieStr: ownerCookie });
    const sh1After = shiftsAfterSwap.payload.shifts.find((s) => s.id === shift1Id);
    const sh2After = shiftsAfterSwap.payload.shifts.find((s) => s.id === shift2Id);
    assert.equal(sh1After.expectedCash, sh1Before.expectedCash);
    assert.equal(sh1After.salesRevenue, sh1Before.salesRevenue);
    assert.equal(sh1After.returnedTotal, sh1Before.returnedTotal);
    assert.equal(sh1After.grossProfit, sh1Before.grossProfit);
    assert.equal(sh2After.expectedCash, '40000', 'Shift #2 drawer must gain only +200.00 EGP price diff');

    // Also test out-of-stock exchange rolls back return cleanly (try swapping remaining 0 qty or 3 qty Shoe44 when only 1 left)
    const saleSwap2 = swapRes.payload.saleId;
    const dAfterSwap = await sReq(`/api/sales/${saleSwap2}`, { cookieStr: ownerCookie });
    const shoe44LineId = dAfterSwap.payload.payload.items[0].id;
    const failSwap = await sReq(`/api/sales/${saleSwap2}/exchange`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        idempotencyKey: randomUUID(),
        storeId,
        paymentMethod: 'CASH',
        returnedItems: [{ originalSaleItemId: shoe44LineId, quantity: '1' }],
        replacementItems: [{ variantId: varShoe44, quantity: '5' }], // exceeds available stock!
      },
    });
    assert.ok([400, 409].includes(failSwap.response.status));
    const checkShoe44Inv = (await sReq('/api/data', { cookieStr: ownerCookie })).payload.products
      .find((p) => p.id === shoeProd.payload.id).variants.find((v) => v.id === varShoe44);
    assert.equal(checkShoe44Inv.quantity, '1', 'Failed exchange must roll back Shoe44 & return completely');

    // -------------------------------------------------------------------------
    // SCENARIO 5: Concurrent Last-Item Sale between 2 separate tabs/sessions (Owner & Cashier)
    // -------------------------------------------------------------------------
    const [tab1, tab2] = await Promise.all([
      sReq('/api/checkout', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varLast, quantity: '1' }], payment: { method: 'CASH', amount: '20000' } },
      }),
      sReq('/api/checkout', {
        method: 'POST',
        cookieStr: cashierCookie,
        body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varLast, quantity: '1' }], payment: { method: 'CASH', amount: '20000' } },
      }),
    ]);
    const statuses = [tab1.response.status, tab2.response.status].sort((a, b) => a - b);
    assert.ok(statuses[0] === 201 && (statuses[1] === 400 || statuses[1] === 409), `Expected one winner (201) and one stock rejection (400/409), got ${JSON.stringify(statuses)}`);
    const lastInv = (await sReq('/api/data', { cookieStr: ownerCookie })).payload.products
      .find((p) => p.id === scarceProd.payload.id).variants[0];
    assert.equal(lastInv.quantity, '0', 'Stock must never go negative');

    // -------------------------------------------------------------------------
    // SCENARIO 6: Mid-transaction abort (TCP reset mid-checkout + multi-line atomicity rollback)
    // -------------------------------------------------------------------------
    const dBeforeCrash = await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie });
    // (a) Premature TCP abort mid-checkout JSON
    await new Promise((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port: sPort }, () => {
        sock.write(`POST /api/checkout HTTP/1.1\r\nHost: 127.0.0.1:${sPort}\r\nCookie: ${ownerCookie}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"storeId":"${storeId}","items":[`);
        setTimeout(() => { sock.destroy(); resolve(); }, 30);
      });
      sock.on('error', () => resolve());
    });
    // (b) Multi-line checkout failing on line 2 (varLast has 0 stock) -> rolls back line 1 (varShoe42 stock) completely
    const shoe42BeforeCrash = (await sReq('/api/data', { cookieStr: ownerCookie })).payload.products
      .find((p) => p.id === shoeProd.payload.id).variants.find((v) => v.id === varShoe42).quantity;
    const partialCrashSale = await sReq('/api/checkout', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        idempotencyKey: randomUUID(),
        items: [
          { variantId: varShoe42, quantity: '1' },
          { variantId: varLast, quantity: '1' },
        ],
        payment: { method: 'CASH', amount: '70000' },
      },
    });
    assert.ok([400, 409].includes(partialCrashSale.response.status));
    const shoe42AfterCrash = (await sReq('/api/data', { cookieStr: ownerCookie })).payload.products
      .find((p) => p.id === shoeProd.payload.id).variants.find((v) => v.id === varShoe42).quantity;
    assert.equal(shoe42AfterCrash, shoe42BeforeCrash, 'Rolled-back multi-line checkout must leave line 1 stock untouched');
    const dAfterCrash = await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(dAfterCrash.payload.summary.netSales, dBeforeCrash.payload.summary.netSales);
    assert.equal(dAfterCrash.payload.summary.netCashFlow, dBeforeCrash.payload.summary.netCashFlow);

    // -------------------------------------------------------------------------
    // SCENARIO 7: Unauthorized Cashier RBAC + Older Expense Soft-Delete & Financial Path Recalculation
    // -------------------------------------------------------------------------
    assert.equal((await sReq(`/api/reports/profit-loss?from=${cairoDateIso()}&to=${cairoDateIso()}`, { cookieStr: cashierCookie })).response.status, 403);
    assert.equal((await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: cashierCookie })).response.status, 403);
    assert.equal((await sReq('/api/reports/export.csv?type=accounting', { cookieStr: cashierCookie })).response.status, 403);
    assert.equal((await sReq('/api/expenses', { cookieStr: cashierCookie })).response.status, 403);
    const spaRouteRes = await fetch(`${sUrl}/profit-loss`);
    assert.equal(spaRouteRes.status, 200);
    assert.ok((await spaRouteRes.text()).includes('id="app"'));

    // Record older expense E1 (10000 minor) on yesterday & newer expense E2 (5000 minor) today
    const todayStr = cairoDateIso();
    const olderDate = cairoDateIso(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const e1 = await sReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'UTILITIES', amount: '10000', paymentMethod: 'CASH_DRAWER', expenseDate: olderDate, notes: 'مصروف قديم للحذف' },
    });
    assert.equal(e1.response.status, 201);
    const e2 = await sReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'TRANSPORT', amount: '5000', paymentMethod: 'CASH_DRAWER', expenseDate: todayStr, notes: 'مصروف نقل باقي' },
    });
    assert.equal(e2.response.status, 201);

    // Cashier cannot delete expense
    assert.equal((await sReq(`/api/expenses/${e1.payload.id}`, { method: 'DELETE', cookieStr: cashierCookie })).response.status, 403);

    const fmWithE1 = await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(fmWithE1.payload.summary.totalExpensesPaid, '15000');
    const cashWithE1 = BigInt(fmWithE1.payload.summary.netCashFlow);
    const e2StepWithE1 = fmWithE1.payload.timeline.find((t) => t.id === e2.payload.id);

    // Owner deletes older expense E1
    const delE1 = await sReq(`/api/expenses/${e1.payload.id}`, { method: 'DELETE', cookieStr: ownerCookie });
    assert.equal(delE1.response.status, 200);
    // Double delete returns 409
    assert.equal((await sReq(`/api/expenses/${e1.payload.id}`, { method: 'DELETE', cookieStr: ownerCookie })).response.status, 409);

    const fmAfterDel = await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(fmAfterDel.payload.summary.totalExpensesPaid, '5000');
    assert.equal(BigInt(fmAfterDel.payload.summary.netCashFlow), cashWithE1 + 10000n, 'Net cash flow increases by 100.00 after deleting older expense');
    const e2StepAfterDel = fmAfterDel.payload.timeline.find((t) => t.id === e2.payload.id);
    assert.equal(BigInt(e2StepAfterDel.runningCash), BigInt(e2StepWithE1.runningCash) + 10000n, 'Subsequent runningCash in Financial Path must recalculate cleanly');

    const plAfterDel = await sReq(`/api/reports/profit-loss?from=${olderDate}&to=${todayStr}`, { cookieStr: ownerCookie });
    assert.equal(plAfterDel.payload.profitLoss.directExpenses.amount, '5000');
    assert.equal(plAfterDel.payload.profitLoss.operatingProfit.amount, fmAfterDel.payload.summary.operatingProfit);

    // -------------------------------------------------------------------------
    // SCENARIO 8: Cashier Returns/Exchanges, Auditor 403, Per-Supplier Invoice Index,
    // Transactional Sequences, Supplier Excess Credit Refund, Trial Balance & Opening Balances,
    // Daily Backup Key Export, and Graceful Control Shutdown
    // -------------------------------------------------------------------------
    const auditorCreate = await sReq('/api/users', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { username: 'st_auditor', password: 'Auditor-Password-2026', fullName: 'مراجع حسابات', role: 'AUDITOR' },
    });
    assert.equal(auditorCreate.response.status, 201);
    const auditorLogin = await sReq('/api/login', {
      method: 'POST',
      body: { username: 'st_auditor', password: 'Auditor-Password-2026' },
    });
    assert.equal(auditorLogin.response.status, 200);
    const auditorCookie = auditorLogin.response.headers.get('set-cookie').split(';')[0];

    // Auditor lacks POS_REFUND -> gets 403 on return and exchange
    assert.equal(
      (await sReq(`/api/sales/${sale1.id}/returns`, {
        method: 'POST',
        cookieStr: auditorCookie,
        body: { storeId, idempotencyKey: randomUUID(), paymentMethod: 'CASH', items: [{ originalSaleItemId: sale1.items[0].id, quantity: '1' }] },
      })).response.status,
      403,
    );
    assert.equal(
      (await sReq(`/api/sales/${sale1.id}/exchange`, {
        method: 'POST',
        cookieStr: auditorCookie,
        body: { storeId, idempotencyKey: randomUUID(), paymentMethod: 'CASH', returnedItems: [{ originalSaleItemId: sale1.items[0].id, quantity: '1' }], replacementItems: [{ variantId: varShoe44, quantity: '1' }] },
      })).response.status,
      403,
    );

    // Cashier executes a normal customer return via explicit POS_REFUND permission
    const cashierSaleRes = await sReq('/api/checkout', {
      method: 'POST',
      cookieStr: cashierCookie,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varBag, quantity: '1' }], payment: { method: 'CASH', amount: '50000' } },
    });
    assert.equal(cashierSaleRes.response.status, 201);
    const cashierReturnRes = await sReq(`/api/sales/${cashierSaleRes.payload.id}/returns`, {
      method: 'POST',
      cookieStr: cashierCookie,
      body: { storeId, idempotencyKey: randomUUID(), paymentMethod: 'CASH', items: [{ originalSaleItemId: cashierSaleRes.payload.items[0].id, quantity: '1' }] },
    });
    assert.equal(cashierReturnRes.response.status, 201, JSON.stringify(cashierReturnRes.payload));

    // Failed checkout must NOT increment INV- sequence
    const seqNumBefore = Number.parseInt(cashierSaleRes.payload.saleNumber.replace('INV-', ''), 10);
    const failedCheckout = await sReq('/api/checkout', {
      method: 'POST',
      cookieStr: cashierCookie,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varBag, quantity: '99' }], payment: { method: 'CASH', amount: '990000' } },
    });
    assert.equal(failedCheckout.response.status, 400);
    const nextOkCheckout = await sReq('/api/checkout', {
      method: 'POST',
      cookieStr: cashierCookie,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId: varBag, quantity: '1' }], payment: { method: 'CASH', amount: '50000' } },
    });
    assert.equal(nextOkCheckout.response.status, 201);
    assert.equal(nextOkCheckout.payload.saleNumber, `INV-${seqNumBefore + 1}`, 'Failed checkout must not create sequence gaps');

    // Different suppliers MAY reuse same invoiceNumber; same supplier duplicate returns 409
    const sup2 = await sReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر ثاني' } });
    assert.equal(sup2.response.status, 201);
    const purSup1SameInv = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId, supplierId: sup.payload.id, idempotencyKey: randomUUID(), invoiceNumber: 'EXT-SHARED-77',
        totalAmount: '10000', paidAmount: '10000', paymentMethod: 'CASH',
        items: [{ variantId: varBag, quantity: '1', unitCost: '10000' }],
      },
    });
    assert.equal(purSup1SameInv.response.status, 201);
    const purSup2SameInv = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId, supplierId: sup2.payload.id, idempotencyKey: randomUUID(), invoiceNumber: 'EXT-SHARED-77',
        totalAmount: '10000', paidAmount: '10000', paymentMethod: 'CASH',
        items: [{ variantId: varBag, quantity: '1', unitCost: '10000' }],
      },
    });
    assert.equal(purSup2SameInv.response.status, 201, 'Different supplier must be allowed same invoice number');
    const purSup1Dup = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId, supplierId: sup.payload.id, idempotencyKey: randomUUID(), invoiceNumber: 'EXT-SHARED-77',
        totalAmount: '10000', paidAmount: '10000', paymentMethod: 'CASH',
        items: [{ variantId: varBag, quantity: '1', unitCost: '10000' }],
      },
    });
    assert.equal(purSup1Dup.response.status, 409, 'Same supplier duplicate invoice number must be rejected');

    // Return item to sup2 -> creates excess creditFromSupplier = 10000, then collect cash refund
    const sup2Boot = await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const sup2Pur = sup2Boot.payload.suppliers.find((s) => s.id === sup2.payload.id).purchases[0];
    const sup2Ret = await sReq(`/api/purchases/${sup2Pur.id}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, items: [{ purchaseItemId: sup2Pur.items[0].id, quantity: '1' }] },
    });
    assert.equal(sup2Ret.response.status, 201);
    const sup2AfterRet = (await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie })).payload.suppliers.find((s) => s.id === sup2.payload.id);
    assert.equal(sup2AfterRet.creditFromSupplier, '10000');
    assert.equal(sup2AfterRet.balanceDue, '-10000');

    const sup2Refund = await sReq(`/api/suppliers/${sup2.payload.id}/refunds`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, idempotencyKey: randomUUID(), amount: '10000', paymentMethod: 'CASH_SAFE', referenceNumber: 'REF-SUP2' },
    });
    assert.equal(sup2Refund.response.status, 201, JSON.stringify(sup2Refund.payload));
    const sup2Settled = (await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie })).payload.suppliers.find((s) => s.id === sup2.payload.id);
    assert.equal(sup2Settled.creditFromSupplier, '0');
    assert.equal(sup2Settled.balanceDue, '0');

    // Opening balances & Trial Balance reconciliation
    const openingRes = await sReq('/api/accounting/opening-balances', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, idempotencyKey: randomUUID(), entryDate: todayStr, cashDrawer: '50000', cashSafe: '100000', bank: '0', inventory: '0', supplierPayables: '0', notes: 'افتتاحي' },
    });
    assert.equal(openingRes.response.status, 201, JSON.stringify(openingRes.payload));
    const tbRes = await sReq(`/api/reports/trial-balance?storeId=${storeId}`, { cookieStr: auditorCookie });
    assert.equal(tbRes.response.status, 200);
    assert.equal(tbRes.payload.totals.isBalanced, true);
    assert.equal(tbRes.payload.totals.debitTotal.amount, tbRes.payload.totals.creditTotal.amount);
    assert.equal(tbRes.payload.totals.debitBalanceTotal.amount, tbRes.payload.totals.creditBalanceTotal.amount);
    assert.ok(tbRes.payload.accounts.some((a) => a.accountCode === '3010' && a.creditBalance.amount === '150000'));

    // Financial Path & P&L Cash Position reconcile on final balances
    const fmFinal = await sReq(`/api/reports/financial-map?storeId=${storeId}`, { cookieStr: ownerCookie });
    const plFinal = await sReq(`/api/reports/profit-loss?from=2026-11-01&to=${todayStr}&tzOffset=-120`, { cookieStr: ownerCookie });
    assert.equal(fmFinal.payload.summary.netCashFlow, plFinal.payload.cashPosition.netCashRemaining.amount);

    // Owner daily backup key export & recovery
    assert.equal((await sReq('/api/backups/daily/key-export', { method: 'POST', cookieStr: cashierCookie, body: { currentPassword: 'Cashier-Password-2026' } })).response.status, 403);
    assert.equal((await sReq('/api/backups/daily/key-export', { method: 'POST', cookieStr: ownerCookie, body: { currentPassword: 'Wrong-Password-2026' } })).response.status, 400);
    const keyExportRes = await sReq('/api/backups/daily/key-export', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { currentPassword: 'Stress-Owner-Password-2026' },
    });
    assert.equal(keyExportRes.response.status, 200);
    assert.ok(keyExportRes.payload.dailyBackupKey.length >= 12);

    // Employee password reset revokes existing sessions and invalidates the old password
    const pwReset = await sReq(`/api/users/${cashierCreate.payload.id}`, {
      method: 'PATCH',
      cookieStr: ownerCookie,
      body: { newPassword: 'Cashier-Rotated-Password-2026' },
    });
    assert.equal(pwReset.response.status, 200, JSON.stringify(pwReset.payload));
    assert.equal(pwReset.payload.passwordReset, true);
    assert.equal(pwReset.payload.sessionsRevoked, true);
    assert.equal((await sReq('/api/data', { cookieStr: cashierCookie })).response.status, 401);
    assert.equal((await sReq('/api/login', { method: 'POST', body: { username: 'st_cashier', password: 'Cashier-Password-2026' } })).response.status, 401);
    const rotatedLogin = await sReq('/api/login', { method: 'POST', body: { username: 'st_cashier', password: 'Cashier-Rotated-Password-2026' } });
    assert.equal(rotatedLogin.response.status, 200);
    const rotatedCookie = rotatedLogin.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await sReq('/api/data', { cookieStr: rotatedCookie })).response.status, 200);

    // Graceful shutdown control file & /api/internal/shutdown
    const ctrlRaw = await readFile(join(sDir, '.retailos-control.json'), 'utf8');
    const ctrl = JSON.parse(ctrlRaw);
    assert.ok(ctrl.token && ctrl.pid);
    const badStop = await fetch(`${sUrl}/api/internal/shutdown`, { method: 'POST', headers: { 'x-retailos-shutdown-token': 'invalid' } });
    assert.equal(badStop.status, 401);

    const exitPromise = once(sServer, 'exit');
    const stopRes = await fetch(`${sUrl}/api/internal/shutdown`, {
      method: 'POST',
      headers: { 'x-retailos-shutdown-token': ctrl.token },
    });
    assert.equal(stopRes.status, 202);
    const [gracefulExitCode] = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Server did not exit gracefully: ${sLog}`)), 20000)),
    ]);
    assert.equal(gracefulExitCode, 0);
    await assert.rejects(readFile(join(sDir, '.retailos-control.json'), 'utf8'));
    const dailyFiles = await readdir(join(sDir, 'backups', 'daily'));
    assert.ok(dailyFiles.some((name) => /^retailos-daily-\d{4}-\d{2}-\d{2}\.(rfbackup|sqlite)$/.test(name)), dailyFiles.join(','));
    sServer = null;
  } finally {
    await stopSrv(sServer);
    await rm(sDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Stage 1 supplier balance regression: search+refunds, pagination+search, legacy initial_paid_amount deduplication, isolation, and settlement', async () => {
  const port = await reservePort();
  const sUrl = `http://127.0.0.1:${port}`;
  const sDir = await mkdtemp(join(appDir, '.test-data-supreg-'));
  let log = '';
  let srv = null;

  const startTestServer = async () => {
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({ PORT: String(port), RETAILOS_DATA_DIR: sDir, RETAILOS_COMPANY_NAME: 'شركة الموردين', RETAILOS_COMPANY_CODE: 'SUP_REG', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { log += c.toString(); });
    proc.stderr.on('data', (c) => { log += c.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}\n${log}`);
      try { if ((await fetch(`${sUrl}/api/bootstrap`)).ok) { await activateTestLicense(sUrl); return proc; } } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`Timeout\n${log}`);
  };

  const stopTestServer = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
    }
  };

  const sReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: sUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${sUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    srv = await startTestServer();
    const setup = await sReq('/api/setup', { method: 'POST', body: { ownerName: 'مالك الموردين', ownerUsername: 'sup_owner', password: 'Supplier-Owner-Password-2026' } });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
    const login = await sReq('/api/login', { method: 'POST', body: { username: 'sup_owner', password: 'Supplier-Owner-Password-2026' } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const ownerCookie = login.response.headers.get('set-cookie').split(';')[0];

    const dataBoot = await sReq('/api/data', { cookieStr: ownerCookie });
    const storeId = dataBoot.payload.stores[0].id;
    const prod = await sReq('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { name: 'تيشيرت قطن', sku: 'SUP-TEE', hasVariants: true, options: [{ key: 'size', name: 'المقاس', values: ['M'] }], variants: [{ sku: 'SUP-TEE-M', attributes: { size: 'M' }, retailPrice: '20000', reorderPoint: '1' }] },
    });
    assert.equal(prod.response.status, 201);
    const variantId = (await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie })).payload.products[0].variants[0].id;

    const supRefunds = (await sReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر الاسترداد' } })).payload.id;
    const supMulti = (await sReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر الدفعات المتعددة' } })).payload.id;
    const supLegacy = (await sReq('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر الرصيد التراكمي' } })).payload.id;

    // 1. Purchase without initial payment (10000 due) -> 2. partial payment (3000) -> 3. multiple payments (4000) -> 11. zero after settlement (3000)
    const pNoInit = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, supplierId: supMulti, idempotencyKey: randomUUID(), invoiceNumber: 'SM-NOINIT-1', totalAmount: '10000', paidAmount: '0', paymentMethod: 'CASH', items: [{ variantId, quantity: '1', unitCost: '10000' }] },
    });
    assert.equal(pNoInit.response.status, 201);
    assert.equal((await sReq(`/api/purchases/${pNoInit.payload.id}/payments`, { method: 'POST', cookieStr: ownerCookie, body: { idempotencyKey: randomUUID(), amount: '3000', paymentMethod: 'CASH' } })).response.status, 201);
    assert.equal((await sReq(`/api/purchases/${pNoInit.payload.id}/payments`, { method: 'POST', cookieStr: ownerCookie, body: { idempotencyKey: randomUUID(), amount: '4000', paymentMethod: 'BANK_TRANSFER' } })).response.status, 201);
    // 12. Payment exceeding remaining 3000 must fail
    assert.equal((await sReq(`/api/purchases/${pNoInit.payload.id}/payments`, { method: 'POST', cookieStr: ownerCookie, body: { idempotencyKey: randomUUID(), amount: '3001', paymentMethod: 'CASH' } })).response.status, 400);
    // Settle final 3000 -> zero due
    assert.equal((await sReq(`/api/purchases/${pNoInit.payload.id}/payments`, { method: 'POST', cookieStr: ownerCookie, body: { idempotencyKey: randomUUID(), amount: '3000', paymentMethod: 'CASH' } })).response.status, 201);

    // Purchase with initial payment (10000 billed, 6000 paid -> 4000 due) for pagination + search
    for (let i = 1; i <= 3; i += 1) {
      const pr = await sReq('/api/purchases', {
        method: 'POST',
        cookieStr: ownerCookie,
        body: { storeId, supplierId: supMulti, idempotencyKey: randomUUID(), invoiceNumber: `SM-PAGE-${i}`, totalAmount: '10000', paidAmount: '6000', paymentMethod: 'CASH', items: [{ variantId, quantity: '1', unitCost: '10000' }] },
      });
      assert.equal(pr.response.status, 201);
    }

    // 5 & 6. Supplier return + excess credit + partial refund + over-refund block (supplier refunds)
    const pRetTarget = await sReq('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, supplierId: supRefunds, idempotencyKey: randomUUID(), invoiceNumber: 'SR-FLOW-1', totalAmount: '20000', paidAmount: '20000', paymentMethod: 'CASH', items: [{ variantId, quantity: '2', unitCost: '10000' }] },
    });
    assert.equal(pRetTarget.response.status, 201);
    const bootMid = await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const retPur = bootMid.payload.suppliers.find((s) => s.id === supRefunds).purchases[0];
    const supRetRes = await sReq(`/api/purchases/${retPur.id}/returns`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, items: [{ purchaseItemId: retPur.items[0].id, quantity: '2' }] },
    });
    assert.equal(supRetRes.response.status, 201);
    // Refund 15000 out of 20000 excess credit -> remaining credit 5000 (balanceDue = -5000)
    const supRfRes = await sReq(`/api/suppliers/${supRefunds}/refunds`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, idempotencyKey: randomUUID(), amount: '15000', paymentMethod: 'CASH', referenceNumber: 'RF-777', notes: 'استرداد جزئي' },
    });
    assert.equal(supRfRes.response.status, 201);
    assert.equal(supRfRes.payload.remainingCredit, '5000');
    // 12. Refund exceeding remaining 5000 must fail
    assert.equal((await sReq(`/api/suppliers/${supRefunds}/refunds`, {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, idempotencyKey: randomUUID(), amount: '5001', paymentMethod: 'CASH' },
    })).response.status, 400);

    // 7, 8, 9, 10: Compare normal listing, search by supplier name (with refunds), search without refunds (supMulti), pagination+search!
    const allList = await sReq(`/api/purchases?storeId=${storeId}&offset=0&limit=50`, { cookieStr: ownerCookie });
    const searchWithRefunds = await sReq(`/api/purchases?storeId=${storeId}&search=${encodeURIComponent('تاجر الاسترداد')}`, { cookieStr: ownerCookie });
    const searchByRefundRef = await sReq(`/api/purchases?storeId=${storeId}&search=RF-777`, { cookieStr: ownerCookie });
    const searchByInvoice = await sReq(`/api/purchases?storeId=${storeId}&search=SR-FLOW-1`, { cookieStr: ownerCookie });
    const searchNoRefunds = await sReq(`/api/purchases?storeId=${storeId}&search=${encodeURIComponent('تاجر الدفعات المتعددة')}&offset=1&limit=2`, { cookieStr: ownerCookie });

    const normSupRef = allList.payload.payload.suppliers.find((s) => s.id === supRefunds);
    const searchedSupRef = searchWithRefunds.payload.payload.suppliers.find((s) => s.id === supRefunds);
    const searchedByInvSup = searchByInvoice.payload.payload.suppliers.find((s) => s.id === supRefunds);
    const searchedByRfRefSup = searchByRefundRef.payload.payload.suppliers.find((s) => s.id === supRefunds);

    assert.equal(normSupRef.balanceDue, '-5000');
    assert.equal(normSupRef.refundedToStore, '15000');
    assert.equal(searchedSupRef.balanceDue, normSupRef.balanceDue, 'Searching for supplier must NOT change balance');
    assert.equal(searchedSupRef.refundedToStore, '15000', 'Refunds must not be omitted under search');
    assert.equal(searchedByInvSup.balanceDue, '-5000');
    assert.equal(searchedByRfRefSup.balanceDue, '-5000');

    // Pagination + search must preserve complete totals for supMulti (0 on SM-NOINIT-1 + 3*4000 = 12000 due)
    assert.equal(searchNoRefunds.payload.payload.total, 4);
    assert.equal(searchNoRefunds.payload.payload.purchases.length, 2);
    const searchedMulti = searchNoRefunds.payload.payload.suppliers.find((s) => s.id === supMulti);
    assert.equal(searchedMulti.balanceDue, '12000');
    assert.equal(searchedMulti.refundedToStore, '0');
    // Unrelated supRefunds must not leak into supMulti search
    assert.equal(searchNoRefunds.payload.payload.suppliers.some((s) => s.id === supRefunds), false);

    // Issue 2 check against server HTTP endpoints: stop server briefly to seed BOTH legacy initial_paid_amount patterns
    await stopTestServer(srv);
    srv = null;
    const mgr = new SqliteDatabaseManager({ filename: join(sDir, 'retailos.sqlite') });
    mgr.connect();
    const raw = mgr.getRawDatabase();
    const tenantId = raw.prepare('SELECT id FROM tenants LIMIT 1').get().id;
    const ownerId = raw.prepare("SELECT id FROM users WHERE role = 'OWNER' LIMIT 1").get().id;
    const periodId = raw.prepare("SELECT id FROM accounting_periods WHERE status = 'OPEN' LIMIT 1").get().id;
    const acc1300 = raw.prepare("SELECT id FROM accounts WHERE tenant_id = ? AND account_code = '1300'").get(tenantId).id;
    const acc1010 = raw.prepare("SELECT id FROM accounts WHERE tenant_id = ? AND account_code = '1010'").get(tenantId).id;
    const acc2010 = raw.prepare("SELECT id FROM accounts WHERE tenant_id = ? AND account_code = '2010'").get(tenantId).id;
    const txTime = new Date().toISOString();
    const txDay = cairoDateIso();

    // Legacy row 1: ONLY initial_paid_amount = 4000 (no :payment:initial row in supplier_payments)
    const legOnlyId = randomUUID();
    const legOnlyKey = randomUUID();
    raw.prepare(`INSERT INTO supplier_purchases (id, tenant_id, store_id, supplier_id, idempotency_key, invoice_number, purchased_at, total_amount, initial_paid_amount, currency, notes, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'LEG-HTTP-1', ?, 10000, 4000, 'EGP', NULL, ?)`).run(legOnlyId, tenantId, storeId, supLegacy, legOnlyKey, txTime, ownerId);
    const je1 = randomUUID();
    raw.prepare(`INSERT INTO journal_entries (id, tenant_id, store_id, period_id, entry_number, entry_date, source_type, source_id, idempotency_key, status, created_by_user_id) VALUES (?, ?, ?, ?, 'J-LEG-1', ?, 'PURCHASE', ?, ?, 'POSTED', ?)`).run(je1, tenantId, storeId, periodId, txDay, legOnlyId, `purchase:${legOnlyKey}`, ownerId);
    raw.prepare(`INSERT INTO journal_lines (id, journal_entry_id, account_id, entry_type, amount, currency, memo) VALUES (?, ?, ?, 'DEBIT', 10000, 'EGP', 'leg'), (?, ?, ?, 'CREDIT', 4000, 'EGP', 'leg'), (?, ?, ?, 'CREDIT', 6000, 'EGP', 'leg')`).run(randomUUID(), je1, acc1300, randomUUID(), je1, acc1010, randomUUID(), je1, acc2010);

    // Legacy row 2: initial_paid_amount = 5000 AND duplicate :payment:initial row = 5000 (must count ONCE = 5000, NOT 10000)
    const legDupId = randomUUID();
    const legDupKey = randomUUID();
    raw.prepare(`INSERT INTO supplier_purchases (id, tenant_id, store_id, supplier_id, idempotency_key, invoice_number, purchased_at, total_amount, initial_paid_amount, currency, notes, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'LEG-HTTP-2', ?, 12000, 5000, 'EGP', NULL, ?)`).run(legDupId, tenantId, storeId, supLegacy, legDupKey, txTime, ownerId);
    raw.prepare(`INSERT INTO supplier_payments (id, tenant_id, supplier_id, purchase_id, amount, currency, payment_method, idempotency_key, paid_at, created_by_user_id) VALUES (?, ?, ?, ?, 5000, 'EGP', 'CASH', ?, ?, ?)`).run(`${legDupId}:payment:initial`, tenantId, supLegacy, legDupId, `${legDupKey}:initial`, txTime, ownerId);
    const je2 = randomUUID();
    raw.prepare(`INSERT INTO journal_entries (id, tenant_id, store_id, period_id, entry_number, entry_date, source_type, source_id, idempotency_key, status, created_by_user_id) VALUES (?, ?, ?, ?, 'J-LEG-2', ?, 'PURCHASE', ?, ?, 'POSTED', ?)`).run(je2, tenantId, storeId, periodId, txDay, legDupId, `purchase:${legDupKey}`, ownerId);
    raw.prepare(`INSERT INTO journal_lines (id, journal_entry_id, account_id, entry_type, amount, currency, memo) VALUES (?, ?, ?, 'DEBIT', 12000, 'EGP', 'dup'), (?, ?, ?, 'CREDIT', 5000, 'EGP', 'dup'), (?, ?, ?, 'CREDIT', 7000, 'EGP', 'dup')`).run(randomUUID(), je2, acc1300, randomUUID(), je2, acc1010, randomUUID(), je2, acc2010);
    await mgr.close();

    srv = await startTestServer();
    const bootAfterLegacy = await sReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    const legSupData = bootAfterLegacy.payload.suppliers.find((s) => s.id === supLegacy);
    // Total billed = 10000 + 12000 = 22000; paid = 4000 + 5000 = 9000 (NOT 14000!); due = 13000 (matches GL 2010 = 6000 + 7000!)
    assert.equal(legSupData.totalPurchased, '22000');
    assert.equal(legSupData.totalPaid, '9000', 'Must not double-count legacy initial_paid_amount');
    assert.equal(legSupData.balanceDue, '13000');

    const legList = await sReq(`/api/purchases?storeId=${storeId}&search=${encodeURIComponent('تاجر الرصيد التراكمي')}`, { cookieStr: ownerCookie });
    const legListSup = legList.payload.payload.suppliers.find((s) => s.id === supLegacy);
    assert.equal(legListSup.totalPaid, '9000');
    assert.equal(legListSup.balanceDue, '13000');

    // Reconcile GL Accounts Payable 2010 === total supplier balanceDue across all suppliers!
    const tb = await sReq(`/api/reports/trial-balance?storeId=${storeId}`, { cookieStr: ownerCookie });
    const acc2010Tb = tb.payload.accounts.find((a) => a.accountCode === '2010');
    const net2010Credit = BigInt(acc2010Tb.creditTotal.amount) - BigInt(acc2010Tb.debitTotal.amount);
    const totalDueAcrossAllSuppliers = bootAfterLegacy.payload.suppliers.reduce((s, sup) => s + BigInt(sup.balanceDue), 0n);
    assert.equal(totalDueAcrossAllSuppliers, net2010Credit, 'Total supplier balances must equal GL Account 2010 payable');
  } finally {
    await stopTestServer(srv);
    await rm(sDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Pre-launch hardening: duplicate opening balances 409 guard and Trial Balance cumulative balances across date boundaries', async () => {
  const port = await reservePort();
  const hUrl = `http://127.0.0.1:${port}`;
  const hDir = await mkdtemp(join(appDir, '.test-data-harden-'));
  let log = '';
  let srv = null;

  const startServer = async () => {
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({ PORT: String(port), RETAILOS_DATA_DIR: hDir, RETAILOS_COMPANY_NAME: 'شركة التحصين', RETAILOS_COMPANY_CODE: 'HARDEN_TEST', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { log += c.toString(); });
    proc.stderr.on('data', (c) => { log += c.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}\n${log}`);
      try { if ((await fetch(`${hUrl}/api/bootstrap`)).ok) { await activateTestLicense(hUrl); return proc; } } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`Timeout\n${log}`);
  };

  const stopServer = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
    }
  };

  const hReq = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: hUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${hUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  try {
    srv = await startServer();
    const setup = await hReq('/api/setup', { method: 'POST', body: { ownerName: 'مالك التحصين', ownerUsername: 'harden_owner', password: 'Harden-Owner-Password-2026' } });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
    const login = await hReq('/api/login', { method: 'POST', body: { username: 'harden_owner', password: 'Harden-Owner-Password-2026' } });
    assert.equal(login.response.status, 200);
    const ownerCookie = login.response.headers.get('set-cookie').split(';')[0];

    const dataBefore = await hReq('/api/data', { cookieStr: ownerCookie });
    const storeId = dataBefore.payload.stores[0].id;
    assert.equal(dataBefore.payload.openingBalanceEntry, null);

    // 1. Initial Opening Balance on 2026-10-01 -> 201 Created
    const obKey1 = randomUUID();
    const obPayload1 = { storeId, idempotencyKey: obKey1, entryDate: '2026-10-01', cashDrawer: '100000', cashSafe: '200000', bank: '0', inventory: '0', supplierPayables: '0', notes: 'أول تشغيل' };
    const ob1 = await hReq('/api/accounting/opening-balances', { method: 'POST', cookieStr: ownerCookie, body: obPayload1 });
    assert.equal(ob1.response.status, 201, JSON.stringify(ob1.payload));

    // Replaying exact same idempotencyKey stays idempotent (201, same entry id)
    const obReplay = await hReq('/api/accounting/opening-balances', { method: 'POST', cookieStr: ownerCookie, body: obPayload1 });
    assert.equal(obReplay.response.status, 201);
    assert.equal(obReplay.payload.id, ob1.payload.id);

    // Submitting a second opening balance with a new key for the same store must fail with 409 Conflict
    const obDup = await hReq('/api/accounting/opening-balances', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { ...obPayload1, idempotencyKey: randomUUID(), cashDrawer: '50000' },
    });
    assert.equal(obDup.response.status, 409, JSON.stringify(obDup.payload));
    assert.match(obDup.payload.error ?? '', /مسبق/);

    const dataAfterOb = await hReq(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie });
    assert.equal(dataAfterOb.payload.openingBalanceEntry?.id, ob1.payload.id);
    assert.equal(dataAfterOb.payload.openingBalanceEntry?.entryDate, '2026-10-01');

    // 2. Trial Balance cumulative closing balance across date boundaries
    // Oct movement: direct expense 25000 from CASH_DRAWER (1010 -> 75000, 6090 -> 25000)
    assert.equal((await hReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'UTILITIES', amount: '25000', paymentMethod: 'CASH_DRAWER', expenseDate: '2026-10-15', notes: 'مصروف أكتوبر' },
    })).response.status, 201);

    // Nov movement: direct expense 15000 from CASH_SAFE (1015 -> 185000, 6090 -> 40000)
    assert.equal((await hReq('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'SUPPLIES', amount: '15000', paymentMethod: 'CASH_SAFE', expenseDate: '2026-11-10', notes: 'مصروف نوفمبر' },
    })).response.status, 201);

    // Filtered query strictly on November 2026 must carry forward October cumulative balances!
    const novTb = await hReq(`/api/reports/trial-balance?storeId=${storeId}&from=2026-11-01&to=2026-11-30`, { cookieStr: ownerCookie });
    assert.equal(novTb.response.status, 200);
    assert.equal(novTb.payload.totals.isBalanced, true);
    const acc = (code) => novTb.payload.accounts.find((a) => a.accountCode === code);

    assert.equal(acc('1010').openingDebitBalance.amount, '75000');
    assert.equal(acc('1010').periodDebit.amount, '0');
    assert.equal(acc('1010').debitBalance.amount, '75000', '1010 cumulative closing balance must include prior months');

    assert.equal(acc('1015').openingDebitBalance.amount, '200000');
    assert.equal(acc('1015').periodCredit.amount, '15000');
    assert.equal(acc('1015').debitBalance.amount, '185000');

    assert.equal(acc('3010').openingCreditBalance.amount, '300000');
    assert.equal(acc('3010').periodCredit.amount, '0');
    assert.equal(acc('3010').creditBalance.amount, '300000');

    assert.equal(acc('6090').openingDebitBalance.amount, '25000');
    assert.equal(acc('6090').periodDebit.amount, '15000');
    assert.equal(acc('6090').debitBalance.amount, '40000');

    assert.equal(novTb.payload.totals.openingDebitBalanceTotal.amount, '300000');
    assert.equal(novTb.payload.totals.openingCreditBalanceTotal.amount, '300000');
    assert.equal(novTb.payload.totals.debitTotal.amount, '15000');
    assert.equal(novTb.payload.totals.creditTotal.amount, '15000');
    assert.equal(novTb.payload.totals.debitBalanceTotal.amount, '300000');
    assert.equal(novTb.payload.totals.creditBalanceTotal.amount, '300000');
  } finally {
    await stopServer(srv);
    await rm(hDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Final POS & accounting regression: split cash+electronic checkout GL (1010/1020/4010) and cumulative Trial Balance across pre-opening, opening, and reversed expenses', async () => {
  const port = await reservePort();
  const sUrl = `http://127.0.0.1:${port}`;
  const sDir = await mkdtemp(join(appDir, '.test-data-split-'));
  let log = '';
  let srv = null;

  const startServer = async () => {
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({ PORT: String(port), RETAILOS_DATA_DIR: sDir, RETAILOS_COMPANY_NAME: 'شركة الدفع المجزأ', RETAILOS_COMPANY_CODE: 'SPLIT_TEST', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { log += c.toString(); });
    proc.stderr.on('data', (c) => { log += c.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}\n${log}`);
      try { if ((await fetch(`${sUrl}/api/bootstrap`)).ok) { await activateTestLicense(sUrl); return proc; } } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`Timeout\n${log}`);
  };

  const stopServer = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
    }
  };

  const req = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: sUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${sUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  const monthRange = (offsetMonths) => {
    const today = cairoDateIso();
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7)) - 1 + offsetMonths;
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    const ym = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const last = String(end.getUTCDate()).padStart(2, '0');
    return { ym, from: `${ym}-01`, to: `${ym}-${last}` };
  };

  try {
    srv = await startServer();
    assert.equal((await req('/api/setup', { method: 'POST', body: { ownerName: 'مالك المجزأ', ownerUsername: 'split_owner', password: 'Split-Owner-Password-2026' } })).response.status, 201);
    const login = await req('/api/login', { method: 'POST', body: { username: 'split_owner', password: 'Split-Owner-Password-2026' } });
    assert.equal(login.response.status, 200);
    const cookieStr = login.response.headers.get('set-cookie').split(';')[0];

    const boot = await req('/api/data', { cookieStr });
    const storeId = boot.payload.stores[0].id;

    const mPre = monthRange(-3);
    const mOpen = monthRange(-2);
    const mMid = monthRange(-1);
    const mCur = monthRange(0);

    // Pre-opening range: all accounts zero and balanced
    const preTb = await req(`/api/reports/trial-balance?storeId=${storeId}&from=${mPre.from}&to=${mPre.to}`, { cookieStr });
    assert.equal(preTb.response.status, 200);
    assert.equal(preTb.payload.totals.isBalanced, true);
    assert.equal(preTb.payload.totals.debitBalanceTotal.amount, '0');

    // Opening balance in mOpen-01: Drawer=100000, Safe=100000 -> Equity=200000
    assert.equal((await req('/api/accounting/opening-balances', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), entryDate: mOpen.from, cashDrawer: '100000', cashSafe: '100000', bank: '0', inventory: '0', supplierPayables: '0', notes: 'افتتاحي' },
    })).response.status, 201);

    // Two expenses in mOpen: 10000 (to reverse later) + 30000 (stays active) from CASH_DRAWER
    const exp1 = await req('/api/expenses', {
      method: 'POST',
      cookieStr,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'SUPPLIES', amount: '10000', paymentMethod: 'CASH_DRAWER', expenseDate: `${mOpen.ym}-05`, notes: 'مصروف مسترجع' },
    });
    assert.equal(exp1.response.status, 201);
    assert.equal((await req('/api/expenses', {
      method: 'POST',
      cookieStr,
      body: { idempotencyKey: randomUUID(), storeId, categoryCode: 'UTILITIES', amount: '30000', paymentMethod: 'CASH_DRAWER', expenseDate: `${mOpen.ym}-10`, notes: 'مصروف ثابت' },
    })).response.status, 201);

    // Mid-month range (no transactions in mMid): cumulative opening carried cleanly (1010=60000, 6090=40000, 3010=200000)
    const midTb = await req(`/api/reports/trial-balance?storeId=${storeId}&from=${mMid.from}&to=${mMid.to}`, { cookieStr });
    assert.equal(midTb.payload.totals.isBalanced, true);
    const midAcc = (c) => midTb.payload.accounts.find((a) => a.accountCode === c);
    assert.equal(midAcc('1010').debitBalance.amount, '60000');
    assert.equal(midAcc('6090').debitBalance.amount, '40000');
    assert.equal(midAcc('3010').creditBalance.amount, '200000');

    // Delete exp1 (posts reversal journal entry on original expenseDate in mMid) -> verify mMid updates cleanly and mCur carries the updated opening
    assert.equal((await req(`/api/expenses/${exp1.payload.id}`, { method: 'DELETE', cookieStr })).response.status, 200);
    const midTbRecheck = await req(`/api/reports/trial-balance?storeId=${storeId}&from=${mMid.from}&to=${mMid.to}`, { cookieStr });
    assert.equal(midTbRecheck.payload.accounts.find((a) => a.accountCode === '1010').debitBalance.amount, '70000');
    assert.equal(midTbRecheck.payload.accounts.find((a) => a.accountCode === '6090').debitBalance.amount, '30000');

    // Create product, purchase stock (cost 5000, retail 12000), start shift, and execute split checkout!
    assert.equal((await req('/api/products', {
      method: 'POST',
      cookieStr,
      body: { name: 'حقيبة مجزأ', sku: 'SPL-BAG', hasVariants: true, options: [{ key: 'color', name: 'اللون', values: ['أبيض'] }], variants: [{ sku: 'SPL-BAG-W', attributes: { color: 'أبيض' }, retailPrice: '12000', reorderPoint: '1' }] },
    })).response.status, 201);
    const variantId = (await req(`/api/data?storeId=${storeId}`, { cookieStr })).payload.products[0].variants[0].id;
    const sup = (await req('/api/suppliers', { method: 'POST', cookieStr, body: { name: 'تاجر الدفع المجزأ' } })).payload.id;
    assert.equal((await req('/api/purchases', {
      method: 'POST',
      cookieStr,
      body: { storeId, supplierId: sup, idempotencyKey: randomUUID(), totalAmount: '15000', paidAmount: '15000', paymentMethod: 'BANK_TRANSFER', items: [{ variantId, quantity: '3', unitCost: '5000' }] },
    })).response.status, 201);

    const shiftRes = await req('/api/shifts/start', { method: 'POST', cookieStr, body: { storeId, openingCash: '10000' } });
    assert.equal(shiftRes.response.status, 201);
    const shiftId = shiftRes.payload.shift.id;

    // Invalid split cases must return 400
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'cash', amountMinor: '0' }, { method: 'card', amountMinor: '12000' }] },
    })).response.status, 400);
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'cash', amountMinor: '7000' }, { method: 'card', amountMinor: '4999' }] },
    })).response.status, 400);

    // Reject duplicate payment methods inside payments and mixed payment-mode payloads (400)
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'cash', amountMinor: '6000' }, { method: 'CASH', amountMinor: '6000' }] },
    })).response.status, 400);
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'wallet', amountMinor: '6000' }, { method: 'MOBILE', amountMinor: '6000' }] },
    })).response.status, 400);
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'cash', amountMinor: '7000' }, { method: 'card', amountMinor: '5000' }], payment: { method: 'CASH', amount: '12000' } },
    })).response.status, 400);
    assert.equal((await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: { storeId, idempotencyKey: randomUUID(), items: [{ variantId, quantity: '1' }], payments: [{ method: 'cash', amountMinor: '7000' }, { method: 'card', amountMinor: '5000' }], paymentMethod: 'cash', amountPaidMinor: '12000' },
    })).response.status, 400);

    // Check idempotency status endpoint before commit (found: false)
    const splitIdemKey = randomUUID();
    const statusBefore = await req(`/api/checkout/status/${splitIdemKey}?storeId=${storeId}`, { cookieStr });
    assert.equal(statusBefore.response.status, 200);
    assert.deepEqual(statusBefore.payload, { found: false });

    // Valid split checkout: 7000 cash + 5000 card = 12000
    const splitSaleRes = await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: {
        storeId,
        idempotencyKey: splitIdemKey,
        items: [{ variantId, quantity: '1' }],
        payments: [{ method: 'cash', amountMinor: '7000' }, { method: 'card', amountMinor: '5000' }],
      },
    });
    assert.equal(splitSaleRes.response.status, 201, JSON.stringify(splitSaleRes.payload));
    assert.equal(splitSaleRes.payload.total.amount, '12000');
    assert.equal(splitSaleRes.payload.changeGiven.amount, '0');
    assert.equal(splitSaleRes.payload.payments.length, 2);

    // Check idempotency status endpoint after commit (found: true + committed sale)
    const statusAfter = await req(`/api/checkout/status/${splitIdemKey}?storeId=${storeId}`, { cookieStr });
    assert.equal(statusAfter.response.status, 200);
    assert.equal(statusAfter.payload.found, true);
    assert.equal(statusAfter.payload.sale.id, splitSaleRes.payload.id);
    assert.equal(statusAfter.payload.sale.saleNumber, splitSaleRes.payload.saleNumber);
    assert.equal(statusAfter.payload.sale.payments.length, 2);

    // Cashiers cannot query another user's idempotency status (returns found: false)
    const otherCashierCreate = await req('/api/users', {
      method: 'POST',
      cookieStr,
      body: { username: 'split_cashier2', password: 'Cashier-Password-2026', fullName: 'كاشير ثاني', role: 'CASHIER', storeId },
    });
    assert.equal(otherCashierCreate.response.status, 201);
    const otherCashierLogin = await fetch(`${sUrl}/api/login`, {
      method: 'POST',
      headers: { Origin: sUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'split_cashier2', password: 'Cashier-Password-2026' }),
    });
    assert.equal(otherCashierLogin.status, 200);
    const otherCashierCookie = otherCashierLogin.headers.get('set-cookie').split(';')[0];
    const cashierForeignLookup = await req(`/api/checkout/status/${splitIdemKey}?storeId=${storeId}`, { cookieStr: otherCashierCookie });
    assert.equal(cashierForeignLookup.response.status, 200);
    assert.deepEqual(cashierForeignLookup.payload, { found: false });

    // Check receipt carries split payments breakdown
    const receiptRes = await req(`/api/sales/${splitSaleRes.payload.id}/receipt?width=80mm`, { cookieStr });
    assert.equal(receiptRes.response.status, 200);
    assert.deepEqual(
      receiptRes.payload.receipt.payments.map((p) => ({ method: p.method, amount: p.amount.amount })),
      [{ method: 'CASH', amount: '7000' }, { method: 'CARD', amount: '5000' }],
    );

    // Backward-compatible single paymentMethod + amountPaidMinor ('wallet' -> MOBILE)
    const walletSaleRes = await req('/api/checkout', {
      method: 'POST',
      cookieStr,
      body: {
        storeId,
        idempotencyKey: randomUUID(),
        items: [{ variantId, quantity: '1' }],
        paymentMethod: 'wallet',
        amountPaidMinor: '12000',
      },
    });
    assert.equal(walletSaleRes.response.status, 201, JSON.stringify(walletSaleRes.payload));
    assert.equal(walletSaleRes.payload.payments[0].method, 'MOBILE');

    // End shift: expectedCash = 10000 opening + 7000 cash portion from split sale = 17000
    const shiftEndRes = await req('/api/shifts/end', {
      method: 'POST',
      cookieStr,
      body: { shiftId, actualCash: '17000', handoverCash: '0' },
    });
    assert.equal(shiftEndRes.response.status, 200);
    assert.equal(shiftEndRes.payload.shift.expectedCash, '17000');
    assert.equal(shiftEndRes.payload.shift.variance, '0');

    // Inspect GL Journal lines for split sale: 1010 +7000, 1020 +5000, 4010 -12000, 5010 +5000, 1300 -5000
    const jeList = await req(`/api/journal-entries?storeId=${storeId}&sourceType=SALE&limit=20`, { cookieStr });
    assert.equal(jeList.response.status, 200);
    const splitEntry = (jeList.payload?.payload?.entries ?? []).find(
      (e) => e.description?.includes(splitSaleRes.payload.saleNumber) || e.lines?.some((l) => l.memo?.includes(splitSaleRes.payload.saleNumber)),
    );
    assert.ok(splitEntry, 'Journal entry for split sale must exist');
    const lineAmt = (code, side) => splitEntry.lines
      .filter((l) => l.accountCode === code && l.side === side)
      .reduce((s, l) => s + BigInt(l.amount.amount), 0n);
    assert.equal(lineAmt('1010', 'DEBIT'), 7000n);
    assert.equal(lineAmt('1020', 'DEBIT'), 5000n);
    assert.equal(lineAmt('4010', 'CREDIT'), 12000n);
    assert.equal(lineAmt('5010', 'DEBIT'), 5000n);
    assert.equal(lineAmt('1300', 'CREDIT'), 5000n);

    // Check Trial Balance for mCur: carries mOpen+mMid opening (after exp1 reversal on mMid expenseDate) + split/wallet sales + bank purchase
    const curTb = await req(`/api/reports/trial-balance?storeId=${storeId}&from=${mCur.from}&to=${mCur.to}`, { cookieStr });
    assert.equal(curTb.response.status, 200);
    assert.equal(curTb.payload.totals.isBalanced, true);
    const curAcc = (c) => curTb.payload.accounts.find((a) => a.accountCode === c);
    // 1010: opening=70000, period debit=7000 (split cash) -> closing=77000
    assert.equal(curAcc('1010').openingDebitBalance.amount, '70000');
    assert.equal(curAcc('1010').periodDebit.amount, '7000');
    assert.equal(curAcc('1010').debitBalance.amount, '77000');
    // 1020: opening=0, period=+5000 (card) + 12000 (wallet) - 15000 (bank purchase) = +2000
    assert.equal(curAcc('1020').debitBalance.amount, '2000');
    // 6090: opening=30000, period credit=0 (reversal occurred on mMid expenseDate) -> closing=30000
    assert.equal(curAcc('6090').openingDebitBalance.amount, '30000');
    assert.equal(curAcc('6090').periodCredit.amount, '0');
    assert.equal(curAcc('6090').debitBalance.amount, '30000');
    // 4010: 12000 + 12000 = 24000 credit
    assert.equal(curAcc('4010').creditBalance.amount, '24000');
    // 1300: 15000 - 10000 = 5000 debit, 5010: 10000 debit
    assert.equal(curAcc('1300').debitBalance.amount, '5000');
    assert.equal(curAcc('5010').debitBalance.amount, '10000');
  } finally {
    await stopServer(srv);
    await rm(sDir, { recursive: true, force: true }).catch(() => {});
  }
});


test('RBAC guards: stock transfer destination store authorization and auditor shift rejection', async () => {
  const tDir = await mkdtemp(join(appDir, '.test-rbac-'));
  const tPort = await reservePort();
  const tUrl = `http://127.0.0.1:${tPort}`;
  let tLog = '';

  const startServer = async () => {
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({ PORT: String(tPort), RETAILOS_DATA_DIR: tDir, RETAILOS_COMPANY_NAME: 'شركة RBAC', RETAILOS_COMPANY_CODE: 'RBAC_TEST', RETAILOS_CURRENCY: 'EGP', RETAILOS_STORE_NAME: 'الفرع الرئيسي' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { tLog += c.toString(); });
    proc.stderr.on('data', (c) => { tLog += c.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}\n${tLog}`);
      try { if ((await fetch(`${tUrl}/api/bootstrap`)).ok) { await activateTestLicense(tUrl); return proc; } } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`Timeout\n${tLog}`);
  };

  const stopServer = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
    }
  };

  const req = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: tUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${tUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    return { response, payload };
  };

  let srv = null;
  try {
    srv = await startServer();

    // Setup owner
    assert.equal((await req('/api/setup', { method: 'POST', body: { ownerName: 'مالك RBAC', ownerUsername: 'rbac_owner', password: 'RBAC-Owner-Password-2026' } })).response.status, 201, tLog);
    const ownerLogin = await req('/api/login', { method: 'POST', body: { username: 'rbac_owner', password: 'RBAC-Owner-Password-2026' } });
    assert.equal(ownerLogin.response.status, 200);
    const ownerCookie = ownerLogin.response.headers.get('set-cookie').split(';')[0];

    const data0 = await req('/api/data', { cookieStr: ownerCookie });
    const storeId = data0.payload.stores[0].id;

    // Create a product + stock via supplier purchase so we can attempt a transfer
    const prod = await req('/api/products', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        name: 'منتج RBAC',
        sku: 'RBAC-PROD',
        hasVariants: true,
        options: [{ key: 'color', name: 'اللون', values: ['أسود'] }],
        variants: [{ sku: 'RBAC-PROD-1', attributes: { color: 'أسود' }, retailPrice: '10000', reorderPoint: '0' }],
      },
    });
    assert.equal(prod.response.status, 201, JSON.stringify(prod.payload));
    const variantId = (await req(`/api/data?storeId=${storeId}`, { cookieStr: ownerCookie })).payload.products[0].variants[0].id;

    const supRes = await req('/api/suppliers', { method: 'POST', cookieStr: ownerCookie, body: { name: 'تاجر RBAC' } });
    assert.equal(supRes.response.status, 201);
    const receive = await req('/api/purchases', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: {
        storeId,
        supplierId: supRes.payload.id,
        idempotencyKey: randomUUID(),
        totalAmount: '50000',
        paidAmount: '50000',
        paymentMethod: 'CASH',
        items: [{ variantId, quantity: '10', unitCost: '5000' }],
      },
    });
    assert.equal(receive.response.status, 201, JSON.stringify(receive.payload));

    // Create a second store
    const store2 = await req('/api/stores', { method: 'POST', cookieStr: ownerCookie, body: { code: 'RBAC2', name: 'فرع RBAC الثاني', address: 'عنوان', phone: '01000000000' } });
    assert.equal(store2.response.status, 201);
    const store2Id = store2.payload.id;

    // ---- Test (a): Stock transfer destination store authorization ----

    // Create a STORE_MANAGER scoped to store 1
    const mgrCreate = await req('/api/users', { method: 'POST', cookieStr: ownerCookie, body: { username: 'rbac_mgr', password: 'RBAC-Mgr-Password-2026', fullName: 'مدير فرع RBAC', role: 'STORE_MANAGER', storeId } });
    assert.equal(mgrCreate.response.status, 201);
    const mgrLogin = await req('/api/login', { method: 'POST', body: { username: 'rbac_mgr', password: 'RBAC-Mgr-Password-2026' } });
    assert.equal(mgrLogin.response.status, 200);
    const mgrCookie = mgrLogin.response.headers.get('set-cookie').split(';')[0];

    // Manager scoped to store1 tries to transfer TO store2 -> should get 403 (destination store access denied)
    const blockedTransfer = await req('/api/inventory/transfer', {
      method: 'POST',
      cookieStr: mgrCookie,
      body: { fromStoreId: storeId, toStoreId: store2Id, variantId, quantity: '1' },
    });
    assert.equal(blockedTransfer.response.status, 403, `Expected 403 for manager transferring to unauthorized store, got ${blockedTransfer.response.status}: ${JSON.stringify(blockedTransfer.payload)}`);

    // Owner (no store scope) can transfer fine
    const ownerTransfer = await req('/api/inventory/transfer', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { fromStoreId: storeId, toStoreId: store2Id, variantId, quantity: '1' },
    });
    assert.equal(ownerTransfer.response.status, 201, `Owner transfer should succeed: ${JSON.stringify(ownerTransfer.payload)}`);

    // ---- Test (b): AUDITOR rejected on shift start/end ----

    // Create an AUDITOR user
    const auditorCreate = await req('/api/users', { method: 'POST', cookieStr: ownerCookie, body: { username: 'rbac_auditor', password: 'RBAC-Auditor-Password-2026', fullName: 'مراجع RBAC', role: 'AUDITOR' } });
    assert.equal(auditorCreate.response.status, 201);
    const auditorLogin = await req('/api/login', { method: 'POST', body: { username: 'rbac_auditor', password: 'RBAC-Auditor-Password-2026' } });
    assert.equal(auditorLogin.response.status, 200);
    const auditorCookie = auditorLogin.response.headers.get('set-cookie').split(';')[0];

    // Auditor tries to start a shift -> 403
    const auditorShiftStart = await req('/api/shifts/start', { method: 'POST', cookieStr: auditorCookie, body: { storeId, openingCash: '0' } });
    assert.equal(auditorShiftStart.response.status, 403, `Auditor must be blocked from starting shift, got ${auditorShiftStart.response.status}`);

    // Auditor tries to end a shift -> 403
    const auditorShiftEnd = await req('/api/shifts/end', { method: 'POST', cookieStr: auditorCookie, body: { shiftId: randomUUID(), actualCash: '0', handoverCash: '0' } });
    assert.equal(auditorShiftEnd.response.status, 403, `Auditor must be blocked from ending shift, got ${auditorShiftEnd.response.status}`);

    // CASHIER and OWNER hold POS_CHECKOUT and succeed on start/end shifts
    const cashierCreate = await req('/api/users', { method: 'POST', cookieStr: ownerCookie, body: { username: 'rbac_cashier', password: 'RBAC-Cashier-Password-2026', fullName: 'كاشير RBAC', role: 'CASHIER', storeId } });
    assert.equal(cashierCreate.response.status, 201);
    const cashierLogin = await req('/api/login', { method: 'POST', body: { username: 'rbac_cashier', password: 'RBAC-Cashier-Password-2026' } });
    assert.equal(cashierLogin.response.status, 200);
    const cashierCookie = cashierLogin.response.headers.get('set-cookie').split(';')[0];

    const cashierStart = await req('/api/shifts/start', { method: 'POST', cookieStr: cashierCookie, body: { storeId, openingCash: '0' } });
    assert.equal(cashierStart.response.status, 201, `Cashier must succeed starting shift: ${JSON.stringify(cashierStart.payload)}`);
    const cashierEnd = await req('/api/shifts/end', { method: 'POST', cookieStr: cashierCookie, body: { shiftId: cashierStart.payload.shift.id, actualCash: '0', handoverCash: '0' } });
    assert.equal(cashierEnd.response.status, 200, `Cashier must succeed ending shift: ${JSON.stringify(cashierEnd.payload)}`);

    const ownerStart = await req('/api/shifts/start', { method: 'POST', cookieStr: ownerCookie, body: { storeId, openingCash: '0' } });
    assert.equal(ownerStart.response.status, 201, `Owner must succeed starting shift: ${JSON.stringify(ownerStart.payload)}`);
    const ownerEnd = await req('/api/shifts/end', { method: 'POST', cookieStr: ownerCookie, body: { shiftId: ownerStart.payload.shift.id, actualCash: '0', handoverCash: '0' } });
    assert.equal(ownerEnd.response.status, 200, `Owner must succeed ending shift: ${JSON.stringify(ownerEnd.payload)}`);

  } finally {
    await stopServer(srv);
    await rm(tDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Offline Ed25519 licensing: 402 enforcement, token validation, persistence, anti-clock tampering & expiration', async () => {
  const lDir = await mkdtemp(join(appDir, '.test-lic-data-'));
  const clockFile = join(lDir, 'mock-clock-ms.txt');
  const baseNow = Date.now();
  await writeFile(clockFile, String(baseNow), 'utf8');

  const lPort = await reservePort();
  const lUrl = `http://127.0.0.1:${lPort}`;
  let lLog = '';

  const startServer = async () => {
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: testLicenseEnv({
        PORT: String(lPort),
        RETAILOS_DATA_DIR: lDir,
        RETAILOS_TEST_CLOCK_FILE: clockFile,
        RETAILOS_COMPANY_NAME: 'شركة الترخيص',
        RETAILOS_COMPANY_CODE: 'LIC_TEST',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { lLog += c.toString(); });
    proc.stderr.on('data', (c) => { lLog += c.toString(); });
    for (let i = 0; i < 600; i += 1) {
      if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}\n${lLog}`);
      try { if ((await fetch(`${lUrl}/api/bootstrap`)).ok) return proc; } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    throw new Error(`Timeout\n${lLog}`);
  };

  const stopServer = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
    }
  };

  const req = async (path, { method = 'GET', body, cookieStr } = {}) => {
    const headers = { Origin: lUrl };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookieStr) headers.Cookie = cookieStr;
    const response = await fetch(`${lUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.arrayBuffer();
    return { response, payload };
  };

  let srv = await startServer();
  try {
    // 1. Unlicensed fresh boot -> UNLICENSED + valid machineId
    const initialStatus = await req('/api/license/status');
    assert.equal(initialStatus.response.status, 200);
    assert.equal(initialStatus.payload.status, 'UNLICENSED');
    assert.match(initialStatus.payload.machineId, /^ROS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const machineId = initialStatus.payload.machineId;

    // 2. Setup + login remain accessible when unlicensed
    const setupRes = await req('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'lic_owner', ownerName: 'مالك الترخيص', password: 'Lic-Owner-Password-2026' },
    });
    assert.equal(setupRes.response.status, 201);
    const loginRes = await req('/api/login', {
      method: 'POST',
      body: { username: 'lic_owner', password: 'Lic-Owner-Password-2026' },
    });
    assert.equal(loginRes.response.status, 200);
    const ownerCookie = loginRes.response.headers.get('set-cookie').split(';')[0];

    const dataRes = await req('/api/data', { cookieStr: ownerCookie });
    assert.equal(dataRes.response.status, 200);
    const storeId = dataRes.payload.stores[0].id;

    // 3. Operational write endpoints must return 402 LICENSE_REQUIRED while unlicensed
    const blockedWrites = [
      ['/api/shifts/start', { storeId, openingCash: '0' }],
      ['/api/checkout', { storeId, idempotencyKey: randomUUID(), paymentMethod: 'CASH', tenderedAmount: '100', items: [{ variantId: randomUUID(), quantity: '1' }] }],
      ['/api/purchases', { storeId, supplierId: randomUUID(), idempotencyKey: randomUUID(), totalAmount: '100', paidAmount: '100', paymentMethod: 'CASH', items: [] }],
      ['/api/expenses', { storeId, category: 'عامة', amount: '100', expenseDate: cairoDateIso(new Date(baseNow)), description: 'اختبار' }],
      ['/api/inventory/transfer', { fromStoreId: storeId, toStoreId: randomUUID(), variantId: randomUUID(), quantity: '1' }],
      ['/api/inventory/damage', { storeId, variantId: randomUUID(), quantity: '1', reason: 'تالف' }],
    ];
    for (const [route, payload] of blockedWrites) {
      const blocked = await req(route, { method: 'POST', cookieStr: ownerCookie, body: payload });
      assert.equal(blocked.response.status, 402, `Expected 402 on ${route}, got ${blocked.response.status}`);
      assert.equal(blocked.payload.code, 'LICENSE_REQUIRED');
      assert.equal(blocked.payload.licenseStatus, 'UNLICENSED');
    }

    // 4. Encrypted backup export remains allowed even when unlicensed
    const backupExport = await req('/api/backups/export', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { passphrase: 'Backup-Unlicensed-Safe-2026' },
    });
    assert.equal(backupExport.response.status, 200);
    assert.ok(backupExport.payload.byteLength > 0);

    // 5. Reject wrong machineId, tampered signature, and already-expired token on /api/license/activate
    const wrongMachineToken = signFlowLicenseToken({
      licenseId: 'WRONG-MACH',
      customerName: 'عميل خطأ',
      machineId: 'ROS-AAAA-BBBB-CCCC',
      issuedAt: new Date(baseNow).toISOString(),
      expiresAt: new Date(baseNow + 30 * 86400000).toISOString(),
      planName: 'Annual',
    });
    const wrongMachRes = await req('/api/license/activate', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { token: wrongMachineToken },
    });
    assert.equal(wrongMachRes.response.status, 400);

    const valid30DayToken = signFlowLicenseToken({
      licenseId: 'VALID-30D',
      customerName: 'عميل سليم',
      machineId,
      issuedAt: new Date(baseNow).toISOString(),
      expiresAt: new Date(baseNow + 30 * 86400000).toISOString(),
      planName: '30-Day Pro',
    });
    const parts = valid30DayToken.split('.');
    const tamperedToken = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}XXXX`;
    const tamperedRes = await req('/api/license/activate', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { token: tamperedToken },
    });
    assert.equal(tamperedRes.response.status, 400);

    const expiredToken = signFlowLicenseToken({
      licenseId: 'EXP-PAST',
      customerName: 'عميل منتهي',
      machineId,
      issuedAt: new Date(baseNow - 40 * 86400000).toISOString(),
      expiresAt: new Date(baseNow - 1000).toISOString(),
      planName: 'Expired',
    });
    const expiredRes = await req('/api/license/activate', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { token: expiredToken },
    });
    assert.equal(expiredRes.response.status, 400);

    // 6. Valid activation succeeds & unblocks operational writes + persists across restarts
    const activatedRes = await req('/api/license/activate', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { token: valid30DayToken },
    });
    assert.equal(activatedRes.response.status, 200, JSON.stringify(activatedRes.payload));
    assert.equal(activatedRes.payload.status, 'ACTIVE');
    assert.equal(activatedRes.payload.daysRemaining, 30);

    await stopServer(srv);
    srv = await startServer();
    const persistedStatus = await req('/api/license/status');
    assert.equal(persistedStatus.response.status, 200);
    assert.equal(persistedStatus.payload.status, 'ACTIVE');

    const startShiftOk = await req('/api/shifts/start', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, openingCash: '0' },
    });
    assert.equal(startShiftOk.response.status, 201, JSON.stringify(startShiftOk.payload));

    // 7. Monotonic clock anti-tampering: advance clock +5 days (advances watermark), then roll back -6 days -> CLOCK_TAMPERED & 402
    const forward5d = baseNow + 5 * 86400000;
    await writeFile(clockFile, String(forward5d), 'utf8');
    const forwardStatus = await req('/api/license/status');
    assert.equal(forwardStatus.payload.status, 'ACTIVE');

    await writeFile(clockFile, String(baseNow - 86400000), 'utf8');
    const tamperedStatus = await req('/api/license/status');
    assert.equal(tamperedStatus.payload.status, 'CLOCK_TAMPERED');
    const blockedAfterTamper = await req('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, category: 'عامة', amount: '100', expenseDate: cairoDateIso(new Date(baseNow)), description: 'اختبار' },
    });
    assert.equal(blockedAfterTamper.response.status, 402);
    assert.equal(blockedAfterTamper.payload.licenseStatus, 'CLOCK_TAMPERED');

    // Restore clock >= watermark -> returns ACTIVE
    await writeFile(clockFile, String(forward5d + 1000), 'utf8');
    const restoredStatus = await req('/api/license/status');
    assert.equal(restoredStatus.payload.status, 'ACTIVE');

    // 8. Advance past expiry (+31 days) -> EXPIRED & 402
    await writeFile(clockFile, String(baseNow + 31 * 86400000), 'utf8');
    const expiredRuntimeStatus = await req('/api/license/status');
    assert.equal(expiredRuntimeStatus.payload.status, 'EXPIRED');
    const blockedExpired = await req('/api/expenses', {
      method: 'POST',
      cookieStr: ownerCookie,
      body: { storeId, category: 'عامة', amount: '100', expenseDate: cairoDateIso(new Date(baseNow)), description: 'اختبار' },
    });
    assert.equal(blockedExpired.response.status, 402);
    assert.equal(blockedExpired.payload.licenseStatus, 'EXPIRED');
  } finally {
    await stopServer(srv);
    await rm(lDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Production server.mjs ignores env-var license overrides and enforces DB watermark & ledger hardening', async () => {
  const dirA = await mkdtemp(join(appDir, '.test-direct-srv-'));
  const dirB = await mkdtemp(join(appDir, '.test-ledger-harden-'));
  const stopProc = async (proc) => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
    }
  };

  // --- Part A: Direct server.mjs launch MUST ignore RETAILOS_TEST_LICENSE_PUBLIC_KEY ---
  let prodProc = null;
  try {
    const portA = await reservePort();
    const urlA = `http://127.0.0.1:${portA}`;
    let logA = '';
    prodProc = spawn(process.execPath, [join(appDir, 'server.mjs')], {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(portA),
        RETAILOS_DATA_DIR: dirA,
        RETAILOS_TEST_LICENSE_PUBLIC_KEY: flowLicensePublicKeyPem,
        RETAILOS_COMPANY_NAME: 'اختبار الإنتاج',
        RETAILOS_COMPANY_CODE: 'PROD_KEY_TEST',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prodProc.stdout.on('data', (c) => { logA += c.toString(); });
    prodProc.stderr.on('data', (c) => { logA += c.toString(); });

    let readyA = false;
    for (let i = 0; i < 400; i += 1) {
      if (prodProc.exitCode !== null) throw new Error(`Direct server exited ${prodProc.exitCode}\n${logA}`);
      try { if ((await fetch(`${urlA}/api/bootstrap`)).ok) { readyA = true; break; } } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(readyA, `Direct server timeout\n${logA}`);

    const stRes = await fetch(`${urlA}/api/license/status`);
    assert.equal(stRes.status, 200);
    const stBody = await stRes.json();
    assert.equal(stBody.status, 'UNLICENSED');

    const now = Date.now();
    const forgedByEnvTestKey = signFlowLicenseToken({
      licenseId: 'ENV-BYPASS-TRY',
      customerName: 'مهاجم',
      machineId: stBody.machineId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 365 * 86400000).toISOString(),
      planName: 'Bypass',
    });
    const actAttempt = await fetch(`${urlA}/api/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: urlA },
      body: JSON.stringify({ token: forgedByEnvTestKey }),
    });
    assert.equal(
      actAttempt.status,
      400,
      `Direct server.mjs MUST reject tokens signed by RETAILOS_TEST_LICENSE_PUBLIC_KEY, got ${actAttempt.status}`,
    );
    const filesInDirA = await readdir(dirA);
    assert.ok(filesInDirA.includes('.retailos-watermark.key'), 'Headless per-install watermark secret file must be created');
  } finally {
    await stopProc(prodProc);
    await rm(dirA, { recursive: true, force: true }).catch(() => {});
  }

  // --- Part B: Deleting system_licensing row after audit/sales activity triggers CLOCK_TAMPERED ---
  let harnessProc = null;
  try {
    const portB = await reservePort();
    const urlB = `http://127.0.0.1:${portB}`;
    const clockFileB = join(dirB, 'mock-clock.txt');
    const baseMs = Date.now();
    await writeFile(clockFileB, String(baseMs), 'utf8');
    let logB = '';

    const bootHarness = async () => {
      const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
        cwd: workspace,
        env: testLicenseEnv({
          PORT: String(portB),
          RETAILOS_DATA_DIR: dirB,
          RETAILOS_TEST_CLOCK_FILE: clockFileB,
          RETAILOS_COMPANY_NAME: 'شركة سجل التوقيت',
          RETAILOS_COMPANY_CODE: 'WM_DEL_TEST',
          RETAILOS_CURRENCY: 'EGP',
          RETAILOS_STORE_NAME: 'الفرع الرئيسي',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (c) => { logB += c.toString(); });
      proc.stderr.on('data', (c) => { logB += c.toString(); });
      for (let i = 0; i < 400; i += 1) {
        if (proc.exitCode !== null) throw new Error(`Harness exited ${proc.exitCode}\n${logB}`);
        try { if ((await fetch(`${urlB}/api/bootstrap`)).ok) return proc; } catch { /* wait */ }
        await new Promise((r) => setTimeout(r, 125));
      }
      throw new Error(`Harness timeout\n${logB}`);
    };

    const reqB = async (path, { method = 'GET', body, cookieStr } = {}) => {
      const headers = { Origin: urlB };
      if (body) headers['Content-Type'] = 'application/json';
      if (cookieStr) headers.Cookie = cookieStr;
      const response = await fetch(`${urlB}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json();
      return { response, payload };
    };

    harnessProc = await bootHarness();
    await activateTestLicense(urlB);

    const setupB = await reqB('/api/setup', {
      method: 'POST',
      body: { ownerUsername: 'wm_owner', ownerName: 'مالك السجل', password: 'Watermark-Owner-Password-2026' },
    });
    assert.equal(setupB.response.status, 201);
    const loginB = await reqB('/api/login', {
      method: 'POST',
      body: { username: 'wm_owner', password: 'Watermark-Owner-Password-2026' },
    });
    assert.equal(loginB.response.status, 200);
    const cookieB = loginB.response.headers.get('set-cookie').split(';')[0];
    const dataB = await reqB('/api/data', { cookieStr: cookieB });
    const storeIdB = dataB.payload.stores[0].id;

    // Delete system_licensing row directly in SQLite while audit_logs already exist
    await stopProc(harnessProc);
    harnessProc = null;

    const mgr = new SqliteDatabaseManager({ filename: join(dirB, 'retailos.sqlite') });
    mgr.connect();
    try {
      await mgr.getDb().deleteFrom('system_licensing').execute();
    } finally {
      await mgr.close();
    }

    // Restart server: MUST detect missing watermark row on DB with business/audit history -> CLOCK_TAMPERED
    harnessProc = await bootHarness();
    const tamperedAfterDelete = await reqB('/api/license/status');
    assert.equal(tamperedAfterDelete.response.status, 200);
    assert.equal(tamperedAfterDelete.payload.status, 'CLOCK_TAMPERED');

    const blockedWrite = await reqB('/api/expenses', {
      method: 'POST',
      cookieStr: cookieB,
      body: { storeId: storeIdB, category: 'عامة', amount: '100', expenseDate: cairoDateIso(new Date(baseMs)), description: 'اختبار' },
    });
    assert.equal(blockedWrite.response.status, 402);
    assert.equal(blockedWrite.payload.licenseStatus, 'CLOCK_TAMPERED');
  } finally {
    await stopProc(harnessProc);
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});
