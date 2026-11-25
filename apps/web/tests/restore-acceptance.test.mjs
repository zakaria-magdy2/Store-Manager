import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServerApp } from '../server.mjs';

const require = createRequire(new URL('../../../packages/infrastructure/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const watermarkSecret = randomBytes(32).toString('hex');
const backupPassphrase = 'C3-cross-device-backup-passphrase-2026';
const ownerUsername = 'c3_restore_owner';
const ownerPassword = 'C3-Restore-Owner-Password-2026';
const machineId = 'ROS-ABCD-EFGH-JKLM';
const sourceMachineId = 'ROS-2345-6789-ABCD';
const targetMachineId = 'ROS-EFGH-JKLM-NPQR';

function signLicense(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${encodedPayload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')}`;
}

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startApp(dataDir, port, extraOptions = {}) {
  const {
    companyName = 'متجر استعادة C3',
    companyCode = 'C3_RESTORE_SHOP',
    currency = 'EGP',
    ...serverOptions
  } = extraOptions;
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(port);
  process.env.RETAILOS_DATA_DIR = dataDir;
  delete process.env.RETAILOS_DB_PATH;
  delete process.env.RETAILOS_BACKUP_DIR;
  process.env.RETAILOS_COMPANY_NAME = companyName;
  process.env.RETAILOS_COMPANY_CODE = companyCode;
  process.env.RETAILOS_CURRENCY = currency;
  process.env.RETAILOS_STORE_NAME = 'فرع C3';
  const app = await createServerApp({
    watermarkSecret,
    dailyBackupSecret: randomBytes(32).toString('base64url'),
    licensePublicKey: publicKeyPem,
    licenseIdentityProvider: () => ({ machineId, isHardwareBacked: true }),
    ...serverOptions,
  });
  if (!app.server.listening) await once(app.server, 'listening');
  return { ...app, url: `http://127.0.0.1:${port}` };
}

async function api(url, path, { method = 'GET', body, cookie, headers: extraHeaders } = {}) {
  const headers = { Origin: url, ...(extraHeaders ?? {}) };
  if (body !== undefined && !Buffer.isBuffer(body)) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, payload };
}

async function waitForChildOutput(child, readOutput, marker, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(marker)) return readOutput();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Restore harness exited early (code=${child.exitCode}, signal=${child.signalCode}): ${readOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${marker}: ${readOutput()}`);
}

function spawnRestoreHarness(dataDir, port, failRestore) {
  const harnessPath = fileURLToPath(new URL('./restore-restart-harness.mjs', import.meta.url));
  const child = spawn(process.execPath, [harnessPath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      RETAILOS_DATA_DIR: dataDir,
      RETAILOS_COMPANY_NAME: 'متجر استعادة عملية C3',
      RETAILOS_COMPANY_CODE: 'C3_RESTORE_SHOP',
      RETAILOS_CURRENCY: 'EGP',
      RETAILOS_STORE_NAME: 'فرع استعادة C3',
      RETAILOS_TEST_LICENSE_PUBLIC_KEY: publicKeyPem,
      RETAILOS_TEST_WATERMARK_SECRET: watermarkSecret,
      RETAILOS_TEST_DAILY_BACKUP_SECRET: randomBytes(32).toString('base64url'),
      RETAILOS_TEST_MACHINE_ID: machineId,
      RETAILOS_TEST_RESTORE_FAILURE: failRestore ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { child, readOutput: () => output };
}

async function stopRestoreHarness(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, `Restore harness exited unexpectedly (signal=${child.signalCode})`);
    return;
  }
  let timeoutHandle;
  child.stdin.write('TEST_SHUTDOWN\n');
  try {
    const [exitCode, signalCode] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Restore harness did not stop cleanly')), 15_000);
      }),
    ]);
    assert.equal(exitCode, 0, `Restore harness did not shut down cleanly (signal=${signalCode})`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function activateAndSetup(app) {
  const status = await api(app.url, '/api/license/status');
  assert.equal(status.response.status, 200);
  const now = Date.now();
  const token = signLicense({
    licenseId: `TST-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerName: 'متجر C3 الاصطناعي',
    machineId: status.payload.machineId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    planName: 'C3 Test License',
  });
  const activation = await api(app.url, '/api/license/activate', { method: 'POST', body: { token } });
  assert.equal(activation.response.status, 200, JSON.stringify(activation.payload));
  const setup = await api(app.url, '/api/setup', {
    method: 'POST',
    body: { ownerUsername, ownerName: 'مالك C3 الاصطناعي', password: ownerPassword },
  });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
  const login = await api(app.url, '/api/login', {
    method: 'POST',
    body: { username: ownerUsername, password: ownerPassword },
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.payload));
  return login.response.headers.get('set-cookie').split(';')[0];
}

