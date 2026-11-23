import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTempDir,
  createTestTempDir,
  DEFAULT_HARNESS_READY_TIMEOUT_MS,
  terminateChildProcessTree,
  waitForHarnessReady,
} from './e2e-server-harness.mjs';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(dirname(appDir));

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const watermarkSecret = randomBytes(32).toString('hex');

function signLicenseToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

let dataDir;
let serverProcess;
let serverLog = '';
let baseUrl;
let cookie = '';

async function req(path, options = {}) {
  const headers = {
    Origin: baseUrl,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

before(async () => {
  dataDir = await createTestTempDir('retailos-inline-purchase-');
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      RETAILOS_DATA_DIR: dataDir,
      RETAILOS_COMPANY_NAME: 'متجر الشراء المدمج',
      RETAILOS_COMPANY_CODE: 'INLINE_TEST',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      RETAILOS_TEST_LICENSE_PUBLIC_KEY: publicKeyPem,
      RETAILOS_TEST_WATERMARK_SECRET: watermarkSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  await waitForHarnessReady(baseUrl, serverProcess, () => serverLog, DEFAULT_HARNESS_READY_TIMEOUT_MS);

  // Activate test license
  const licStatus = await req('/api/license/status');
  assert.equal(licStatus.status, 200);
  const now = Date.now();
  const token = signLicenseToken({
    licenseId: `TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerName: 'متجر الاختبار الذري',
    machineId: licStatus.body.machineId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    planName: 'Test Annual Plan',
  });
  const actRes = await req('/api/license/activate', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  assert.equal(actRes.status, 200);

  // Setup owner & login
  const setupRes = await req('/api/setup', {
    method: 'POST',
    body: JSON.stringify({
      ownerUsername: 'owner_inline',
      ownerName: 'أحمد المدير',
      password: 'A-Long-Test-Password-2026',
    }),
  });
  assert.equal(setupRes.status, 201, `Setup failed: ${JSON.stringify(setupRes.body)}`);

  const loginRes = await req('/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'owner_inline',
      password: 'A-Long-Test-Password-2026',
    }),
  });
  assert.equal(loginRes.status, 200, `Login failed: ${JSON.stringify(loginRes.body)}`);
});

after(async () => {
  if (serverProcess) {
    await terminateChildProcessTree(serverProcess);
    serverProcess = null;
  }
  if (dataDir) await cleanupTempDir(dataDir);
});

test('inline new-product purchase succeeds atomically, prevents duplicate on retry, rolls back on failure, and supports reordering', async () => {
  const initialData = await req('/api/data');
  assert.equal(initialData.status, 200);
  const storeId = initialData.body.selectedStoreId;

  // 1. Add category from suppliers workflow
  const catRes = await req('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'أحذية كاجوال' }),
  });
  assert.equal(catRes.status, 201);
  const categoryId = catRes.body.id;

  // 2. Add supplier
  const supRes = await req('/api/suppliers', {
    method: 'POST',
    body: JSON.stringify({ name: 'تاجر المصنع الحديث', phone: '01012345678' }),
  });
  assert.equal(supRes.status, 201);
  const supplierId = supRes.body.id;

  // 3. Purchase with inline new product (flexible options: اللون × المقاس)
  // Quantities: 2 + 3 + 0 + 1 = 6 pieces @ 200.00 EGP (20000 piasters) = 1200.00 EGP (120000 piasters)
  // Optional retail price: 320.00 EGP (32000 piasters)
  // Paid: 500.00 EGP (50000 piasters) CASH -> remaining 700.00 EGP (70000 piasters)
  const idempotencyKey = randomUUID();
  const inlinePurchasePayload = {
    idempotencyKey,
    supplierId,
    storeId,
    invoiceNumber: 'INV-INLINE-001',
    paymentMethod: 'CASH',
    totalAmount: '120000',
    paidAmount: '50000',
    items: [],
    newProducts: [
      {
        name: 'سنيكرز مودرن',
        sku: 'SNK-500',
        categoryId,
        options: [
          { key: 'option_1', name: 'اللون', values: ['أسود', 'أبيض'] },
          { key: 'option_2', name: 'المقاس', values: ['42', '43'] },
        ],
        variants: [
          { sku: 'SNK-500-BLK-42', attributes: { option_1: 'أسود', option_2: '42' }, quantity: '2', unitCost: '20000', retailPrice: '32000', reorderPoint: '3' },
          { sku: 'SNK-500-BLK-43', attributes: { option_1: 'أسود', option_2: '43' }, quantity: '3', unitCost: '20000', retailPrice: '32000', reorderPoint: '3' },
          { sku: 'SNK-500-WHT-42', attributes: { option_1: 'أبيض', option_2: '42' }, quantity: '0', unitCost: '20000', retailPrice: '32000', reorderPoint: '3' },
          { sku: 'SNK-500-WHT-43', attributes: { option_1: 'أبيض', option_2: '43' }, quantity: '1', unitCost: '20000', retailPrice: '32000', reorderPoint: '3' },
        ],
      },
    ],
  };

  const purRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify(inlinePurchasePayload),
  });
  assert.equal(purRes.status, 201, `Expected 201, got ${purRes.status}: ${JSON.stringify(purRes.body)}`);
  const purchaseId = purRes.body.id;

  // Verify product, variants, stock, supplier ledger, and accounting
  const afterCreate = await req('/api/data');
  assert.equal(afterCreate.status, 200);
  const createdProduct = afterCreate.body.products.find((p) => p.sku === 'SNK-500');
  assert.ok(createdProduct, 'Inline product must exist in /api/data');
  assert.equal(createdProduct.categoryId, categoryId);
  assert.equal(createdProduct.variants.length, 4);

  const totalStockAfterCreate = createdProduct.variants.reduce((sum, v) => sum + BigInt(v.quantity), 0n);
  assert.equal(totalStockAfterCreate, 6n);

  const supplierSummary = afterCreate.body.suppliers.find((s) => s.id === supplierId);
  assert.equal(supplierSummary.totalPurchased, '120000');
  assert.equal(supplierSummary.totalPaid, '50000');
  assert.equal(supplierSummary.balanceDue, '70000');

  // Verify Trial Balance is balanced and reconciles 1300 (Inventory), 1010 (Cash), and 2010 (AP)
  const tbRes = await req('/api/reports/trial-balance');
  assert.equal(tbRes.status, 200);
  assert.equal(tbRes.body.totals.isBalanced, true);
  assert.equal(tbRes.body.totals.debitTotal.amount, '120000');
  assert.equal(tbRes.body.totals.creditTotal.amount, '120000');

  // 4. Retry exact same request with SAME idempotencyKey -> must return same purchaseId with ZERO duplicates
  const retryRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify(inlinePurchasePayload),
  });
  assert.equal(retryRes.status, 201);
  assert.equal(retryRes.body.id, purchaseId);

  const afterRetry = await req('/api/data');
  assert.equal(afterRetry.body.products.filter((p) => p.sku === 'SNK-500').length, 1);
  const stockAfterRetry = afterRetry.body.products
    .find((p) => p.sku === 'SNK-500')
    .variants.reduce((sum, v) => sum + BigInt(v.quantity), 0n);
  assert.equal(stockAfterRetry, 6n, 'Idempotent retry must not double stock');
  const supplierAfterRetry = afterRetry.body.suppliers.find((s) => s.id === supplierId);
  assert.equal(supplierAfterRetry.totalPurchased, '120000');
  assert.equal(supplierAfterRetry.balanceDue, '70000');

  // 5. Same idempotencyKey with modified payload -> 409 Conflict
  const conflictRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      ...inlinePurchasePayload,
      totalAmount: '140000',
      newProducts: [
        {
          ...inlinePurchasePayload.newProducts[0],
          variants: [
            { ...inlinePurchasePayload.newProducts[0].variants[0], quantity: '3' },
            ...inlinePurchasePayload.newProducts[0].variants.slice(1),
          ],
        },
      ],
    }),
  });
  assert.equal(conflictRes.status, 409);

  // 6. Failure mid-transaction -> full rollback (no partial product, variant, stock, or journal)
  const failingRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      supplierId,
      storeId,
      paymentMethod: 'CASH',
      totalAmount: '50000',
      paidAmount: '50000',
      items: [
        { variantId: randomUUID(), quantity: '1', unitCost: '20000' },
      ],
      newProducts: [
        {
          name: 'منتج يجب التراجع عنه',
          sku: 'ROLLBACK-999',
          categoryId,
          options: [],
          variants: [
            { sku: 'ROLLBACK-999', attributes: {}, quantity: '1', unitCost: '30000' },
          ],
        },
      ],
    }),
  });
  assert.equal(failingRes.status, 400);

  const afterFailure = await req('/api/data');
  assert.equal(
    afterFailure.body.products.some((p) => p.sku === 'ROLLBACK-999'),
    false,
    'Failed purchase must roll back inline product creation completely',
  );
  assert.equal(afterFailure.body.suppliers.find((s) => s.id === supplierId).totalPurchased, '120000');

  // 7. Reorder the existing newly created product using `items`
  const black42 = createdProduct.variants.find((v) => v.sku === 'SNK-500-BLK-42');
  assert.ok(black42);
  const reorderRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      supplierId,
      storeId,
      paymentMethod: 'CASH',
      totalAmount: '44000',
      paidAmount: '44000',
      items: [
        { variantId: black42.id, quantity: '2', unitCost: '22000' },
      ],
    }),
  });
  assert.equal(reorderRes.status, 201);

  const afterReorder = await req('/api/data');
  const refreshedBlack42 = afterReorder.body.products
    .find((p) => p.sku === 'SNK-500')
    .variants.find((v) => v.id === black42.id);
  assert.equal(BigInt(refreshedBlack42.quantity), 4n);
});

test('UI removes standalone #new-product button, keeps #new-category, and avoids calling variants فروع', async () => {
  const appJs = await readFile(join(appDir, 'public', 'app.js'), 'utf8');
  assert.equal(appJs.includes('id="new-product"'), false, 'Standalone #new-product button must be removed');
  assert.equal(appJs.includes('id="new-category"'), true, 'Suppliers page must keep #new-category button');
  assert.equal(appJs.includes('id="add-purchase-new-product"'), true, 'Purchase modal must allow adding new products inline');
  assert.equal(appJs.includes('كود الفرع (SKU)'), false, 'Product variants must not be labeled كود الفرع (SKU)');
  assert.equal(appJs.includes('اللون والمقاس الفرعي'), false, 'Product variants must not be labeled اللون والمقاس الفرعي');
  assert.equal(appJs.includes('مقاسات وفروع'), false, 'Product variants must not be labeled فروع');
  assert.equal(appJs.includes('فرع (لون/مقاس)'), false, 'Product variants must not be labeled فرع (لون/مقاس)');

  // Validation error for empty variants array must return clear Arabic, never raw Zod English
  const badRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      supplierId: randomUUID(),
      storeId: randomUUID(),
      totalAmount: '1000',
      paidAmount: '0',
      items: [],
      newProducts: [{ name: 'منتج بلا تركيبات', sku: 'NO-VAR-1', options: [], variants: [] }],
    }),
  });
  assert.equal(badRes.status, 400);
  assert.equal(/Too small|expected array/i.test(badRes.body?.error ?? ''), false, `Got raw English Zod error: ${badRes.body?.error}`);
  assert.match(badRes.body?.error ?? '', /[\u0600-\u06FF]/, 'Validation error must be clear Arabic');
});

test('editing supplier payments, expenses, suppliers, categories & purchase metadata reconciles Trial Balance, P&L, 1010/1020/2010/6090 & supplier ledger to the exact piaster', async () => {
  const data0 = await req('/api/data');
  assert.equal(data0.status, 200);
  const storeId = data0.body.selectedStoreId;
  const supplier = data0.body.suppliers[0];
  const category = data0.body.categories[0];
  const purchase = supplier.purchases.find((p) => p.invoiceNumber === 'INV-INLINE-001');
  assert.ok(purchase && purchase.payments.length >= 1, 'Expected initial purchase with payment');

  // 1. Edit category, supplier, and purchase metadata
  const catPatch = await req(`/api/categories/${category.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'أحذية كاجوال معدّلة' }),
  });
  assert.equal(catPatch.status, 200);

  const supPatch = await req(`/api/suppliers/${supplier.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'تاجر المصنع الحديث (معدّل)', phone: '01099998888', notes: 'تم التحديث' }),
  });
  assert.equal(supPatch.status, 200);

  const purPatch = await req(`/api/purchases/${purchase.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ invoiceNumber: 'INV-INLINE-001-EDITED', notes: 'ملاحظة معدّلة' }),
  });
  assert.equal(purPatch.status, 200);

  // 2. Edit initial payment from 50000 CASH -> 30000 BANK_TRANSFER
  const initialPayment = purchase.payments[0];
  const editPayKey = randomUUID();
  const editPayPayload = {
    idempotencyKey: editPayKey,
    amount: '30000',
    paymentMethod: 'BANK_TRANSFER',
    referenceNumber: 'BNK-77',
  };
  const payPatch1 = await req(
    `/api/purchases/${purchase.id}/payments/${encodeURIComponent(initialPayment.id)}`,
    { method: 'PATCH', body: JSON.stringify(editPayPayload) },
  );
  assert.equal(payPatch1.status, 200, JSON.stringify(payPatch1.body));

  // Idempotent retry of the exact same payment edit must not double-post
  const payPatchReplay = await req(
    `/api/purchases/${purchase.id}/payments/${encodeURIComponent(initialPayment.id)}`,
    { method: 'PATCH', body: JSON.stringify(editPayPayload) },
  );
  assert.equal(payPatchReplay.status, 200);

  // Check Supplier Ledger after edit:
  // Total purchased = 120000 (first) + 44000 (reorder) = 164000
  // Total paid = 30000 (edited first) + 44000 (reorder CASH) = 74000
  // Balance due = 90000
  const dataAfterPayEdit = await req('/api/data');
  const supAfterEdit = dataAfterPayEdit.body.suppliers.find((s) => s.id === supplier.id);
  assert.equal(supAfterEdit.name, 'تاجر المصنع الحديث (معدّل)');
  assert.equal(supAfterEdit.totalPurchased, '164000');
  assert.equal(supAfterEdit.totalPaid, '74000');
  assert.equal(supAfterEdit.balanceDue, '90000');

  // Check Trial Balance accounts: 1010 = 44000 CR, 1020 = 30000 CR, 2010 = 90000 CR, 1300 = 164000 DR
  const tbAfterPayEdit = await req('/api/reports/trial-balance');
  assert.equal(tbAfterPayEdit.status, 200);
  assert.equal(tbAfterPayEdit.body.totals.isBalanced, true);
  const accMap1 = new Map(tbAfterPayEdit.body.accounts.map((a) => [a.accountCode, a]));
  assert.equal(accMap1.get('1300').debitBalance.amount, '164000');
  assert.equal(accMap1.get('1010').creditBalance.amount, '44000');
  assert.equal(accMap1.get('1020').creditBalance.amount, '30000');
  assert.equal(accMap1.get('2010').creditBalance.amount, '90000');

  // 3. Delete that edited payment (30000 BANK_TRANSFER) -> AP becomes 120000, 1020 becomes 0
  const delPayRes = await req(
    `/api/purchases/${purchase.id}/payments/${encodeURIComponent(initialPayment.id)}`,
    { method: 'DELETE', body: JSON.stringify({ idempotencyKey: randomUUID() }) },
  );
  assert.equal(delPayRes.status, 200);

  const dataAfterPayDel = await req('/api/data');
  const supAfterDel = dataAfterPayDel.body.suppliers.find((s) => s.id === supplier.id);
  assert.equal(supAfterDel.totalPaid, '44000');
  assert.equal(supAfterDel.balanceDue, '120000');

  const tbAfterPayDel = await req('/api/reports/trial-balance');
  assert.equal(tbAfterPayDel.body.totals.isBalanced, true);
  const accMap2 = new Map(tbAfterPayDel.body.accounts.map((a) => [a.accountCode, a]));
  assert.equal(accMap2.get('1020').creditBalance.amount, '0');
  assert.equal(accMap2.get('2010').creditBalance.amount, '120000');

  // 4. Record daily expense 25000 CASH_DRAWER, then edit to 18000 BANK_TRANSFER
  const todayIso = new Date().toISOString().slice(0, 10);
  const expCreate = await req('/api/expenses', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      categoryCode: 'UTILITIES',
      amount: '25000',
      paymentMethod: 'CASH_DRAWER',
      expenseDate: todayIso,
      notes: 'فاتورة كهرباء قبل التعديل',
    }),
  });
  assert.equal(expCreate.status, 201);
  const expenseId = expCreate.body.id;

  const editExpKey = randomUUID();
  const editExpPayload = {
    idempotencyKey: editExpKey,
    categoryCode: 'RENT',
    amount: '18000',
    paymentMethod: 'BANK_TRANSFER',
    expenseDate: todayIso,
    notes: 'إيجار معدّل',
  };
  const expPatch1 = await req(`/api/expenses/${expenseId}`, {
    method: 'PATCH',
    body: JSON.stringify(editExpPayload),
  });
  assert.equal(expPatch1.status, 200, JSON.stringify(expPatch1.body));

  // Idempotent retry of expense edit must not double-post
  const expPatchReplay = await req(`/api/expenses/${expenseId}`, {
    method: 'PATCH',
    body: JSON.stringify(editExpPayload),
  });
  assert.equal(expPatchReplay.status, 200);

  // Check Trial Balance + P&L after expense edit:
  // 6090 (Expenses) = 18000 DR, 1010 = 44000 CR (25000 completely reversed!), 1020 = 18000 CR
  const tbAfterExpEdit = await req('/api/reports/trial-balance');
  assert.equal(tbAfterExpEdit.body.totals.isBalanced, true);
  const accMap3 = new Map(tbAfterExpEdit.body.accounts.map((a) => [a.accountCode, a]));
  assert.equal(accMap3.get('6090').debitBalance.amount, '18000');
  assert.equal(accMap3.get('1010').creditBalance.amount, '44000');
  assert.equal(accMap3.get('1020').creditBalance.amount, '18000');

  const plRes = await req(`/api/reports/profit-loss?from=${todayIso}&to=${todayIso}`);
  assert.equal(plRes.status, 200, JSON.stringify(plRes.body));
  assert.equal(plRes.body.profitLoss.directExpenses.amount, '18000');
  assert.equal(plRes.body.supplierPayments.totalPaid.amount, '44000');
  assert.equal(plRes.body.cashPosition.totalOutflows.amount, '62000');
});
