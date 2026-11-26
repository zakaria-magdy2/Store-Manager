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
  CARTON_SIZES,
  CARTON_TYPES,
  buildCartonDistribution,
  buildCartonNewProductPayload,
  mergeDuplicateSkuNewProducts,
} from '../public/carton-presets.mjs';
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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dataDir = await createTestTempDir('retailos-carton-purchase-');
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      RETAILOS_DATA_DIR: dataDir,
      RETAILOS_COMPANY_NAME: 'شركة الكراتين التجريبية',
      RETAILOS_COMPANY_CODE: 'CARTON_TST',
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
    customerName: 'شركة الكراتين التجريبية',
    machineId: licStatus.body.machineId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    planName: 'Test Annual Plan',
  });
  assert.equal((await req('/api/license/activate', { method: 'POST', body: JSON.stringify({ token }) })).status, 200);
  assert.equal((await req('/api/setup', {
    method: 'POST',
    body: JSON.stringify({ ownerUsername: 'carton_owner', ownerName: 'مالك التجربة', password: 'Carton-Owner-Pass-2026' }),
  })).status, 201);
  assert.equal((await req('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'carton_owner', password: 'Carton-Owner-Pass-2026' }),
  })).status, 200);
});

after(async () => {
  if (serverProcess) {
    await terminateChildProcessTree(serverProcess);
    serverProcess = null;
  }
  if (dataDir) await cleanupTempDir(dataDir);
});

test('CARTON_TYPES define all 6 types with exact ranges and sizes, and distributions cover 5/10/15 with 0/1/2/3 colors + overrides', async () => {
  assert.deepEqual(
    CARTON_TYPES.map((t) => [t.label, t.rangeLabel, t.sizes]),
    [
      ['بيبي', '22-26', ['22', '23', '24', '25', '26']],
      ['صيدلية', '18-22', ['18', '19', '20', '21', '22']],
      ['أطفال', '27-31', ['27', '28', '29', '30', '31']],
      ['أولادي', '32-36', ['32', '33', '34', '35', '36']],
      ['حريمي', '37-41', ['37', '38', '39', '40', '41']],
      ['رجالي', '42-46', ['42', '43', '44', '45', '46']],
    ],
  );
  assert.deepEqual(CARTON_SIZES, [5, 10, 15]);

  // 1) No color (0 colors) for 5, 10, 15
  for (const size of CARTON_SIZES) {
    const dist = buildCartonDistribution({ typeId: 'pharmacy', cartonSize: size, colors: [] });
    assert.equal(dist.options.length, 1);
    assert.equal(dist.options[0].name, 'المقاس');
    assert.equal(dist.totalPieces, size);
    assert.equal(dist.evenSplit, true);
    assert.equal(dist.entries.every((e) => e.color === null && e.quantity === size / 5), true);
  }

  // 2) Single color (1 color) for 5, 10, 15
  for (const size of CARTON_SIZES) {
    const dist = buildCartonDistribution({ typeId: 'boys', cartonSize: size, colors: ['أسود'] });
    assert.equal(dist.options.length, 2);
    assert.deepEqual(dist.options[0].values, ['أسود']);
    assert.equal(dist.totalPieces, size);
    assert.equal(dist.evenSplit, true);
    assert.equal(dist.entries.every((e) => e.color === 'أسود' && e.quantity === size / 5), true);
  }

  // 3) 2 colors: exact 1 per color per size on 10; balanced totals on 5 and 15
  const tenTwoColors = buildCartonDistribution({ typeId: 'men', cartonSize: 10, colors: ['أسود', 'أبيض'] });
  assert.equal(tenTwoColors.totalPieces, 10);
  assert.equal(tenTwoColors.evenSplit, true);
  assert.equal(tenTwoColors.entries.length, 10);
  assert.equal(tenTwoColors.entries.every((e) => e.quantity === 1), true);

  for (const size of [5, 15]) {
    const d2 = buildCartonDistribution({ typeId: 'women', cartonSize: size, colors: ['أسود', 'بيج'] });
    assert.equal(d2.totalPieces, size);
    assert.equal(d2.evenSplit, false);
  }

  // 4) 3 colors: exact 1 per color per size on 15; balanced totals on 5 and 10
  const fifteenThreeColors = buildCartonDistribution({ typeId: 'kids', cartonSize: 15, colors: ['أحمر', 'أزرق', 'أبيض'] });
  assert.equal(fifteenThreeColors.totalPieces, 15);
  assert.equal(fifteenThreeColors.evenSplit, true);
  assert.equal(fifteenThreeColors.entries.length, 15);
  assert.equal(fifteenThreeColors.entries.every((e) => e.quantity === 1), true);

  for (const size of [5, 10]) {
    const d3 = buildCartonDistribution({ typeId: 'baby', cartonSize: size, colors: ['أحمر', 'أزرق', 'أبيض'] });
    assert.equal(d3.totalPieces, size);
    assert.equal(d3.evenSplit, false);
  }

  // 5) Editing quantity from hidden matrix via overrides
  const edited = buildCartonDistribution({
    typeId: 'women',
    cartonSize: 10,
    colors: ['نبيتي'],
    overrides: { 'اللون=نبيتي:::المقاس=39': 5 },
  });
  assert.equal(edited.totalPieces, 13); // 2 + 2 + 5 + 2 + 2 = 13
  assert.equal(edited.entries.find((e) => e.size === '39').quantity, 5);

  // 6) Purchase UI includes carton mode, hidden table toggle, and multi-carton add button
  const appJs = await readFile(join(appDir, 'public', 'app.js'), 'utf8');
  assert.equal(appJs.includes('./carton-presets.mjs'), true);
  assert.equal(appJs.includes('data-group-mode="CARTON"'), true);
  assert.equal(appJs.includes('id="add-purchase-carton"'), true);
  assert.equal(appJs.includes('data-carton-toggle-matrix='), true);
  assert.equal(appJs.includes('gridEl.hidden = !gs.cartonMatrixOpen'), true);
});

