import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
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
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, body };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

before(async () => {
  dataDir = await createTestTempDir('retailos-opening-setup-');
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      RETAILOS_DATA_DIR: dataDir,
      RETAILOS_COMPANY_NAME: 'متجر الافتتاح',
      RETAILOS_COMPANY_CODE: 'OPEN_SETUP',
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

  const licStatus = await req('/api/license/status');
  assert.equal(licStatus.status, 200);
  const now = Date.now();
  const token = signLicenseToken({
    licenseId: `TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerName: 'متجر الافتتاح',
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

  const setupRes = await req('/api/setup', {
    method: 'POST',
    body: JSON.stringify({
      ownerUsername: 'owner_open',
      ownerName: 'أحمد المالك',
      password: 'A-Long-Test-Password-2026',
    }),
  });
  assert.equal(setupRes.status, 201);

  const loginRes = await req('/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'owner_open',
      password: 'A-Long-Test-Password-2026',
    }),
  });
  assert.equal(loginRes.status, 200);
});

after(async () => {
  if (serverProcess) {
    await terminateChildProcessTree(serverProcess);
    serverProcess = null;
  }
  if (dataDir) await cleanupTempDir(dataDir);
});

test('UI removes main Opening Balances dialog, deduplicates buttons, adds one-time setup guards & edit modals', async () => {
  const appJs = await readFile(join(appDir, 'public', 'app.js'), 'utf8');
  assert.equal(appJs.includes('btn-open-opening-balances'), false);
  assert.equal(appJs.includes('showOpeningBalancesModal'), false);
  assert.equal(appJs.includes('opening-debt-for-supplier'), false);
  assert.equal(appJs.includes('purchase-for-supplier'), false);
  assert.equal(appJs.includes('empty-new-opening-debt'), false);
  assert.equal(appJs.includes('empty-new-supplier'), false);
  assert.equal(appJs.includes('new-expense-table-btn'), false);
  assert.equal(appJs.includes('empty-new-monthly-obligation'), false);
  assert.equal(appJs.includes('!state.data.hasOpeningSupplierDebts'), true);
  assert.equal(appJs.includes('!data.openingInventoryEntry'), true);
  assert.equal(appJs.includes('new-opening-debt'), true);
  assert.equal(appJs.includes('opening-inventory-import-btn'), true);
  assert.equal(appJs.includes('showEditOpeningDebtModal'), true);
  assert.equal(appJs.includes('showStoresModal'), true);
  assert.equal(appJs.includes('edit-obligation-form'), true);
  assert.equal(/\bdownload:\s*'/.test(appJs), true);
});

test('supplier opening debt batch without invoice, one-time guard, editing, paydown, and opening inventory xlsx/csv import reconcile cleanly', async () => {
  const data1 = await req('/api/data');
  assert.equal(data1.status, 200);
  const storeId = data1.body.selectedStoreId;
  assert.equal(data1.body.hasOpeningSupplierDebts, false);
  assert.equal(data1.body.openingInventoryEntry, null);

  // Batch multi-supplier opening debt submitted once for the store (no cash drawer needed)
  const debtKey = randomUUID();
  const inlineDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      entryDate: '2026-10-01',
      items: [
        {
          newSupplier: {
            name: 'شركة النور للتوريدات',
            phone: '01001122334',
            notes: 'تاجر قديم',
          },
          amount: '1500000', // 15,000.00 EGP
          notes: 'رصيد سابق من الدفتر الورقي',
        },
        {
          newSupplier: {
            name: 'شركة السلام للتوريدات',
            phone: '01112233445',
          },
          amount: '500000', // 5,000.00 EGP
          notes: 'مديونية ثانية بنفس الشاشة',
        },
      ],
    }),
  });
  assert.equal(inlineDebtRes.status, 201, `Batch opening debt failed: ${JSON.stringify(inlineDebtRes.body)}`);
  assert.ok(inlineDebtRes.body.invoiceNumber.startsWith('ODEBT-'));
  assert.equal(inlineDebtRes.body.items.length, 2);
  const supplierId = inlineDebtRes.body.supplierId;

  // Idempotent replay with identical key & items succeeds
  const replayDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      entryDate: '2026-10-01',
      items: [
        {
          newSupplier: {
            name: 'شركة النور للتوريدات',
          },
          amount: '1500000',
          notes: 'رصيد سابق من الدفتر الورقي',
        },
        {
          newSupplier: {
            name: 'شركة السلام للتوريدات',
          },
          amount: '500000',
          notes: 'مديونية ثانية بنفس الشاشة',
        },
      ],
    }),
  });
  assert.equal(replayDebtRes.status, 201);
  assert.equal(replayDebtRes.body.id, inlineDebtRes.body.id);

  // Conflict when reusing same key with different supplier name or amount
  const conflictNameDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      entryDate: '2026-10-01',
      items: [
        {
          newSupplier: {
            name: 'مورد مختلف بنفس المفتاح',
          },
          amount: '1500000',
        },
        {
          newSupplier: {
            name: 'شركة السلام للتوريدات',
          },
          amount: '500000',
        },
      ],
    }),
  });
  assert.equal(conflictNameDebtRes.status, 409);

  // One-time store guard: a new key for another opening debt batch on the same store returns 409 Conflict
  const secondDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      supplierId,
      amount: '250000',
      entryDate: '2026-10-01',
      notes: 'محاولة تكرار لنفس الفرع',
    }),
  });
  assert.equal(secondDebtRes.status, 409);

  // Item return must be rejected on invoice-less opening debt
  const badReturnRes = await req(`/api/purchases/${inlineDebtRes.body.id}/returns`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      items: [{ purchaseItemId: 'nonexistent', quantity: '1' }],
    }),
  });
  assert.equal(badReturnRes.status, 400);

  // Download opening inventory xlsx template & inspect OOXML structure
  const tplRes = await req('/api/inventory/opening-template.xlsx');
  assert.equal(tplRes.status, 200);
  assert.ok((tplRes.headers.get('content-type') ?? '').includes('spreadsheetml.sheet'));
  assert.equal(tplRes.buffer.subarray(0, 2).toString('utf8'), 'PK');
  assert.ok(tplRes.buffer.length > 2000);
  const eocdOffset = tplRes.buffer.readUInt32LE(tplRes.buffer.length - 6);
  const cdCount = tplRes.buffer.readUInt16LE(tplRes.buffer.length - 12);
  let cdCursor = eocdOffset;
  const tplXmls = {};
  for (let i = 0; i < cdCount; i += 1) {
    const method = tplRes.buffer.readUInt16LE(cdCursor + 10);
    const compSize = tplRes.buffer.readUInt32LE(cdCursor + 20);
    const nLen = tplRes.buffer.readUInt16LE(cdCursor + 28);
    const xLen = tplRes.buffer.readUInt16LE(cdCursor + 30);
    const cLen = tplRes.buffer.readUInt16LE(cdCursor + 32);
    const loc = tplRes.buffer.readUInt32LE(cdCursor + 42);
    const entryName = tplRes.buffer.subarray(cdCursor + 46, cdCursor + 46 + nLen).toString('utf8');
    cdCursor += 46 + nLen + xLen + cLen;
    const ln = tplRes.buffer.readUInt16LE(loc + 26);
    const lx = tplRes.buffer.readUInt16LE(loc + 28);
    const payload = tplRes.buffer.subarray(loc + 30 + ln + lx, loc + 30 + ln + lx + compSize);
    tplXmls[entryName] = (method === 8 ? inflateRawSync(payload) : payload).toString('utf8');
  }
  assert.equal(tplXmls['xl/worksheets/sheet1.xml'].includes('activePane="bottomLeft"'), true);
  assert.equal(tplXmls['xl/worksheets/sheet1.xml'].includes('activePane="bottomRight"'), false);
  const sstMatch = /<sst[^>]+count="(\d+)"[^>]+uniqueCount="(\d+)"/.exec(tplXmls['xl/sharedStrings.xml']);
  assert.ok(sstMatch);
  assert.ok(BigInt(sstMatch[1]) > BigInt(sstMatch[2]));

  // Preview downloaded xlsx template
  const tplBase64 = tplRes.buffer.toString('base64');
  const previewXlsx = await req('/api/inventory/opening-import/preview', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      filename: 'قالب-المخزن-الافتتاحي-رف.xlsx',
      fileBase64: tplBase64,
    }),
  });
  assert.equal(previewXlsx.status, 200, `Preview failed: ${JSON.stringify(previewXlsx.body)}`);
  assert.equal(previewXlsx.body.readyToCommit, true);
  assert.equal(previewXlsx.body.summary.productCount, 3);
  assert.equal(previewXlsx.body.summary.variantCount, 5);
  assert.equal(previewXlsx.body.summary.totalUnits, '65');
  assert.equal(previewXlsx.body.summary.totalCost.amount, '1252400');

  // Verify variant SKUs differ properly across color & size
  const shirtProductPreview = previewXlsx.body.products.find((p) => p.modelSku === 'SHIRT-CL-101');
  assert.ok(shirtProductPreview);
  assert.deepEqual(
    shirtProductPreview.variants.map((v) => v.sku),
    ['SHIRT-CL-101-WHT-M', 'SHIRT-CL-101-WHT-L', 'SHIRT-CL-101-NVY-L'],
  );

  // Commit opening inventory xlsx atomically
  const importKey = randomUUID();
  const commitXlsx = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: importKey,
      storeId,
      filename: 'قالب-المخزن-الافتتاحي-رف.xlsx',
      fileBase64: tplBase64,
      entryDate: '2026-10-01',
      notes: 'جرد الافتتاح',
    }),
  });
  assert.equal(commitXlsx.status, 201, `Commit xlsx failed: ${JSON.stringify(commitXlsx.body)}`);
  assert.equal(commitXlsx.body.summary.totalCost.amount, '1252400');

  // Idempotent replay succeeds with same journalEntryId
  const commitReplay = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: importKey,
      storeId,
      filename: 'قالب-المخزن-الافتتاحي-رف.xlsx',
      fileBase64: tplBase64,
      entryDate: '2026-10-01',
    }),
  });
  assert.equal(commitReplay.status, 201);
  assert.equal(commitReplay.body.journalEntryId, commitXlsx.body.journalEntryId);

  // Re-previewing same template now shows duplicate model/SKU/barcode conflicts
  const previewConflict = await req('/api/inventory/opening-import/preview', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      filename: 'قالب-المخزن-الافتتاحي-رف.xlsx',
      fileBase64: tplBase64,
    }),
  });
  assert.equal(previewConflict.status, 200);
  assert.equal(previewConflict.body.readyToCommit, false);
  assert.ok(previewConflict.body.conflicts.length > 0);

  // Re-committing under a new key fails with 409 conflict (one-time opening inventory guard per store)
  const commitConflict = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      filename: 'قالب-المخزن-الافتتاحي-رف.xlsx',
      fileBase64: tplBase64,
    }),
  });
  assert.equal(commitConflict.status, 409);

  // Invalid CSV rows produce exact row-level errors (400 on commit)
  const badCsv = Buffer.from('\uFEFFاسم الصنف,النوع / الفئة,كود الموديل,اللون,المقاس,الكمية,سعر التكلفة (جنيه),سعر البيع (جنيه)\nحذاء رياضي,أحذية,SHOE-1,أسود,42,0,-10,500\n', 'utf8').toString('base64');
  const badPreview = await req('/api/inventory/opening-import/preview', {
    method: 'POST',
    body: JSON.stringify({ storeId, filename: 'bad.csv', fileBase64: badCsv }),
  });
  assert.equal(badPreview.status, 200);
  assert.equal(badPreview.body.readyToCommit, false);
  assert.ok(badPreview.body.errors.some((msg) => msg.includes('صف 2:')));
  const badCommit = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: randomUUID(), storeId, filename: 'bad.csv', fileBase64: badCsv }),
  });
  assert.equal(badCommit.status, 400);

  // Valid CSV with Arabic numerals is blocked by one-time store guard on primary store, then commits cleanly on a newly created & edited store
  const validCsv = Buffer.from('\uFEFFاسم الصنف,النوع / الفئة,كود الموديل,اللون,المقاس,الكمية,سعر التكلفة (جنيه),سعر البيع (جنيه),الباركود (اختياري),حد إعادة الطلب\nجاكيت شتوي,جواكت,JKT-777,أسود,XL,١٠,٤٥٠٫٥٠,٨٥٠,6223007770019,٢\n', 'utf8').toString('base64');
  const secondStoreCsvBlocked = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      filename: 'more.csv',
      fileBase64: validCsv,
      entryDate: '2026-10-01',
    }),
  });
  assert.equal(secondStoreCsvBlocked.status, 409);

  // Create second store & edit its details via PATCH /api/stores/:id
  const createStoreRes = await req('/api/stores', {
    method: 'POST',
    body: JSON.stringify({ name: 'فرع المعادي', code: 'MAADI', address: 'شارع 9', phone: '01099988877' }),
  });
  assert.equal(createStoreRes.status, 201);
  const store2Id = createStoreRes.body.id;
  const patchStoreRes = await req(`/api/stores/${store2Id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'فرع المعادي الجديد', address: 'شارع النصر', phone: '01200011122' }),
  });
  assert.equal(patchStoreRes.status, 200);
  assert.equal(patchStoreRes.body.name, 'فرع المعادي الجديد');

  // Create and edit a monthly recurring obligation via PATCH /api/recurring-expenses/:id
  const createObRes = await req('/api/recurring-expenses', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      name: 'إيجار مخزن إضافي',
      categoryCode: 'RENT',
      dueDay: 5,
    }),
  });
  assert.equal(createObRes.status, 201);
  const patchObRes = await req(`/api/recurring-expenses/${createObRes.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'إيجار المخزن المحدث', categoryCode: 'UTILITIES', dueDay: 12 }),
  });
  assert.equal(patchObRes.status, 200);

  // Valid CSV with Arabic numerals commits cleanly on the second store
  const commitCsv = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId: store2Id,
      filename: 'more.csv',
      fileBase64: validCsv,
      entryDate: '2026-10-01',
    }),
  });
  assert.equal(commitCsv.status, 201, `CSV commit failed: ${JSON.stringify(commitCsv.body)}`);
  assert.equal(commitCsv.body.summary.totalUnits, '10');
  assert.equal(commitCsv.body.summary.totalCost.amount, '450500'); // 10 * 450.50 EGP

  // Pay down 5,000.00 EGP against the opening supplier debt via bank transfer (no cash drawer needed)
  const payDebtRes = await req(`/api/purchases/${inlineDebtRes.body.id}/payments`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      amount: '500000',
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: 'TR-OPEN-01',
    }),
  });
  assert.equal(payDebtRes.status, 201, `Debt payment failed: ${JSON.stringify(payDebtRes.body)}`);

  // Editing opening debt below alreadyPaid (500,000) is rejected with 400
  const editBelowPaidRes = await req(`/api/suppliers/opening-debt/${inlineDebtRes.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      amount: '400000',
    }),
  });
  assert.equal(editBelowPaidRes.status, 400);

  // Edit opening debt amount UP to 1,800,000 then back DOWN to 1,500,000 with updated notes
  const editUpRes = await req(`/api/suppliers/opening-debt/${inlineDebtRes.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      amount: '1800000',
      entryDate: '2026-10-01',
      notes: 'زيادة مؤقتة للمراجعة',
    }),
  });
  assert.equal(editUpRes.status, 200, `editUp failed: ${JSON.stringify(editUpRes.body)}`);
  assert.equal(editUpRes.body.oldAmount, '1500000');
  assert.equal(editUpRes.body.newAmount, '1800000');

  const editDownRes = await req(`/api/suppliers/opening-debt/${inlineDebtRes.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      amount: '1500000',
      entryDate: '2026-10-01',
      notes: 'ملاحظة محدثة للمديونية الافتتاحية',
    }),
  });
  assert.equal(editDownRes.status, 200, `editDown failed: ${JSON.stringify(editDownRes.body)}`);
  assert.equal(editDownRes.body.oldAmount, '1800000');
  assert.equal(editDownRes.body.newAmount, '1500000');

  // Verify `/api/data` setup flags, products, suppliers, edited store & monthly obligation (explicitly scoped per store)
  const dataAfter = await req(`/api/data?storeId=${storeId}`);
  assert.equal(dataAfter.status, 200);
  assert.equal(dataAfter.body.hasOpeningSupplierDebts, true);
  assert.ok(dataAfter.body.openingInventoryEntry !== null);
  assert.equal(dataAfter.body.stores.find((s) => s.id === store2Id)?.name, 'فرع المعادي الجديد');
  assert.equal(dataAfter.body.monthlyExpenses.find((o) => o.id === createObRes.body.id)?.name, 'إيجار المخزن المحدث');

  const dataStore2 = await req(`/api/data?storeId=${store2Id}`);
  assert.equal(dataStore2.status, 200);
  assert.equal(dataStore2.body.hasOpeningSupplierDebts, false);
  assert.ok(dataStore2.body.openingInventoryEntry !== null);

  const supAfter = dataAfter.body.suppliers.find((s) => s.id === supplierId);
  assert.ok(supAfter);
  assert.equal(supAfter.totalPurchased, '1500000');
  assert.equal(supAfter.totalPaid, '500000');
  assert.equal(supAfter.balanceDue, '1000000');
  assert.equal(supAfter.purchases.every((p) => p.isOpeningDebt === true), true);
  const patchedEntry = supAfter.purchases.find((p) => p.id === inlineDebtRes.body.id);
  assert.equal(patchedEntry.notes, 'ملاحظة محدثة للمديونية الافتتاحية');
  assert.equal(patchedEntry.targetProfitPercent, null);

  // Verify primary store physical inventory valuation == SUM(qty * wac) on primary store only
  let inventoryValuationMinor = 0n;
  for (const prod of dataAfter.body.products) {
    for (const variant of prod.variants) {
      const qty = BigInt(variant.quantity ?? 0);
      const wac = BigInt(variant.wac?.amount ?? 0);
      inventoryValuationMinor += qty * wac;
    }
  }
  assert.equal(inventoryValuationMinor, 1252400n); // primary store XLSX items = 12,524.00 EGP

  // Verify Trial Balance on primary store matches exact ledger positions (1,500,000 + 500,000 = 2,000,000 opening debt, 500,000 paid -> 1,500,000 due)
  const tbRes = await req(`/api/reports/trial-balance?storeId=${storeId}&from=2026-10-01&to=2026-12-31`);
  assert.equal(tbRes.status, 200);
  const acc1300 = tbRes.body.accounts.find((a) => a.accountCode === '1300');
  const acc2010 = tbRes.body.accounts.find((a) => a.accountCode === '2010');
  const acc3010 = tbRes.body.accounts.find((a) => a.accountCode === '3010');
  const acc1020 = tbRes.body.accounts.find((a) => a.accountCode === '1020');
  const acc5090 = tbRes.body.accounts.find((a) => a.accountCode === '5090');

  assert.equal(BigInt(acc1300.debitBalance.amount) - BigInt(acc1300.creditBalance.amount), inventoryValuationMinor);
  assert.equal(BigInt(acc2010.creditBalance.amount) - BigInt(acc2010.debitBalance.amount), 1500000n);
  const eqCreditMinusDebit = BigInt(acc3010.periodCredit.amount) - BigInt(acc3010.periodDebit.amount);
  assert.equal(eqCreditMinusDebit, inventoryValuationMinor - 2000000n);
  assert.equal(BigInt(acc1020.periodCredit.amount), 500000n);
  assert.equal(acc5090 ? BigInt(acc5090.debitBalance.amount) - BigInt(acc5090.creditBalance.amount) : 0n, 0n);

  // Verify P&L is zeroed (opening inventory and opening debt + edits NEVER pollute operating P&L)
  const plRes = await req(`/api/reports/profit-loss?storeId=${storeId}&from=2026-10-01&to=2026-12-31`);
  assert.equal(plRes.status, 200);
  assert.equal(BigInt(plRes.body.profitLoss.operatingProfit.amount), 0n);
  assert.equal(BigInt(plRes.body.profitLoss.inventoryAdjustmentsLoss.amount), 0n);

  // Verify Financial Map tags opening debt clearly (including adjustment postings)
  const fmRes = await req(`/api/reports/financial-map?storeId=${storeId}&from=2026-10-01&to=2026-12-31`);
  assert.equal(fmRes.status, 200);
  const openingDebtEvents = fmRes.body.timeline.filter((e) => e.category === 'مديونية افتتاحية لتاجر');
  assert.ok(openingDebtEvents.length >= 2);
});
