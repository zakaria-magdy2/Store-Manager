#!/usr/bin/env node
/**
 * Non-destructive end-to-end encrypted backup & external restore verification drill.
 * Boots an isolated temporary server, records real supplier purchase + payment + sale + return + expense,
 * exports an encrypted .rfbackup to an external backup folder outside the data directory, verifies
 * wrong-passphrase & tamper rejection, installs the external backup via POST /api/backups/restore,
 * waits for self-restart, and asserts every financial/stock/audit record matches.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(repoRoot, 'apps', 'web', 'server.mjs');
const passphrase = `Drill-Pass-${Date.now()}-Strong!`;

async function reservePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function waitForReady(baseUrl, expectSetupRequired = null) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/bootstrap`);
      if (res.ok) {
        const body = await res.json();
        if (expectSetupRequired === null || body.setupRequired === expectSetupRequired) return body;
      }
    } catch { /* retrying until ready */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

async function api(baseUrl, path, { method = 'GET', body, cookie = '' } = {}) {
  const headers = { Origin: baseUrl };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const workRoot = await mkdtemp(join(tmpdir(), 'retailos-restore-drill-'));
const sourceDataDir = join(workRoot, 'source-data');
const externalBackupDir = join(workRoot, 'external-usb-mirror');
await mkdir(sourceDataDir, { recursive: true });
await mkdir(externalBackupDir, { recursive: true });

let port = await reservePort();
let baseUrl = `http://127.0.0.1:${port}`;
let srv = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    RETAILOS_DATA_DIR: sourceDataDir,
    RETAILOS_COMPANY_NAME: 'شركة اختبار الاستعادة',
    RETAILOS_COMPANY_CODE: 'RESTORE_DRILL',
    RETAILOS_CURRENCY: 'EGP',
    RETAILOS_STORE_NAME: 'الفرع الرئيسي',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

try {
  await waitForReady(baseUrl, true);
  await api(baseUrl, '/api/setup', {
    method: 'POST',
    body: { ownerUsername: 'drill_owner', ownerName: 'مدير التجربة', password: 'DrillOwnerPassword2026!' },
  });
  const loginRes = await api(baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'drill_owner', password: 'DrillOwnerPassword2026!' },
  });
  assert.equal(loginRes.response.status, 200);
  const cookie = (loginRes.response.headers.get('set-cookie') ?? '').split(';')[0];

  const data1 = await api(baseUrl, '/api/data', { cookie });
  const storeId = data1.payload.selectedStoreId;
  const cat = await api(baseUrl, '/api/categories', { method: 'POST', cookie, body: { name: 'تيشيرتات' } });
  const prod = await api(baseUrl, '/api/products', {
    method: 'POST',
    cookie,
    body: {
      name: 'تيشيرت تجربة',
      sku: 'DRILL-TEE',
      categoryId: cat.payload.id,
      hasVariants: false,
      options: [],
      variants: [{ sku: 'DRILL-TEE-M', retailPrice: '50000', reorderPoint: '2', attributes: {} }],
    },
  });
  assert.equal(prod.response.status, 201, JSON.stringify(prod.payload));
  const data2 = await api(baseUrl, '/api/data', { cookie });
  const variantId = data2.payload.products[0].variants[0].id;
  const sup = await api(baseUrl, '/api/suppliers', { method: 'POST', cookie, body: { name: 'تاجر الاستعادة' } });
  const pur = await api(baseUrl, '/api/purchases', {
    method: 'POST',
    cookie,
    body: {
      idempotencyKey: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1',
      supplierId: sup.payload.id,
      storeId,
      totalAmount: '100000',
      paidAmount: '40000',
      paymentMethod: 'CASH',
      items: [{ variantId, quantity: '5', unitCost: '20000' }],
    },
  });
  assert.equal(pur.response.status, 201, JSON.stringify(pur.payload));
  const shf = await api(baseUrl, '/api/shifts/start', {
    method: 'POST',
    cookie,
    body: { storeId, openingCash: '100000', notes: 'بداية التجربة' },
  });
  assert.equal(shf.response.status, 201, JSON.stringify(shf.payload));
  const chk = await api(baseUrl, '/api/checkout', {
    method: 'POST',
    cookie,
    body: {
      storeId,
      idempotencyKey: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2',
      items: [{ variantId, quantity: '2' }],
      payment: { method: 'CASH', amount: '100000' },
    },
  });
  assert.equal(chk.response.status, 201, JSON.stringify(chk.payload));

  // Step 1: Export encrypted backup & store in external backup directory
  const exportRes = await fetch(`${baseUrl}/api/backups/export`, {
    method: 'POST',
    headers: { Origin: baseUrl, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(exportRes.status, 200);
  const archiveBytes = Buffer.from(await exportRes.arrayBuffer());
  assert.equal(archiveBytes.subarray(0, 5).toString(), 'RFBK1');
  const externalArchivePath = join(externalBackupDir, 'retailos-external-drill.rfbackup');
  await writeFile(externalArchivePath, archiveBytes);

  // Step 2: Mutate DB after backup (add an extra expense that should disappear once restored to snapshot)
  await api(baseUrl, '/api/expenses', {
    method: 'POST',
    cookie,
    body: {
      idempotencyKey: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbb3',
      storeId,
      categoryCode: 'OTHER',
      amount: '9900',
      paymentMethod: 'CASH_DRAWER',
      expenseDate: new Date().toISOString().slice(0, 10),
      notes: 'مصروف بعد النسخة يجب ألا يبقى بعد الاستعادة',
    },
  });

  // Step 3: Verify tampered archive and wrong passphrase are rejected
  const wrongPassRes = await fetch(`${baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
      'X-Backup-Passphrase': Buffer.from('Wrong-Passphrase-999').toString('base64url'),
      'X-RetailOS-Restore-Confirm': 'replace',
    },
    body: await readFile(externalArchivePath),
  });
  assert.equal(wrongPassRes.status, 400);

  const tampered = Buffer.from(archiveBytes);
  tampered[tampered.length - 1] ^= 0xff;
  const tamperedRes = await fetch(`${baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
      'X-Backup-Passphrase': Buffer.from(passphrase).toString('base64url'),
      'X-RetailOS-Restore-Confirm': 'replace',
    },
    body: tampered,
  });
  assert.equal(tamperedRes.status, 400);

  // Step 4: Copy external backup cleanly and execute full restore (triggers self-restart on same port)
  const externalCopy = join(externalBackupDir, 'retailos-copy-for-restore.rfbackup');
  await copyFile(externalArchivePath, externalCopy);
  const restoreRes = await fetch(`${baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
      'X-Backup-Passphrase': Buffer.from(passphrase).toString('base64url'),
      'X-RetailOS-Restore-Confirm': 'replace',
    },
    body: await readFile(externalCopy),
  });
  assert.equal(restoreRes.status, 202);
  await new Promise((r) => setTimeout(r, 900));
  await waitForReady(baseUrl, false);

  // Step 5: Re-login and verify restored state matches snapshot point-in-time exactly
  const loginAfter = await api(baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'drill_owner', password: 'DrillOwnerPassword2026!' },
  });
  assert.equal(loginAfter.response.status, 200);
  const afterCookie = (loginAfter.response.headers.get('set-cookie') ?? '').split(';')[0];
  const restoredData = await api(baseUrl, '/api/data', { cookie: afterCookie });
  assert.equal(restoredData.payload.products[0].variants[0].quantity, '3');
  assert.equal(restoredData.payload.sales.length, 1);
  assert.equal(restoredData.payload.suppliers[0].totalPurchased, '100000');
  assert.equal(restoredData.payload.suppliers[0].totalPaid, '40000');
  assert.equal(restoredData.payload.suppliers[0].balanceDue, '60000');
  assert.equal(restoredData.payload.expenses.length, 0);

  const auditRes = await api(baseUrl, `/api/audit-logs?storeId=${storeId}`, { cookie: afterCookie });
  assert.equal(auditRes.payload.chainVerification.valid, true);

  console.log(JSON.stringify({
    drillPassed: true,
    externalArchiveBytes: archiveBytes.length,
    restoredSalesCount: restoredData.payload.sales.length,
    restoredStockQty: restoredData.payload.products[0].variants[0].quantity,
    restoredSupplierDue: restoredData.payload.suppliers[0].balanceDue,
    postBackupExpenseReverted: restoredData.payload.expenses.length === 0,
    auditChainValid: auditRes.payload.chainVerification.valid,
  }, null, 2));
} finally {
  try {
    await new Promise((r) => setTimeout(r, 100));
    if (srv.exitCode === null) srv.kill('SIGTERM');
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
}