test('multi-carton purchase invoice (5/10/15, 0/1/2/3 colors, and edited table qty) posts normal purchase & inventory GL entries', async () => {
  const boot = await req('/api/data');
  assert.equal(boot.status, 200);
  const storeId = boot.body.selectedStoreId;

  // Fund drawer with 50,000.00 EGP opening cash so partial cash payment works cleanly
  assert.equal((await req('/api/accounting/opening-balances', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-11-26',
      cashDrawer: '5000000',
      cashSafe: '0',
      bank: '0',
    }),
  })).status, 201);

  const supRes = await req('/api/suppliers', {
    method: 'POST',
    body: JSON.stringify({ name: 'مصنع الأحذية الحديثة', phone: '01009998877' }),
  });
  assert.equal(supRes.status, 201);
  const supplierId = supRes.body.id;

  const catRes = await req('/api/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'أحذية كراتين' }),
  });
  assert.equal(catRes.status, 201);
  const categoryId = catRes.body.id;

  // Build 4 cartons inside ONE purchase invoice:
  // Carton 1: رجالي (42-46), 10 pcs, 2 colors (أسود، أبيض) -> untouched generated quantities = 10 pcs @ 200 EGP
  const c1 = buildCartonNewProductPayload({
    name: 'كوتشي رجالي كرتونة 1',
    sku: 'CRT-MEN-10',
    categoryId,
    unitCostMinor: '20000',
    retailPriceMinor: '35000',
    distribution: buildCartonDistribution({ typeId: 'men', cartonSize: 10, colors: ['أسود', 'أبيض'] }),
  });

  // Carton 2: أطفال (27-31), 15 pcs, 3 colors -> untouched = 15 pcs @ 150 EGP
  const c2 = buildCartonNewProductPayload({
    name: 'كوتشي أطفال كرتونة 2',
    sku: 'CRT-KIDS-15',
    categoryId,
    unitCostMinor: '15000',
    retailPriceMinor: '26000',
    distribution: buildCartonDistribution({ typeId: 'kids', cartonSize: 15, colors: ['أحمر', 'أزرق', 'أبيض'] }),
  });

  // Carton 3: بيبي (22-26), 5 pcs, NO color -> untouched = 5 pcs @ 100 EGP
  const c3 = buildCartonNewProductPayload({
    name: 'شوز بيبي كرتونة 3',
    sku: 'CRT-BABY-05',
    categoryId,
    unitCostMinor: '10000',
    retailPriceMinor: '18000',
    distribution: buildCartonDistribution({ typeId: 'baby', cartonSize: 5, colors: [] }),
  });

  // Carton 4: حريمي (37-41), 10 pcs, 1 color (نبيتي), edited size 39 qty 2 -> 5 from hidden table => 13 pcs @ 180 EGP
  const c4 = buildCartonNewProductPayload({
    name: 'شوز حريمي كرتونة 4',
    sku: 'CRT-WMN-ED',
    categoryId,
    unitCostMinor: '18000',
    retailPriceMinor: '32000',
    distribution: buildCartonDistribution({
      typeId: 'women',
      cartonSize: 10,
      colors: ['نبيتي'],
      overrides: { 'اللون=نبيتي:::المقاس=39': 5 },
    }),
  });

  const mergedProducts = mergeDuplicateSkuNewProducts([c1.product, c2.product, c3.product, c4.product]);
  assert.equal(mergedProducts.length, 4);

  // Also test merge helper when two identical-SKU cartons are submitted in the same invoice
  const sameSkuMerge = mergeDuplicateSkuNewProducts([
    buildCartonNewProductPayload({
      name: 'موديل مكرر',
      sku: 'SAME-1',
      unitCostMinor: '12000',
      distribution: buildCartonDistribution({ typeId: 'boys', cartonSize: 5, colors: ['أسود'] }),
    }).product,
    buildCartonNewProductPayload({
      name: 'موديل مكرر',
      sku: 'SAME-1',
      unitCostMinor: '12000',
      distribution: buildCartonDistribution({ typeId: 'boys', cartonSize: 5, colors: ['أسود'] }),
    }).product,
  ]);
  assert.equal(sameSkuMerge.length, 1);
  assert.equal(sameSkuMerge[0].variants.reduce((s, v) => s + Number(v.quantity), 0), 10);

  const invoiceTotalMinor = c1.totalCostMinor + c2.totalCostMinor + c3.totalCostMinor + c4.totalCostMinor;
  // (10*20,000) + (15*15,000) + (5*10,000) + (13*18,000) = 200,000 + 225,000 + 50,000 + 234,000 = 709,000
  assert.equal(invoiceTotalMinor, 709000n);
  const cashPaidMinor = 309000n;

  const purRes = await req('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      supplierId,
      storeId,
      invoiceNumber: 'INV-CARTON-01',
      paymentMethod: 'CASH',
      paidAmount: cashPaidMinor.toString(),
      totalAmount: invoiceTotalMinor.toString(),
      newProducts: mergedProducts,
      items: [],
    }),
  });
  assert.equal(purRes.status, 201, JSON.stringify(purRes.body));

  // Verify stock & variants in /api/data
  const dataAfter = await req(`/api/data?storeId=${storeId}`);
  assert.equal(dataAfter.status, 200);

  const prod1 = dataAfter.body.products.find((p) => p.sku === 'CRT-MEN-10');
  const prod2 = dataAfter.body.products.find((p) => p.sku === 'CRT-KIDS-15');
  const prod3 = dataAfter.body.products.find((p) => p.sku === 'CRT-BABY-05');
  const prod4 = dataAfter.body.products.find((p) => p.sku === 'CRT-WMN-ED');

  assert.ok(prod1 && prod2 && prod3 && prod4);
  assert.equal(prod1.variants.reduce((s, v) => s + Number(v.quantity), 0), 10);
  assert.equal(prod2.variants.reduce((s, v) => s + Number(v.quantity), 0), 15);
  assert.equal(prod3.options.length, 1); // no color option!
  assert.equal(prod3.variants.reduce((s, v) => s + Number(v.quantity), 0), 5);
  assert.equal(prod4.variants.reduce((s, v) => s + Number(v.quantity), 0), 13);
  const size39Variant = prod4.variants.find((v) => Object.values(v.attributes).includes('39'));
  assert.equal(size39Variant.quantity, '5');

  // Verify normal purchase accounting: Inventory 1300 = 709,000; AP 2010 = 400,000; Drawer 1010 = 5,000,000 - 309,000 = 4,691,000
  const tb = await req(`/api/reports/trial-balance?storeId=${storeId}`);
  assert.equal(tb.status, 200);
  assert.equal(tb.body.totals.isBalanced, true);
  const acc = (code) => tb.body.accounts.find((a) => a.accountCode === code);
  assert.equal(BigInt(acc('1300').debitBalance.amount) - BigInt(acc('1300').creditBalance.amount), 709000n);
  assert.equal(BigInt(acc('2010').creditBalance.amount) - BigInt(acc('2010').debitBalance.amount), 400000n);
  assert.equal(BigInt(acc('1010').debitBalance.amount) - BigInt(acc('1010').creditBalance.amount), 5000000n - 309000n);
});
