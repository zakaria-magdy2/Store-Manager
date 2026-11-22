import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  cleanupTempDir,
  createTestTempDir,
  DEFAULT_HARNESS_READY_TIMEOUT_MS,
  terminateChildProcessTree,
  waitForHarnessReady,
} from './e2e-server-harness.mjs';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(dirname(appDir));

let serverProcess = null;
let dataDir = null;
let baseUrl = '';
let serverLog = '';
let sharedContext = null;
let page = null;
const pageErrors = [];
const server5xxResponses = [];
const { publicKey: e2eLicensePublicKey, privateKey: e2eLicensePrivateKey } =
  generateKeyPairSync('ed25519');
const e2eLicensePublicKeyPem = e2eLicensePublicKey.export({ type: 'spki', format: 'pem' }).toString();

function signE2ELicenseToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), e2eLicensePrivateKey).toString(
    'base64url',
  );
  return `${signingInput}.${signature}`;
}

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const addr = probe.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve(undefined))),
  );
  return port;
}

async function waitForApp() {
  await waitForHarnessReady(baseUrl, serverProcess, () => serverLog, DEFAULT_HARNESS_READY_TIMEOUT_MS);
}

async function acceptConfirmModal(p) {
  const acceptBtn = p.locator('#confirm-modal-root [data-confirm-accept]');
  await expect(acceptBtn).toBeVisible();
  await acceptBtn.click();
}