function databaseInvariants(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    const foreignKeys = db.pragma('foreign_key_check');
    const orphanJournalLines = db.prepare(`
      SELECT COUNT(*) AS n
      FROM journal_lines l LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE e.id IS NULL
    `).get().n;
    const inventoryMismatches = db.prepare(`
      SELECT COUNT(*) AS n FROM inventory_items i
      LEFT JOIN stock_movements m
        ON m.tenant_id = i.tenant_id AND m.store_id = i.store_id AND m.variant_id = i.variant_id
      GROUP BY i.id
      HAVING i.quantity_on_hand <> COALESCE(SUM(m.quantity_delta), 0)
    `).all().length;
    const ledger = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0) AS debits,
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credits
      FROM journal_lines
    `).get();
    const sales = db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
    const purchases = db.prepare('SELECT COUNT(*) AS n FROM supplier_purchases').get().n;
    const journalEntries = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
    const journalLines = db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get().n;
    const duplicateSaleNumbers = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT tenant_id, sale_number FROM sales GROUP BY tenant_id, sale_number HAVING COUNT(*) > 1
      )
    `).get().n;
    const duplicateSaleIdempotencyKeys = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT tenant_id, idempotency_key FROM sales WHERE idempotency_key IS NOT NULL
        GROUP BY tenant_id, idempotency_key HAVING COUNT(*) > 1
      )
    `).get().n;
    const journalRows = db.prepare(`
      SELECT e.id AS journalEntryId, e.source_type AS sourceType, e.source_id AS sourceId,
        l.id AS journalLineId, a.account_code AS accountCode, l.entry_type AS entryType, l.amount AS amount
      FROM journal_entries e
      JOIN journal_lines l ON l.journal_entry_id = e.id
      JOIN accounts a ON a.id = l.account_id
      ORDER BY e.id, l.id
    `).all();
    return {
      integrity: integrity[0]?.integrity_check,
      foreignKeyViolations: foreignKeys.length,
      orphanJournalLines,
      inventoryMismatches,
      sales,
      purchases,
      journalEntries,
      journalLines,
      journalRows,
      duplicateSaleNumbers,
      duplicateSaleIdempotencyKeys,
      debitTotal: String(ledger.debits),
      creditTotal: String(ledger.credits),
    };
  } finally {
    db.close();
  }
}

test('full synthetic purchase, POS sale, encrypted cross-device restore, and maintenance gate', async (t) => {
  const originalEnv = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'retailos-c3-business-restore-'));
  const sourceDir = join(root, 'source-device');
  const targetDir = join(root, 'replacement-device');
  const sourcePort = await reservePort();
  const targetPort = await reservePort();
  let source = null;
  let target = null;
  let restartPromise = null;
  let holdDataRequest = false;
  let signalRestartTriggered;
  let signalMaintenanceStarted;
  let signalScheduledTaskStarted;
  let signalInFlightDataStarted;
  let releaseRestoreBarrier;
  let releaseScheduledTask;
  let releaseInFlightData;
  let restoreBarrierEntered;
  const restartTriggered = new Promise((resolve) => { signalRestartTriggered = resolve; });
  const maintenanceStarted = new Promise((resolve) => { signalMaintenanceStarted = resolve; });
  const scheduledTaskStarted = new Promise((resolve) => { signalScheduledTaskStarted = resolve; });
  const inFlightDataStarted = new Promise((resolve) => { signalInFlightDataStarted = resolve; });
  const restoreBarrier = new Promise((resolve) => { releaseRestoreBarrier = resolve; });
  const scheduledTaskBarrier = new Promise((resolve) => { releaseScheduledTask = resolve; });
  const inFlightDataBarrier = new Promise((resolve) => { releaseInFlightData = resolve; });
  const atRestoreBarrier = new Promise((resolve) => { restoreBarrierEntered = resolve; });

  try {
    const sourceWatermarkSecret = randomBytes(32).toString('hex');
    const targetWatermarkSecret = randomBytes(32).toString('hex');
    const targetOptions = {
      companyName: '50%',
      companyCode: 'DIFFERENT_TARGET_CODE',
      currency: 'USD',
      watermarkSecret: targetWatermarkSecret,
      licenseIdentityProvider: () => ({ machineId: targetMachineId, isHardwareBacked: true }),
    };
    source = await startApp(sourceDir, sourcePort, {
      companyCode: 'XDEV_SYNTH',
      currency: 'EGP',
      watermarkSecret: sourceWatermarkSecret,
      licenseIdentityProvider: () => ({ machineId: sourceMachineId, isHardwareBacked: true }),
    });
    const sourceCookie = await activateAndSetup(source);
    const bootstrap = await api(source.url, `/api/data` , { cookie: sourceCookie });
    assert.equal(bootstrap.response.status, 200);
    const storeId = bootstrap.payload.stores[0].id;

    const product = await api(source.url, '/api/products', {
      method: 'POST', cookie: sourceCookie,
      body: {
        name: 'حقيبة C3 متعددة المقاسات', sku: 'C3-BAG', hasVariants: true,
        options: [
          { key: 'color', name: 'اللون', values: ['أسود', 'بني'] },
          { key: 'size', name: 'المقاس', values: ['S', 'M'] },
        ],
        variants: [
          { sku: 'C3-BAG-BLK-S', attributes: { color: 'أسود', size: 'S' }, retailPrice: '12000', reorderPoint: '0' },
          { sku: 'C3-BAG-BRN-M', attributes: { color: 'بني', size: 'M' }, retailPrice: '14000', reorderPoint: '0' },
        ],
      },
    });
    assert.equal(product.response.status, 201, JSON.stringify(product.payload));
    const initialData = await api(source.url, `/api/data?storeId=${storeId}`, { cookie: sourceCookie });
    const variants = initialData.payload.products.find((p) => p.id === product.payload.id).variants;
    const blackSmall = variants.find((v) => v.sku === 'C3-BAG-BLK-S');
    const brownMedium = variants.find((v) => v.sku === 'C3-BAG-BRN-M');
    assert.ok(blackSmall && brownMedium);

    const supplier = await api(source.url, '/api/suppliers', {
      method: 'POST', cookie: sourceCookie, body: { name: 'تاجر C3 الاصطناعي' },
    });
    assert.equal(supplier.response.status, 201, JSON.stringify(supplier.payload));
    const purchase = await api(source.url, '/api/purchases', {
      method: 'POST', cookie: sourceCookie,
      body: {
        supplierId: supplier.payload.id, storeId, idempotencyKey: randomUUID(),
        invoiceNumber: 'C3-PURCHASE-001', totalAmount: '27000', paidAmount: '27000', paymentMethod: 'BANK_TRANSFER',
        items: [
          { variantId: blackSmall.id, quantity: '3', unitCost: '5000', retailPrice: '12000' },
          { variantId: brownMedium.id, quantity: '2', unitCost: '6000', retailPrice: '14000' },
        ],
      },
    });
    assert.equal(purchase.response.status, 201, JSON.stringify(purchase.payload));

    const shift = await api(source.url, '/api/shifts/start', {
      method: 'POST', cookie: sourceCookie, body: { storeId, openingCash: '50000' },
    });
    assert.equal(shift.response.status, 201, JSON.stringify(shift.payload));
    const checkout = await api(source.url, '/api/checkout', {
      method: 'POST', cookie: sourceCookie,
      body: {
        storeId, idempotencyKey: randomUUID(),
        items: [{ variantId: blackSmall.id, quantity: '1' }, { variantId: brownMedium.id, quantity: '1' }],
        payments: [{ method: 'cash', amountMinor: '20000' }, { method: 'card', amountMinor: '6000' }],
      },
    });
    assert.equal(checkout.response.status, 201, JSON.stringify(checkout.payload));
    assert.equal(checkout.payload.total.amount, '26000');

    const invoice = await api(source.url, `/api/sales/${checkout.payload.id}`, { cookie: sourceCookie });
    assert.equal(invoice.response.status, 200);
    const dataBefore = await api(source.url, `/api/data?storeId=${storeId}`, { cookie: sourceCookie });
    const productBefore = dataBefore.payload.products.find((p) => p.id === product.payload.id);
    const tbBefore = await api(source.url, `/api/reports/trial-balance?storeId=${storeId}`, { cookie: sourceCookie });
    assert.equal(tbBefore.response.status, 200);
    assert.equal(tbBefore.payload.totals.isBalanced, true);
    const cashBefore = tbBefore.payload.accounts.find((account) => account.accountCode === '1010');
    assert.ok(cashBefore);
    const beforeSnapshot = {
      invoice: invoice.payload.payload,
      inventory: productBefore.variants.map(({ sku, quantity, wac }) => ({ sku, quantity, wac: wac?.amount ?? null })).sort((a, b) => a.sku.localeCompare(b.sku)),
      account1010: cashBefore,
      trialBalance: tbBefore.payload.totals,
      database: databaseInvariants(source.databasePath),
    };
    assert.deepEqual(beforeSnapshot.database, {
      integrity: 'ok', foreignKeyViolations: 0, orphanJournalLines: 0, inventoryMismatches: 0,
      sales: 1, purchases: 1, journalEntries: 2, journalLines: 7,
      journalRows: beforeSnapshot.database.journalRows,
      duplicateSaleNumbers: 0, duplicateSaleIdempotencyKeys: 0,
      debitTotal: beforeSnapshot.database.debitTotal, creditTotal: beforeSnapshot.database.creditTotal,
    });
    assert.equal(beforeSnapshot.database.journalRows.length, beforeSnapshot.database.journalLines);
    assert.equal(beforeSnapshot.database.debitTotal, beforeSnapshot.database.creditTotal);
    assert.deepEqual(beforeSnapshot.inventory.map((v) => [v.sku, v.quantity]), [['C3-BAG-BLK-S', '2'], ['C3-BAG-BRN-M', '1']]);

    const exported = await api(source.url, '/api/backups/export', {
      method: 'POST', cookie: sourceCookie, body: { passphrase: backupPassphrase },
    });
    assert.equal(exported.response.status, 200);
    assert.equal(exported.payload.subarray(0, 5).toString(), 'RFBK2');
    const sourceIdentityDb = new Database(source.databasePath, { readonly: true });
    const sourceTenant = sourceIdentityDb.prepare('SELECT id, code, currency FROM tenants').get();
    sourceIdentityDb.close();
    await source.shutdown();
    source = null;

    target = await startApp(targetDir, targetPort, {
      ...targetOptions,
      beforeApiRequest: async (url) => {
        if (holdDataRequest && url.pathname === '/api/data') {
          signalInFlightDataStarted();
          await inFlightDataBarrier;
        }
      },
      beforeScheduledDatabaseTask: async () => {
        signalScheduledTaskStarted();
        await scheduledTaskBarrier;
      },
      onRestoreMaintenanceStarted: () => signalMaintenanceStarted(),
      beforeRestoreInstall: async () => {
        restoreBarrierEntered();
        await restoreBarrier;
      },
      onRestoreRestartRequested: async () => {
        t.diagnostic('restore restart callback entered');
        restartPromise = (async () => {
          await target.shutdown();
          t.diagnostic('old test server shutdown complete');
          target = await startApp(targetDir, targetPort, targetOptions);
          t.diagnostic('replacement test server started');
        })();
        signalRestartTriggered(restartPromise);
        await restartPromise;
      },
      onRequestFailure: ({ status, code, message }) => {
        const safeMessage = String(message).replaceAll(backupPassphrase, '[redacted]');
        t.diagnostic(`Synthetic request failure ${status} ${code ?? ''}: ${safeMessage}`);
      },
    });
    const targetCookie = await activateAndSetup(target);
    const targetDbBefore = new Database(target.databasePath);
    const targetTenantId = targetDbBefore.prepare('SELECT id FROM tenants').pluck().get();
    assert.notEqual(targetTenantId, sourceTenant.id, 'source and target must have different internal tenant ids');
    targetDbBefore.prepare('INSERT INTO categories (id, tenant_id, name, code) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), targetTenantId, 'بيانات هدف يجب استبدالها', 'TARGET_ONLY');
    const targetLicenseTokenBefore = targetDbBefore.prepare('SELECT activation_token FROM system_licensing WHERE id = 1').pluck().get();
    targetDbBefore.close();
    await Promise.race([
      scheduledTaskStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Scheduled database task did not start for drain test')), 5000)),
    ]);
    holdDataRequest = true;
    const inFlightDataRequest = api(target.url, '/api/data', { cookie: targetCookie });
    await inFlightDataStarted;
    const restoreRequest = api(target.url, '/api/backups/restore', {
      method: 'POST', cookie: targetCookie, body: exported.payload,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Backup-Passphrase': Buffer.from(backupPassphrase, 'utf8').toString('base64url'),
        'X-RetailOS-Restore-Confirm': 'replace',
      },
    });
    const restoreGate = await Promise.race([
      maintenanceStarted.then(() => ({ started: true })),
      restoreRequest.then((result) => ({ earlyResult: result })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 10_000)),
    ]);
    if ('earlyResult' in restoreGate) {
      assert.fail(`Restore failed before entering maintenance: ${restoreGate.earlyResult.response.status} ${JSON.stringify(restoreGate.earlyResult.payload)}`);
    }
    assert.equal('started' in restoreGate, true, 'restore must enter maintenance within ten seconds');
    assert.equal(await Promise.race([atRestoreBarrier.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))]), false,
      'restore must wait for the active API request and scheduled database work');
    const gatedRequest = await api(target.url, '/api/data', { cookie: targetCookie });
    assert.equal(gatedRequest.response.status, 503, 'new database requests must be rejected during maintenance');
    releaseInFlightData();
    const inFlightResult = await inFlightDataRequest;
    assert.equal(inFlightResult.response.status, 200, 'the pre-existing API request must finish before file replacement');
    assert.equal(await Promise.race([atRestoreBarrier.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))]), false,
      'restore must still wait for the scheduled database task');
    releaseScheduledTask();
    const barrierState = await Promise.race([
      atRestoreBarrier.then(() => 'entered'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    if (barrierState !== 'entered') {
      const earlyRestore = await restoreRequest;
      assert.fail(`Restore failed before entering maintenance: ${earlyRestore.response.status} ${JSON.stringify(earlyRestore.payload)}`);
    }
    releaseRestoreBarrier();
    const restore = await restoreRequest;
    t.diagnostic(`Restore response: ${restore.response.status} ${JSON.stringify(restore.payload)}`);
    await restartTriggered;
    await restartPromise;
    assert.equal(restore.response.status, 202, JSON.stringify(restore.payload));

    const targetDbAfter = new Database(target.databasePath, { readonly: true });
    try {
      assert.deepEqual(
        targetDbAfter.prepare('SELECT id, code, currency FROM tenants').get(),
        sourceTenant,
        'restore must replace target identity with the complete source company identity',
      );
      assert.equal(
        targetDbAfter.prepare('SELECT id FROM categories WHERE code = ?').get('TARGET_ONLY'),
        undefined,
        'target operational data must be replaced rather than merged',
      );
      assert.equal(
        targetDbAfter.prepare('SELECT activation_token FROM system_licensing WHERE id = 1').pluck().get(),
        targetLicenseTokenBefore,
        'the target installation keeps its machine-bound license/watermark row',
      );
    } finally {
      targetDbAfter.close();
    }
    const licenseAfterRestore = await api(target.url, '/api/license/status');
    assert.equal(licenseAfterRestore.payload.status, 'ACTIVE', JSON.stringify(licenseAfterRestore.payload));

    const restoredLogin = await api(target.url, '/api/login', {
      method: 'POST', body: { username: ownerUsername, password: ownerPassword },
    });
    assert.equal(restoredLogin.response.status, 200, JSON.stringify(restoredLogin.payload));
    const restoredCookie = restoredLogin.response.headers.get('set-cookie').split(';')[0];
    const invoiceAfter = await api(target.url, `/api/sales/${checkout.payload.id}`, { cookie: restoredCookie });
    const dataAfter = await api(target.url, `/api/data?storeId=${storeId}`, { cookie: restoredCookie });
    const tbAfter = await api(target.url, `/api/reports/trial-balance?storeId=${storeId}`, { cookie: restoredCookie });
    assert.equal(invoiceAfter.response.status, 200);
    assert.equal(dataAfter.response.status, 200);
    assert.equal(tbAfter.response.status, 200);
    const productAfter = dataAfter.payload.products.find((p) => p.id === product.payload.id);
    const cashAfter = tbAfter.payload.accounts.find((account) => account.accountCode === '1010');
    const afterSnapshot = {
      invoice: invoiceAfter.payload.payload,
      inventory: productAfter.variants.map(({ sku, quantity, wac }) => ({ sku, quantity, wac: wac?.amount ?? null })).sort((a, b) => a.sku.localeCompare(b.sku)),
      account1010: cashAfter,
      trialBalance: tbAfter.payload.totals,
      database: databaseInvariants(target.databasePath),
    };
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(tbAfter.payload.totals.isBalanced, true);
    t.diagnostic('Synthetic purchase/sale receipt, stock, cash, GL and Trial Balance match after encrypted cross-device restore.');
  } finally {
    releaseRestoreBarrier?.();
    releaseScheduledTask?.();
    releaseInFlightData?.();
    await restartPromise?.catch(() => undefined);
    await target?.shutdown().catch(() => undefined);
    await source?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test('actual server process startup recovers a failed restore and retains synthetic financial data', async (t) => {
  const originalEnv = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'retailos-c3-process-recovery-'));
  const sourceDir = join(root, 'source-device');
  const targetDir = join(root, 'target-device');
  const sourcePort = await reservePort();
  const targetPort = await reservePort();
  let source = null;
  let targetApp = null;
  let failingHarness = null;
  let recoveredHarness = null;
  const cleanupErrors = [];
  let testFailure = null;
  try {
    source = await startApp(sourceDir, sourcePort);
    const sourceCookie = await activateAndSetup(source);
    const initialData = await api(source.url, '/api/data', { cookie: sourceCookie });
    const storeId = initialData.payload.stores[0].id;
    const product = await api(source.url, '/api/products', {
      method: 'POST', cookie: sourceCookie,
      body: {
        name: 'حقيبة استرداد عملية', sku: 'C3-PROC-BAG', hasVariants: true,
        options: [{ key: 'color', name: 'اللون', values: ['أسود', 'بني'] }, { key: 'size', name: 'المقاس', values: ['S', 'M'] }],
        variants: [
          { sku: 'C3-PROC-BLK-S', attributes: { color: 'أسود', size: 'S' }, retailPrice: '12000', reorderPoint: '0' },
          { sku: 'C3-PROC-BRN-M', attributes: { color: 'بني', size: 'M' }, retailPrice: '14000', reorderPoint: '0' },
        ],
      },
    });
    assert.equal(product.response.status, 201, JSON.stringify(product.payload));
    const supplier = await api(source.url, '/api/suppliers', { method: 'POST', cookie: sourceCookie, body: { name: 'مورد استرداد اصطناعي' } });
    assert.equal(supplier.response.status, 201, JSON.stringify(supplier.payload));
    const variantData = await api(source.url, `/api/data?storeId=${storeId}`, { cookie: sourceCookie });
    const variants = variantData.payload.products.find((item) => item.id === product.payload.id).variants;
    const blackSmall = variants.find((item) => item.sku === 'C3-PROC-BLK-S');
    const brownMedium = variants.find((item) => item.sku === 'C3-PROC-BRN-M');
    const purchase = await api(source.url, '/api/purchases', {
      method: 'POST', cookie: sourceCookie,
      body: {
        supplierId: supplier.payload.id, storeId, idempotencyKey: randomUUID(), invoiceNumber: 'C3-PROC-PUR-001',
        totalAmount: '27000', paidAmount: '27000', paymentMethod: 'BANK_TRANSFER',
        items: [
          { variantId: blackSmall.id, quantity: '3', unitCost: '5000', retailPrice: '12000' },
          { variantId: brownMedium.id, quantity: '2', unitCost: '6000', retailPrice: '14000' },
        ],
      },
    });
    assert.equal(purchase.response.status, 201, JSON.stringify(purchase.payload));
    const shift = await api(source.url, '/api/shifts/start', { method: 'POST', cookie: sourceCookie, body: { storeId, openingCash: '50000' } });
    assert.equal(shift.response.status, 201, JSON.stringify(shift.payload));
    const sale = await api(source.url, '/api/checkout', {
      method: 'POST', cookie: sourceCookie,
      body: {
        storeId, idempotencyKey: randomUUID(),
        items: [{ variantId: blackSmall.id, quantity: '1' }, { variantId: brownMedium.id, quantity: '1' }],
        payments: [{ method: 'cash', amountMinor: '20000' }, { method: 'card', amountMinor: '6000' }],
      },
    });
    assert.equal(sale.response.status, 201, JSON.stringify(sale.payload));
    const invoiceBefore = await api(source.url, `/api/sales/${sale.payload.id}`, { cookie: sourceCookie });
    const dataBefore = await api(source.url, `/api/data?storeId=${storeId}`, { cookie: sourceCookie });
    const trialBefore = await api(source.url, `/api/reports/trial-balance?storeId=${storeId}`, { cookie: sourceCookie });
    assert.equal(trialBefore.payload.totals.isBalanced, true);
    const before = {
      invoice: invoiceBefore.payload.payload,
      inventory: dataBefore.payload.products.find((item) => item.id === product.payload.id).variants
        .map(({ sku, quantity, wac }) => ({ sku, quantity, wac: wac?.amount ?? null })).sort((a, b) => a.sku.localeCompare(b.sku)),
      cash: trialBefore.payload.accounts.find((account) => account.accountCode === '1010'),
      trialBalance: trialBefore.payload.totals,
      database: databaseInvariants(source.databasePath),
    };
    assert.equal(invoiceBefore.response.status, 200);
    assert.equal(before.database.debitTotal, before.database.creditTotal);
    assert.equal(before.database.integrity, 'ok');
    assert.equal(before.database.foreignKeyViolations, 0);
    assert.equal(before.database.orphanJournalLines, 0);
    assert.equal(before.database.inventoryMismatches, 0);
    assert.equal(before.database.duplicateSaleNumbers, 0);
    assert.equal(before.database.duplicateSaleIdempotencyKeys, 0);
    const backup = await api(source.url, '/api/backups/export', {
      method: 'POST', cookie: sourceCookie, body: { passphrase: backupPassphrase },
    });
    assert.equal(backup.response.status, 200);
    await source.shutdown();
    source = null;

    // Clone the synthetic source store to create a same-company target with a valid pre-restore ledger.
    // The target then gets one additional sale, so rollback must preserve data distinct from the candidate.
    await mkdir(targetDir, { recursive: true });
    await copyFile(join(sourceDir, 'retailos.sqlite'), join(targetDir, 'retailos.sqlite'));
    targetApp = await startApp(targetDir, targetPort);
    const targetLogin = await api(targetApp.url, '/api/login', {
      method: 'POST', body: { username: ownerUsername, password: ownerPassword },
    });
    assert.equal(targetLogin.response.status, 200, JSON.stringify(targetLogin.payload));
    const targetCookie = targetLogin.response.headers.get('set-cookie').split(';')[0];
    const extraSale = await api(targetApp.url, '/api/checkout', {
      method: 'POST', cookie: targetCookie,
      body: {
        storeId, idempotencyKey: randomUUID(),
        items: [{ variantId: brownMedium.id, quantity: '1' }],
        payments: [{ method: 'cash', amountMinor: '14000' }],
      },
    });
    assert.equal(extraSale.response.status, 201, JSON.stringify(extraSale.payload));
    const originalInvoice = await api(targetApp.url, `/api/sales/${extraSale.payload.id}`, { cookie: targetCookie });
    const originalData = await api(targetApp.url, `/api/data?storeId=${storeId}`, { cookie: targetCookie });
    const originalTrial = await api(targetApp.url, `/api/reports/trial-balance?storeId=${storeId}`, { cookie: targetCookie });
    assert.equal(originalTrial.payload.totals.isBalanced, true);
    const originalState = {
      invoice: originalInvoice.payload.payload,
      inventory: originalData.payload.products.find((item) => item.id === product.payload.id).variants
        .map(({ sku, quantity, wac }) => ({ sku, quantity, wac: wac?.amount ?? null })).sort((a, b) => a.sku.localeCompare(b.sku)),
      cash: originalTrial.payload.accounts.find((account) => account.accountCode === '1010'),
      trialBalance: originalTrial.payload.totals,
      database: databaseInvariants(join(targetDir, 'retailos.sqlite')),
    };
    assert.equal(originalState.database.debitTotal, originalState.database.creditTotal);
    await targetApp.shutdown();
    targetApp = null;

    failingHarness = spawnRestoreHarness(targetDir, targetPort, true);
    const failingUrl = `http://127.0.0.1:${targetPort}`;
    await waitForChildOutput(failingHarness.child, failingHarness.readOutput, 'RESTORE_HARNESS_READY');
    // The failure harness gets its session from the persisted database after restart via login.
    const failingLogin = await api(failingUrl, '/api/login', {
      method: 'POST', body: { username: ownerUsername, password: ownerPassword },
    });
    assert.equal(failingLogin.response.status, 200, JSON.stringify(failingLogin.payload));
    const restoreCookie = failingLogin.response.headers.get('set-cookie').split(';')[0];
    let failedRestore;
    try {
      failedRestore = await api(failingUrl, '/api/backups/restore', {
        method: 'POST', cookie: restoreCookie, body: backup.payload,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Backup-Passphrase': Buffer.from(backupPassphrase, 'utf8').toString('base64url'),
          'X-RetailOS-Restore-Confirm': 'replace',
        },
      });
    } catch (error) {
      throw new Error(`Restore request could not reach child server: ${failingHarness.readOutput()}`, { cause: error });
    }
    assert.equal(failedRestore.response.status, 500, JSON.stringify(failedRestore.payload));
    assert.equal(failedRestore.payload.restored, undefined, 'failed installation must never be reported as a successful restore');
    await waitForChildOutput(failingHarness.child, failingHarness.readOutput, 'INJECTED_CANDIDATE_INSTALL_FAILURE');
    await waitForChildOutput(failingHarness.child, failingHarness.readOutput, 'INJECTED_ROLLBACK_INSTALL_FAILURE');
    await waitForChildOutput(failingHarness.child, failingHarness.readOutput, 'RESTORE_RESPONSE_FINISHED');
    const markerPath = join(targetDir, '.retailos-restore.json');
    const marker = JSON.parse(await (await import('node:fs/promises')).readFile(markerPath, 'utf8'));
    assert.equal(marker.stage, 'OLD_MOVED');
    assert.ok(marker.previousPath);
    assert.ok(await (await import('node:fs/promises')).stat(marker.previousPath).then(() => true, () => false));
    assert.ok(await (await import('node:fs/promises')).stat(marker.rollbackPath).then(() => true, () => false));
    assert.equal(await (await import('node:fs/promises')).stat(join(targetDir, 'retailos.sqlite')).then(() => true, () => false), false,
      'an incomplete restore must not expose a partial active database before startup recovery');
    await stopRestoreHarness(failingHarness.child);
    failingHarness = null;

    recoveredHarness = spawnRestoreHarness(targetDir, targetPort, false);
    await waitForChildOutput(recoveredHarness.child, recoveredHarness.readOutput, 'RESTORE_HARNESS_READY');
    assert.equal(await (await import('node:fs/promises')).stat(markerPath).then(() => true, () => false), false,
      'actual server startup must consume and clean the pending recovery marker');
    let recoveredCookieResponse;
    try {
      recoveredCookieResponse = await api(failingUrl, '/api/login', {
        method: 'POST', body: { username: ownerUsername, password: ownerPassword },
      });
    } catch (error) {
      throw new Error(`Recovered server stopped accepting requests: ${recoveredHarness.readOutput()}`, { cause: error });
    }
    assert.equal(recoveredCookieResponse.response.status, 200, `Recovered login failed; child output: ${recoveredHarness.readOutput()}; response: ${JSON.stringify(recoveredCookieResponse.payload)}`);
    const recoveredCookie = recoveredCookieResponse.response.headers.get('set-cookie').split(';')[0];
    const invoiceAfter = await api(failingUrl, `/api/sales/${extraSale.payload.id}`, { cookie: recoveredCookie });
    const dataAfter = await api(failingUrl, `/api/data?storeId=${storeId}`, { cookie: recoveredCookie });
    const trialAfter = await api(failingUrl, `/api/reports/trial-balance?storeId=${storeId}`, { cookie: recoveredCookie });
    assert.equal(invoiceAfter.response.status, 200, JSON.stringify(invoiceAfter.payload));
    assert.equal(invoiceAfter.payload.payload.items.length, originalState.invoice.items.length);
    assert.equal(trialAfter.payload.totals.isBalanced, true);
    const after = {
      invoice: invoiceAfter.payload.payload,
      inventory: dataAfter.payload.products.find((item) => item.id === product.payload.id).variants
        .map(({ sku, quantity, wac }) => ({ sku, quantity, wac: wac?.amount ?? null })).sort((a, b) => a.sku.localeCompare(b.sku)),
      cash: trialAfter.payload.accounts.find((account) => account.accountCode === '1010'),
      trialBalance: trialAfter.payload.totals,
      database: databaseInvariants(join(targetDir, 'retailos.sqlite')),
    };
    assert.deepEqual(after, originalState);
    assert.equal(after.database.debitTotal, after.database.creditTotal);
    assert.equal(after.database.integrity, 'ok');
    assert.equal(after.database.foreignKeyViolations, 0);
    assert.equal(after.database.orphanJournalLines, 0);
    assert.equal(after.database.inventoryMismatches, 0);
    assert.equal(after.database.duplicateSaleNumbers, 0);
    assert.equal(after.database.duplicateSaleIdempotencyKeys, 0);
    t.diagnostic('A real child server recovered the original database after failed install and failed rollback; invoice, inventory, cash, journals, and Trial Balance match.');
  } catch (error) {
    testFailure = error;
  } finally {
    let allDatabaseOwnersStopped = true;
    for (const harness of [failingHarness, recoveredHarness]) {
      if (!harness) continue;
      try {
        await stopRestoreHarness(harness.child);
      } catch (error) {
        cleanupErrors.push(error);
        if (harness.child.exitCode === null && harness.child.signalCode === null) {
          allDatabaseOwnersStopped = false;
        }
      }
    }
    for (const app of [targetApp, source]) {
      if (!app) continue;
      try {
        await app.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
        allDatabaseOwnersStopped = false;
      }
    }
    if (allDatabaseOwnersStopped) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      cleanupErrors.push(new Error(`Temporary restore test data was preserved because a database owner may still be running: ${root}`));
    }
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  if (testFailure && cleanupErrors.length > 0) {
    throw new AggregateError([testFailure, ...cleanupErrors], 'Restore integration test failed and cleanup also failed');
  }
  if (testFailure) throw testFailure;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Restore integration test cleanup failed');
});
