import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { isPreviewResetConfiguration, resetDevelopmentOperationalData } from '../dev-data-reset.mjs';
import { createServerApp } from '../server.mjs';
import { cleanupTempDir, createTestTempDir } from './e2e-server-harness.mjs';

const infrastructureRequire = createRequire(new URL('../../../packages/infrastructure/package.json', import.meta.url));
const Database = infrastructureRequire('better-sqlite3');

test('Beta reset is enabled only for a packaged preview runtime with an isolated data directory', () => {
  const base = {
    previewMarkerExists: true,
    dataDir: 'C:/RetailOS-Beta/test-data',
    databasePath: 'C:/RetailOS-Beta/test-data/retailos.sqlite',
    electronRuntime: true,
  };

  assert.equal(isPreviewResetConfiguration(base), true);
  assert.equal(isPreviewResetConfiguration({ ...base, previewMarkerExists: false }), false);
  assert.equal(isPreviewResetConfiguration({ ...base, electronRuntime: false }), false);
  assert.equal(isPreviewResetConfiguration({ ...base, databasePath: 'C:/RetailOS/retailos.sqlite' }), false);
  assert.equal(isPreviewResetConfiguration({ ...base, dataDir: 'relative/test-data' }), false);
});

test('reset clears operational rows, preserves owner/license/audit data, and restores append-only triggers', () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE stores (id TEXT PRIMARY KEY);
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE accounts (id TEXT PRIMARY KEY);
      CREATE TABLE system_licensing (id TEXT PRIMARY KEY);
      CREATE TABLE audit_logs (id TEXT PRIMARY KEY);
      CREATE TABLE products (id TEXT PRIMARY KEY);
      CREATE TABLE sales (id TEXT PRIMARY KEY);
      CREATE TABLE expense_categories (id TEXT PRIMARY KEY);
      CREATE TABLE sale_items (id TEXT PRIMARY KEY);
      CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
        BEGIN SELECT RAISE(ABORT, 'sales are append-only'); END;
    `);
    for (const table of ['tenants', 'stores', 'users', 'sessions', 'accounts', 'system_licensing', 'audit_logs', 'products', 'sales', 'expense_categories', 'sale_items']) {
      database.prepare(`INSERT INTO "${table}" (id) VALUES (?)`).run(`${table}-row`);
    }

    const result = resetDevelopmentOperationalData(database);

    assert.equal(result.deleted.products, 1);
    assert.equal(result.deleted.sales, 1);
    assert.equal(result.deleted.sale_items, 1);
    assert.equal(result.deleted.expense_categories, 1);
    for (const table of ['tenants', 'stores', 'users', 'sessions', 'accounts', 'system_licensing', 'audit_logs']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 1);
    }
    assert.match(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sales_no_delete'").get().sql, /append-only/);
    database.prepare('INSERT INTO sales (id) VALUES (?)').run('sales-trigger-check');
    assert.throws(() => database.prepare('DELETE FROM sales').run(), /append-only/);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

test('reset rolls back rows and trigger changes if foreign keys prevent completion', () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE sales (id TEXT PRIMARY KEY);
      CREATE TABLE external_reference (sale_id TEXT NOT NULL REFERENCES sales(id));
      CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
        BEGIN SELECT RAISE(ABORT, 'sales are append-only'); END;
      INSERT INTO sales VALUES ('sale-1');
      INSERT INTO external_reference VALUES ('sale-1');
    `);

    assert.throws(() => resetDevelopmentOperationalData(database), /FOREIGN KEY constraint failed/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM external_reference').get().count, 1);
    assert.match(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sales_no_delete'").get().sql, /append-only/);
  } finally {
    database.close();
  }
});

