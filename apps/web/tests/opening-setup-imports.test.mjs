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

test('UI removes main Opening Balances dialog and adds supplier debt + Excel opening inventory entry points', async () => {
  const appJs = await readFile(join(appDir, 'public', 'app.js'), 'utf8');
  assert.equal(appJs.includes('btn-open-opening-balances'), false);
  assert.equal(appJs.includes('showOpeningBalancesModal'), false);
  assert.equal(appJs.includes('new-opening-debt'), true);
  assert.equal(appJs.includes('opening-inventory-import-btn'), true);
  assert.equal(/\bdownload:\s*'/.test(appJs), true);
  assert.equal(appJs.includes("querySelectorAll('#new-opening-debt, #empty-new-opening-debt')"), true);
});

test('supplier opening debt without invoice, payment paydown, return guard, and opening inventory xlsx/csv import reconcile cleanly', async () => {
  const data1 = await req('/api/data');
  assert.equal(data1.status, 200);
  const storeId = data1.body.selectedStoreId;

  // Seed drawer cash first via shift or treasury/opening? Use opening-debt (doesn't require cash) first!
  const debtKey = randomUUID();
  const inlineDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      newSupplier: {
        name: 'شركة النور للتوريدات',
        phone: '01001122334',
        notes: 'تاجر قديم',
      },
      amount: '1500000', // 15,000.00 EGP
      entryDate: '2026-10-01',
      notes: 'رصيد سابق من الدفتر الورقي',
    }),
  });
  assert.equal(inlineDebtRes.status, 201, `Inline opening debt failed: ${JSON.stringify(inlineDebtRes.body)}`);
  assert.ok(inlineDebtRes.body.invoiceNumber.startsWith('ODEBT-'));
  const supplierId = inlineDebtRes.body.supplierId;

  // Idempotent replay with same key
  const replayDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      newSupplier: {
        name: 'شركة النور للتوريدات',
      },
      amount: '1500000',
      entryDate: '2026-10-01',
    }),
  });
  assert.equal(replayDebtRes.status, 201);
  assert.equal(replayDebtRes.body.id, inlineDebtRes.body.id);

  // Conflict when reusing same key with different newSupplier name (same amount & store)
  const conflictNameDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      newSupplier: {
        name: 'مورد مختلف بنفس المفتاح',
      },
      amount: '1500000',
    }),
  });
  assert.equal(conflictNameDebtRes.status, 409);

  // Conflict when reusing same key with different amount
  const conflictDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: debtKey,
      storeId,
      supplierId,
      amount: '2000000',
    }),
  });
  assert.equal(conflictDebtRes.status, 409);

  // Add second opening debt to existing supplier
  const secondDebtRes = await req('/api/suppliers/opening-debt', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
      supplierId,
      amount: '500000', // 5,000.00 EGP
      entryDate: '2026-10-01',
      notes: 'دفتر إضافي',
    }),
  });
  assert.equal(secondDebtRes.status, 201);

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

  // Re-committing under a new key fails with 409 conflict (rollback cleanly)
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

  // Valid CSV with Arabic numerals also previews & commits cleanly
  const validCsv = Buffer.from('\uFEFFاسم الصنف,النوع / الفئة,كود الموديل,اللون,المقاس,الكمية,سعر التكلفة (جنيه),سعر البيع (جنيه),الباركود (اختياري),حد إعادة الطلب\nجاكيت شتوي,جواكت,JKT-777,أسود,XL,١٠,٤٥٠٫٥٠,٨٥٠,6223007770019,٢\n', 'utf8').toString('base64');
  const commitCsv = await req('/api/inventory/opening-import/commit', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      storeId,
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

  // PATCH on opening debt updates notes cleanly and keeps targetProfitPercent null
  const patchDebtRes = await req(`/api/purchases/${inlineDebtRes.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      notes: 'ملاحظة محدثة للمديونية الافتتاحية',
      targetProfitPercent: 25,
    }),
  });
  assert.equal(patchDebtRes.status, 200);

  // Verify `/api/data` products, suppliers, and opening debt metadata
  const dataAfter = await req('/api/data');
  assert.equal(dataAfter.status, 200);
  const supAfter = dataAfter.body.suppliers.find((s) => s.id === supplierId);
  assert.ok(supAfter);
  assert.equal(supAfter.totalPurchased, '2000000'); // 15k + 5k
  assert.equal(supAfter.totalPaid, '500000');
  assert.equal(supAfter.balanceDue, '1500000');
  assert.equal(supAfter.purchases.every((p) => p.isOpeningDebt === true), true);
  const patchedEntry = supAfter.purchases.find((p) => p.id === inlineDebtRes.body.id);
  assert.equal(patchedEntry.notes, 'ملاحظة محدثة للمديونية الافتتاحية');
  assert.equal(patchedEntry.targetProfitPercent, null);

  // Verify physical inventory valuation == SUM(qty * wac)
  let inventoryValuationMinor = 0n;
  for (const prod of dataAfter.body.products) {
    for (const variant of prod.variants) {
      const qty = BigInt(variant.quantity ?? 0);
      const wac = BigInt(variant.wac?.amount ?? 0);
      inventoryValuationMinor += qty * wac;
    }
  }
  assert.equal(inventoryValuationMinor, 1252400n + 450500n); // 1,702,900 piasters = 17,029.00 EGP

  // Verify Trial Balance matches exact ledger positions and stays balanced
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

  // Verify P&L is zeroed (opening inventory and opening debt NEVER pollute operating P&L)
  const plRes = await req(`/api/reports/profit-loss?storeId=${storeId}&from=2026-10-01&to=2026-12-31`);
  assert.equal(plRes.status, 200);
  assert.equal(BigInt(plRes.body.profitLoss.operatingProfit.amount), 0n);
  assert.equal(BigInt(plRes.body.profitLoss.inventoryAdjustmentsLoss.amount), 0n);

  // Verify Financial Map tags opening debt clearly
  const fmRes = await req(`/api/reports/financial-map?storeId=${storeId}&from=2026-10-01&to=2026-12-31`);
  assert.equal(fmRes.status, 200);
  const openingDebtEvents = fmRes.body.timeline.filter((e) => e.category === 'مديونية افتتاحية لتاجر');
  assert.equal(openingDebtEvents.length, 2);
});