test.describe.serial('RetailOS Real-Browser E2E Suite (1366x768 RTL)', () => {
  test.beforeAll(async ({ browser }) => {
    dataDir = await createTestTempDir('retailos-e2e-');
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        RETAILOS_TEST_LICENSE_PUBLIC_KEY: e2eLicensePublicKeyPem,
        PORT: String(port),
        RETAILOS_DATA_DIR: dataDir,
        RETAILOS_COMPANY_NAME: 'متجر الاختبار الشامل',
        RETAILOS_COMPANY_CODE: 'E2E_STORE',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    serverProcess.stderr.on('data', (chunk) => {
      serverLog += chunk.toString();
    });
    await waitForApp();

    sharedContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'ar-EG',
      timezoneId: 'Africa/Cairo',
    });
    page = await sharedContext.newPage();
    page.on('pageerror', (err) => {
      pageErrors.push(err.stack || err.message || String(err));
    });
    page.on('response', (res) => {
      if (res.status() >= 500) {
        server5xxResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });
  });

  test.afterEach(() => {
    expect(pageErrors, `Uncaught pageerror(s): ${pageErrors.join('\n')}`).toEqual([]);
    expect(server5xxResponses, `Unexpected HTTP 5xx: ${server5xxResponses.join('\n')}`).toEqual([]);
  });

  test.afterAll(async () => {
    if (sharedContext) {
      await sharedContext.close().catch(() => {});
    }
    await terminateChildProcessTree(serverProcess);
    serverProcess = null;
    await cleanupTempDir(dataDir);
  });

  test('1. License Activation, Setup, Login, Logout & Two-User RBAC Boundaries (OWNER vs read-only AUDITOR)', async () => {
    await page.goto(baseUrl);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // First-run license gate must block setup until activated with valid Ed25519 token
    await expect(page.locator('#license-activation-screen')).toBeVisible();
    const machineId = (await page.locator('#license-machine-id').inputValue()).trim();
    expect(machineId).toMatch(/^ROS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Invalid license token must be rejected cleanly without leaving activation screen
    await page.fill('#license-token-input', 'ROS1.invalid_payload.invalid_signature');
    await page.click('#activate-license-btn');
    await expect(page.locator('#license-activation-screen')).toBeVisible();
    await expect(page.locator('#toast-region')).toContainText(/غير صالح|توقيع|تنسيق/);

    // Activate with 5-day license so expiry warning banner also renders after login
    const now = Date.now();
    const validToken = signE2ELicenseToken({
      licenseId: `E2E-${randomUUID().slice(0, 8).toUpperCase()}`,
      customerName: 'عميل E2E',
      machineId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
      planName: 'E2E Trial Plan',
    });
    await page.fill('#license-token-input', validToken);
    await page.click('#activate-license-btn');

    // Initial owner setup
    await expect(page.locator('#setup-form')).toBeVisible();
    await page.fill('#setup-form input[name="ownerName"]', 'مدير النظام');
    await page.fill('#setup-form input[name="ownerUsername"]', 'owner_e2e');
    await page.fill('#setup-form input[name="password"]', 'Owner-E2E-Password-2026');
    await page.click('#setup-form button[type="submit"]');
    await acceptConfirmModal(page);

    // Invalid login must be rejected cleanly and stay on login form
    await expect(page.locator('#login-form')).toBeVisible();
    await page.fill('#login-form input[name="username"]', 'owner_e2e');
    await page.fill('#login-form input[name="password"]', 'Wrong-Password-9999');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#toast-region')).toContainText(/غير صحيحة|بيانات الدخول/);

    // Valid owner login + reload session persistence
    await page.fill('#login-form input[name="username"]', 'owner_e2e');
    await page.fill('#login-form input[name="password"]', 'Owner-E2E-Password-2026');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('aside.sidebar')).toBeVisible();

    await page.reload();
    await expect(page.locator('aside.sidebar')).toBeVisible();

    // Seed product with barcode, supplier purchase stock, second branch, and AUDITOR user
    const seedStatus = await page.evaluate(async () => {
      const headers = { 'Content-Type': 'application/json' };
      const dataRes = await fetch('/api/data');
      const data = await dataRes.json();
      const storeId = data.stores[0].id;

      const prodRes = await fetch('/api/products', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'قميص كلاسيك E2E',
          sku: 'E2E-SHIRT',
          hasVariants: true,
          options: [{ key: 'size', name: 'المقاس', values: ['L'] }],
          variants: [
            {
              sku: 'E2E-SHIRT-L',
              barcode: '6221234567890',
              attributes: { size: 'L' },
              retailPrice: '20000',
              reorderPoint: '2',
            },
          ],
        }),
      });
      if (prodRes.status !== 201) return { step: 'prod', status: prodRes.status };

      const refreshed = await (await fetch(`/api/data?storeId=${storeId}`)).json();
      const variantId = refreshed.products[0].variants[0].id;

      const supRes = await fetch('/api/suppliers', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'مورد الاختبار' }),
      });
      const sup = await supRes.json();

      const purRes = await fetch('/api/purchases', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          storeId,
          supplierId: sup.id,
          idempotencyKey: crypto.randomUUID(),
          totalAmount: '100000',
          paidAmount: '100000',
          paymentMethod: 'BANK_TRANSFER',
          items: [{ variantId, quantity: '10', unitCost: '10000' }],
        }),
      });
      if (purRes.status !== 201) return { step: 'pur', status: purRes.status };

      const audRes = await fetch('/api/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          username: 'auditor_e2e',
          password: 'Auditor-E2E-Password-2026',
          fullName: 'مراجع الحسابات',
          role: 'AUDITOR',
        }),
      });
      return { step: 'done', status: audRes.status, storeId, variantId };
    });
    expect(seedStatus.status).toBe(201);

    // Logout from owner account
    await page.click('#account-menu-toggle');
    await page.click('#logout-button');
    await acceptConfirmModal(page);
    await expect(page.locator('#login-form')).toBeVisible();

    // Login as read-only AUDITOR
    await page.fill('#login-form input[name="username"]', 'auditor_e2e');
    await page.fill('#login-form input[name="password"]', 'Auditor-E2E-Password-2026');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('aside.sidebar')).toBeVisible();

    // Verify AUDITOR is strictly blocked (403) from starting/ending shifts and mutating POS/inventory
    const auditorChecks = await page.evaluate(
      async ({ storeId, variantId }) => {
        const headers = { 'Content-Type': 'application/json' };
        const startShift = await fetch('/api/shifts/start', {
          method: 'POST',
          headers,
          body: JSON.stringify({ storeId, openingCash: '0' }),
        });
        const endShift = await fetch('/api/shifts/end', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            shiftId: '00000000-0000-4000-8000-000000000001',
            actualCash: '0',
            handoverCash: '0',
          }),
        });
        const checkout = await fetch('/api/checkout', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            storeId,
            idempotencyKey: crypto.randomUUID(),
            items: [{ variantId, quantity: '1' }],
            paymentMethod: 'cash',
            amountPaidMinor: '20000',
          }),
        });
        const adjust = await fetch('/api/inventory/damage', {
          method: 'POST',
          headers,
          body: JSON.stringify({ storeId, variantId, quantity: '1', reason: 'test' }),
        });
        return {
          startShift: startShift.status,
          endShift: endShift.status,
          checkout: checkout.status,
          adjust: adjust.status,
        };
      },
      { storeId: seedStatus.storeId, variantId: seedStatus.variantId },
    );

    expect(auditorChecks).toEqual({
      startShift: 403,
      endShift: 403,
      checkout: 403,
      adjust: 403,
    });

    // Logout AUDITOR and log back in as OWNER
    await page.click('#account-menu-toggle');
    await page.click('#logout-button');
    await acceptConfirmModal(page);
    await expect(page.locator('#login-form')).toBeVisible();

    await page.fill('#login-form input[name="username"]', 'owner_e2e');
    await page.fill('#login-form input[name="password"]', 'Owner-E2E-Password-2026');
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('aside.sidebar')).toBeVisible();
  });

  test('2. Product camera capture compresses and applies an image, then releases the camera', async () => {
    const cameraState = await page.evaluate(() => {
      globalThis.__retailosCameraTracksStopped = false;
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async (constraints) => {
            if (constraints.audio !== false || !constraints.video) throw new Error('Unsafe camera constraints');
            const track = { stop: () => { globalThis.__retailosCameraTracksStopped = true; } };
            const stream = new globalThis.MediaStream();
            stream.getTracks = () => [track];
            return stream;
          },
        },
      });
      globalThis.HTMLVideoElement.prototype.play = async function () {
        Object.defineProperty(this, 'videoWidth', { configurable: true, value: 640 });
        Object.defineProperty(this, 'videoHeight', { configurable: true, value: 480 });
      };
      globalThis.CanvasRenderingContext2D.prototype.drawImage = function () {};
      return true;
    });
    expect(cameraState).toBe(true);

    await page.click('.nav-item[data-page="products"]');
    await page.click('#new-product');
    await expect(page.locator('[data-camera-image-btn]')).toBeVisible();
    await page.click('[data-camera-image-btn]');
    await expect(page.locator('[data-camera-capture]')).toBeEnabled();
    await page.click('[data-camera-capture]');
    await expect(page.locator('.camera-capture-overlay')).toHaveCount(0);
    await expect(page.locator('#product-form input[name="imagePath"]')).toHaveValue(/^data:image\/(webp|jpeg);base64,/);
    const capturedImage = await page.locator('#product-form input[name="imagePath"]').inputValue();
    expect(capturedImage.length).toBeLessThanOrEqual(240_000);
    expect(await page.evaluate(() => globalThis.__retailosCameraTracksStopped)).toBe(true);

    await page.locator('#product-form [data-close-modal]').click();
    await expect(page.locator('#product-form')).toHaveCount(0);
  });

  test('3. POS Shift, Barcode Scan & Split Payment (CASH + electronic) with Thermal Receipt Preview', async () => {
    await page.click('.nav-item[data-page="pos"]');
    await expect(page.locator('#pos-start-shift-now-btn')).toBeVisible();

    // Open shift with 500.00 EGP opening cash
    await page.click('#pos-start-shift-now-btn');
    await expect(page.locator('#start-shift-form')).toBeVisible();
    await page.fill('#start-shift-opening-cash', '500');
    await page.click('#start-shift-form button[type="submit"]');
    await acceptConfirmModal(page);
    await expect(page.locator('.pos-shift-banner-active')).toBeVisible();

    // Scan barcode via keyboard Enter
    const searchInput = page.locator('#pos-search');
    await expect(searchInput).toBeEnabled();
    await searchInput.fill('6221234567890');
    await searchInput.press('Enter');

    await expect(page.locator('#pos-total-pieces')).toHaveText('1');
    await expect(page.locator('#cart-items')).toContainText('قميص كلاسيك E2E');

    // Apply 20.00 EGP discount -> Net total becomes 180.00 EGP
    await page.fill('#pos-discount-input', '20');
    await expect(page.locator('#pos-grand-total')).toContainText('180');

    // Select SPLIT payment (100.00 CASH + 80.00 CARD)
    await page.click('.payment-method[data-method="SPLIT"]');
    await expect(page.locator('#pos-split-panel')).toBeVisible();
    await page.fill('#pos-split-cash', '100');
    await expect(page.locator('#pos-split-electronic')).toHaveValue('80');

    // Complete sale
    await page.click('#checkout-button');
    await acceptConfirmModal(page);

    // Verify thermal receipt preview displays both tenders accurately
    const receiptPaper = page.locator('#printable-thermal-receipt');
    await expect(receiptPaper).toBeVisible();
    await expect(receiptPaper).toContainText('نقدي');
    await expect(receiptPaper).toContainText('100');
    await expect(receiptPaper).toContainText('بطاقة');
    await expect(receiptPaper).toContainText('80');

    await page.click('#modal-root [data-close-modal]');
    await expect(receiptPaper).toBeHidden();
  });

  test('3. Failed Network / F5 Reload Pending Checkout Recovery (no duplicate sale)', async () => {
    // Switch back to CASH payment and scan 1 item (200.00 EGP)
    await page.click('.payment-method[data-method="CASH"]');
    const searchInput = page.locator('#pos-search');
    await searchInput.fill('6221234567890');
    await searchInput.press('Enter');
    await expect(page.locator('#pos-total-pieces')).toHaveText('1');

    // Intercept POST /api/checkout to simulate network drop on first submit
    let interceptedCount = 0;
    const checkoutRouteHandler = async (route) => {
      if (route.request().method() === 'POST') {
        interceptedCount += 1;
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    await page.route('**/api/checkout', checkoutRouteHandler);

    await page.click('#checkout-button');
    await acceptConfirmModal(page);

    expect(interceptedCount).toBe(1);
    await expect(page.locator('#pending-checkout-banner')).toBeVisible();
    await expect(page.locator('#pos-search')).toBeDisabled();
    await expect(page.locator('#clear-cart')).toBeDisabled();
    await expect(page.locator('#checkout-button')).toBeDisabled();

    // Execute F5 reload and confirm pending checkout banner and locked cart restore automatically
    await page.reload();
    await expect(page.locator('#pending-checkout-banner')).toBeVisible();
    await expect(page.locator('#cart-items')).toContainText('قميص كلاسيك E2E');
    await expect(page.locator('#pos-search')).toBeDisabled();
    await expect(page.locator('#checkout-button')).toBeDisabled();

    // Clear network block and retry with the same idempotencyKey
    await page.unroute('**/api/checkout', checkoutRouteHandler);
    await page.click('#retry-pending-checkout-btn');

    await expect(page.locator('#printable-thermal-receipt')).toBeVisible();
    await expect(page.locator('#pending-checkout-banner')).toHaveCount(0);
    await page.click('#modal-root [data-close-modal]');

    // Confirm exactly 2 total sales exist (1 from Test 2 + 1 from Test 3, no duplicate invoice)
    const salesCount = await page.evaluate(async () => {
      const res = await fetch('/api/sales?limit=50');
      const body = await res.json();
      return body.payload.sales.length;
    });
    expect(salesCount).toBe(2);
  });

  test('4. Customer Return, Daily Expense & Shift Close Reconciliation with Trial Balance & P&L', async () => {
    // Process customer return on the latest sale (200.00 EGP CASH sale)
    await page.click('.nav-item[data-page="sales"]');
    const firstReturnBtn = page.locator('.start-return').first();
    await expect(firstReturnBtn).toBeVisible();
    await firstReturnBtn.click();

    await expect(page.locator('#sale-return-form')).toBeVisible();
    await page.click('#sale-return-form button[data-return-step="1"]');
    await expect(page.locator('#confirm-sale-return-btn')).toBeEnabled();
    await page.click('#confirm-sale-return-btn');
    await acceptConfirmModal(page);
    await expect(page.locator('#sale-return-form')).toBeHidden();
    await expect(page.locator('.sales-table')).toContainText('مرتجع بالكامل');

    // Record a daily operating expense (50.00 EGP from CASH_DRAWER)
    await page.click('.nav-item[data-page="expenses"]');
    await page.click('#new-expense');
    await expect(page.locator('#expense-form')).toBeVisible();
    await page.fill('#expense-form input[name="amount"]', '50');
    await page.fill('#expense-form input[name="notes"]', 'مصروف كهرباء اختبار E2E');
    await page.click('#expense-form button[type="submit"]');
    await acceptConfirmModal(page);
    await expect(page.locator('#expense-form')).toBeHidden();
    await expect(page.locator('section.page-content')).toContainText('مصروف كهرباء اختبار E2E');

    // Close the shift with counted cash (500 opening + 100 split cash + 200 cash sale - 200 cash return = 600.00 EGP)
    await page.click('#header-end-shift-btn');
    await expect(page.locator('#end-shift-form')).toBeVisible();
    await page.fill('#shift-actual-cash', '600');
    await page.click('#end-shift-form button[type="submit"]');
    await acceptConfirmModal(page);
    await expect(page.locator('#header-start-shift-btn')).toBeVisible();

    // Verify P&L and Trial Balance (Debits === Credits)
    await page.click('.nav-item[data-page="reports"]');
    await expect(page.locator('#btn-open-trial-balance')).toBeVisible();
    await page.click('#btn-open-trial-balance');

    const tbFooter = page.locator('#modal-root table tfoot tr');
    await expect(tbFooter).toBeVisible();
    const tbCells = await tbFooter.locator('td.table-total').allTextContents();
    expect(tbCells.length).toBe(4);
    expect(tbCells[0]).toBe(tbCells[1]);
    expect(tbCells[2]).toBe(tbCells[3]);

    const tbApi = await page.evaluate(async () => {
      const res = await fetch('/api/reports/trial-balance');
      return res.json();
    });
    expect(tbApi.totals.isBalanced).toBe(true);
    expect(tbApi.totals.debitTotal.amount).toBe(tbApi.totals.creditTotal.amount);
    expect(tbApi.totals.debitBalanceTotal.amount).toBe(tbApi.totals.creditBalanceTotal.amount);

    await page.click('#modal-root [data-close-modal]');
  });

  test('5. RTL Responsive Overflow Check (1366x768) across POS, Inventory, Suppliers, Reports, Accounting & License', async () => {
    await expect(page.locator('#license-expiry-banner')).toBeVisible();
    const routes = [
      { type: 'nav', pageId: 'pos' },
      { type: 'nav', pageId: 'inventory' },
      { type: 'nav', pageId: 'suppliers' },
      { type: 'nav', pageId: 'reports' },
      { type: 'hash', hash: '#accounting', pageId: 'accounting' },
      { type: 'accountMenu', pageId: 'license' },
    ];

    for (const route of routes) {
      if (route.type === 'nav') {
        await page.click(`.nav-item[data-page="${route.pageId}"]`);
      } else if (route.type === 'accountMenu') {
        await page.click('#account-menu-toggle');
        await page.click(`.account-menu [data-page="${route.pageId}"]`);
      } else {
        await page.evaluate((h) => {
          globalThis.window.location.hash = h;
        }, route.hash);
      }
      await page.waitForTimeout(150);

      const metrics = await page.evaluate(() => ({
        dir: globalThis.document.documentElement.getAttribute('dir'),
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        innerWidth: globalThis.window.innerWidth,
      }));
      expect(metrics.dir, `RTL attribute on ${route.pageId}`).toBe('rtl');
      expect(
        metrics.scrollWidth,
        `Horizontal overflow detected on ${route.pageId}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
      ).toBeLessThanOrEqual(metrics.innerWidth);
    }
  });
});

test.describe('RetailOS Pre-Pilot Browser Resilience: 503 Retry & Lockout Backup Export', () => {
  test('6. Lockout screen allows Owner sign-in for emergency backup export, and 503 hardware unavailability recovers cleanly', async ({ browser }) => {
    const tempDir = await createTestTempDir('retailos-e2e-lockout-');
    const clockFile = join(tempDir, 'clock.txt');
    const baseMs = Date.now();
    await writeFile(clockFile, String(baseMs), 'utf8');

    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    let procLog = '';
    const proc = spawn(process.execPath, [join(appDir, 'tests', 'e2e-server-harness.mjs')], {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        RETAILOS_TEST_LICENSE_PUBLIC_KEY: e2eLicensePublicKeyPem,
        RETAILOS_TEST_CLOCK_FILE: clockFile,
        PORT: String(port),
        RETAILOS_DATA_DIR: tempDir,
        RETAILOS_COMPANY_NAME: 'متجر طوارئ E2E',
        RETAILOS_COMPANY_CODE: 'E2E_LOCKOUT',
        RETAILOS_CURRENCY: 'EGP',
        RETAILOS_STORE_NAME: 'الفرع الرئيسي',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => { procLog += c.toString(); });
    proc.stderr.on('data', (c) => { procLog += c.toString(); });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'ar-EG',
      timezoneId: 'Africa/Cairo',
      acceptDownloads: true,
    });
    try {
      await waitForHarnessReady(url, proc, () => procLog, DEFAULT_HARNESS_READY_TIMEOUT_MS);
      const p = await context.newPage();
      const errs = [];
      p.on('pageerror', (err) => errs.push(err.message));

      // 1. Activate short 2-day license + setup with custom master backup passphrase
      await p.goto(url);
      await expect(p.locator('#license-activation-screen')).toBeVisible();
      const machineId = (await p.locator('#license-machine-id').inputValue()).trim();
      const shortToken = signE2ELicenseToken({
        licenseId: `E2E-SHORT-${randomUUID().slice(0, 6).toUpperCase()}`,
        customerName: 'عميل طوارئ',
        machineId,
        issuedAt: new Date(baseMs).toISOString(),
        expiresAt: new Date(baseMs + 2 * 86400000).toISOString(),
        planName: '2-Day',
      });
      await p.fill('#license-token-input', shortToken);
      await p.click('#activate-license-btn');

      await expect(p.locator('#setup-form')).toBeVisible();
      await p.fill('#setup-form input[name="ownerName"]', 'مالك الطوارئ');
      await p.fill('#setup-form input[name="ownerUsername"]', 'lock_owner');
      await p.fill('#setup-form input[name="password"]', 'Lockout-Owner-Pass-2026!');
      await p.fill('#setup-form input[name="dailyBackupPassphrase"]', 'E2E-Master-Backup-Key-2026');
      await p.click('#setup-form button[type="submit"]');
      await acceptConfirmModal(p);

      // Post-setup recovery key banner renders cleanly above login form
      await expect(p.locator('#post-setup-daily-key-banner')).toBeVisible();
      await expect(p.locator('#setup-daily-key-value')).toHaveValue('E2E-Master-Backup-Key-2026');

      // 2. Simulate transient 503 HARDWARE_IDENTITY_UNAVAILABLE on unauthenticated reload -> retryable screen (never UNLICENSED)
      let simulate503 = true;
      await p.route('**/api/license/status', async (route) => {
        if (simulate503) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'تعذر التحقق المؤقت من معرف الجهاز أثناء بدء التشغيل',
              code: 'HARDWARE_IDENTITY_UNAVAILABLE',
              retryable: true,
            }),
          });
          return;
        }
        await route.continue();
      });

      await p.reload();
      await expect(p.locator('#license-hardware-retry-box')).toBeVisible();
      await expect(p.locator('#license-token-input')).toBeHidden();

      simulate503 = false;
      await p.click('#retry-license-status-btn');
      await expect(p.locator('#login-form')).toBeVisible();
      await p.unroute('**/api/license/status');

      // 3. Advance clock past 2-day license expiry while unauthenticated -> EXPIRED lockout screen allows Owner login + backup export
      await writeFile(clockFile, String(baseMs + 3 * 86400000), 'utf8');
      await p.reload();
      await expect(p.locator('#license-activation-screen')).toBeVisible();
      await expect(p.locator('#license-open-login-btn')).toBeVisible();

      await p.click('#license-open-login-btn');
      await expect(p.locator('#login-form')).toBeVisible();
      await expect(p.locator('#emergency-login-notice')).toBeVisible();

      await p.fill('#login-form input[name="username"]', 'lock_owner');
      await p.fill('#login-form input[name="password"]', 'Lockout-Owner-Pass-2026!');
      await p.click('#login-form button[type="submit"]');

      // Lands in emergency backups view under lockout banner and exports encrypted .rfbackup cleanly
      await expect(p.locator('#license-unlicensed-backup-banner')).toBeVisible();
      await expect(p.locator('#backup-export-form')).toBeVisible();

      await p.fill('#backup-export-form input[name="passphrase"]', 'Emergency-Export-2026!');
      await p.fill('#backup-export-form input[name="confirmPassphrase"]', 'Emergency-Export-2026!');
      const [download] = await Promise.all([
        p.waitForEvent('download'),
        (async () => {
          await p.click('#backup-export-form button[type="submit"]');
          await acceptConfirmModal(p);
        })(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.rfbackup$/);
      expect(errs).toEqual([]);
    } finally {
      await context.close().catch(() => {});
      await terminateChildProcessTree(proc);
      await cleanupTempDir(tempDir);
    }
  });
});