test('7-day zero-login Beta mode auto-authenticates, supports reset, and expires after 7 days', async () => {
  const dataDir = await createTestTempDir('retailos-beta-7d-');
  const issuedMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const expiresMs = issuedMs + 7 * 24 * 60 * 60 * 1000;
  let currentNowMs = issuedMs + 60 * 1000;

  const freePort = await new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const chosen = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePort(chosen));
    });
  });

  process.env.NODE_ENV = 'test';
  process.env.PORT = String(freePort);
  process.env.RETAILOS_DATA_DIR = dataDir;
  process.env.RETAILOS_DB_PATH = join(dataDir, 'retailos.sqlite');
  process.env.RETAILOS_COMPANY_NAME = 'نسخة Beta التجريبية';
  process.env.RETAILOS_COMPANY_CODE = 'BETA7D';
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
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
    },
  });

  try {
    const baseUrl = app.origin;
    const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };

    // 1. Within 7 days: license is ACTIVE without any token
    const licRes = await fetch(`${baseUrl}/api/license/status`);
    assert.equal(licRes.status, 200);
    const licBody = await licRes.json();
    assert.equal(licBody.status, 'ACTIVE');
    assert.equal(licBody.daysRemaining, 7);

    // 2. Bootstrap auto-creates Beta owner (setupRequired = false)
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(bootRes.status, 200);
    const bootBody = await bootRes.json();
    assert.equal(bootBody.setupRequired, false);

    // 3. /api/data works with ZERO login cookie and exposes developmentResetAvailable = true
    const dataRes = await fetch(`${baseUrl}/api/data`);
    assert.equal(dataRes.status, 200);
    const dataBody = await dataRes.json();
    assert.equal(dataBody.betaPreviewMode, true);
    assert.equal(dataBody.developmentResetAvailable, true);
    assert.equal(dataBody.user.role, 'OWNER');

    // 4. Can create category, purchase stock, open shift, complete POS checkout, & reset with zero login/license
    const catRes = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'فئة تجريبية' }),
    });
    assert.equal(catRes.status, 201);
    const catBody = await catRes.json();

    const supRes = await fetch(`${baseUrl}/api/suppliers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'مورد البيتا' }),
    });
    assert.equal(supRes.status, 201);
    const supBody = await supRes.json();

    const storeId = dataBody.selectedStoreId;
    const purchRes = await fetch(`${baseUrl}/api/purchases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        supplierId: supBody.id,
        storeId,
        idempotencyKey: randomUUID(),
        invoiceNumber: 'INV-BETA-001',
        totalAmount: '10000',
        paidAmount: '10000',
        paymentMethod: 'CASH',
        items: [],
        newProducts: [{
          name: 'تيشيرت بيتا',
          sku: 'BETA-TSHIRT-1',
          categoryId: catBody.id,
          options: [{ key: 'option_1', name: 'اللون', values: ['أسود'] }],
          variants: [{ sku: 'BETA-TSHIRT-1-BLK', attributes: { option_1: 'أسود' }, quantity: '5', unitCost: '2000', retailPrice: '5000', reorderPoint: '1' }],
        }],
      }),
    });
    assert.equal(purchRes.status, 201);

    const refreshedData = await (await fetch(`${baseUrl}/api/data`)).json();
    const variantId = refreshedData.products[0]?.variants[0]?.id;
    assert.ok(variantId, 'Expected newly purchased variant for Beta checkout');

    const shiftRes = await fetch(`${baseUrl}/api/shifts/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ storeId, openingCash: '0' }),
    });
    assert.equal(shiftRes.status, 201);

    const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        storeId,
        idempotencyKey: randomUUID(),
        items: [{ variantId, quantity: '1' }],
        paymentMethod: 'CASH',
        amountPaidMinor: '5000',
      }),
    });
    assert.equal(checkoutRes.status, 201, 'Beta checkout must succeed without a license activation token');

    const resetRes = await fetch(`${baseUrl}/api/dev/reset-operational-data`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmation: 'مسح جميع البيانات' }),
    });
    assert.equal(resetRes.status, 200);

    // 5. After 7 days: status becomes EXPIRED and access is blocked (401/402)
    currentNowMs = expiresMs + 60 * 1000;
    const expiredLicRes = await fetch(`${baseUrl}/api/license/status`);
    const expiredLic = await expiredLicRes.json();
    assert.equal(expiredLic.status, 'EXPIRED');
    assert.equal(expiredLic.daysRemaining, 0);

    const blockedRes = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'فئة بعد الانتهاء' }),
    });
    assert.ok(blockedRes.status === 401 || blockedRes.status === 402, `Expected 401/402 after expiry, got ${blockedRes.status}`);
  } finally {
    await app.shutdown();
    await cleanupTempDir(dataDir);
  }
});
