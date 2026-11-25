import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServerApp } from '../server.mjs';
import { cleanupTempDir, createTestTempDir } from './e2e-server-harness.mjs';

function signResetToken(privateKeyPem, payload, prefix = 'ROSRST1') {
  const payloadB64u = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${prefix}.${payloadB64u}`;
  const signatureB64u = sign(null, Buffer.from(signingInput, 'utf8'), privateKeyPem).toString('base64url');
  return `${signingInput}.${signatureB64u}`;
}

test('vendor emergency password reset verifies Ed25519 token, enforces machine & expiry & one-time use, and invalidates old sessions', async () => {
  const dataDir = await createTestTempDir('retailos-vendor-reset-');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const machineId = 'ROS-ABCD-2345-WXYZ';
  const nowMs = Date.UTC(2026, 10, 23, 18, 0, 0);

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
  process.env.RETAILOS_COMPANY_NAME = 'شركة اختبار استعادة كلمة المرور';
  process.env.RETAILOS_COMPANY_CODE = 'RSTTEST';
  process.env.RETAILOS_CURRENCY = 'EGP';
  process.env.RETAILOS_STORE_NAME = 'الفرع الرئيسي';

  const app = await createServerApp({
    host: '127.0.0.1',
    port: freePort,
    dataDir,
    watermarkSecret: randomBytes(32).toString('hex'),
    dailyBackupSecret: randomBytes(32).toString('base64url'),
    licensePublicKey: publicKey,
    licenseIdentityProvider: () => ({ machineId, isHardwareBacked: true }),
    nowProvider: () => nowMs,
  });

  try {
    const baseUrl = app.origin;
    const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };

    // 1. Setup owner account
    const setupRes = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ownerName: 'المدير الأصلي',
        ownerUsername: 'owneradmin',
        password: 'OldPassword123!',
      }),
    });
    assert.equal(setupRes.status, 201);

    // 2. Login with old password and capture session cookie
    const oldLoginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'owneradmin', password: 'OldPassword123!' }),
    });
    assert.equal(oldLoginRes.status, 200);
    const oldCookie = oldLoginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(oldCookie.startsWith('retailos_session='));

    // 3. Reject token for a different machine
    const wrongMachineToken = signResetToken(privateKey, {
      resetId: randomUUID(),
      machineId: 'ROS-9999-8888-7777',
      issuedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    });
    const wrongMachineRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: wrongMachineToken, newPassword: 'NewPassword456!' }),
    });
    assert.equal(wrongMachineRes.status, 400);

    // 4. Reject expired token
    const expiredToken = signResetToken(privateKey, {
      resetId: randomUUID(),
      machineId,
      issuedAt: new Date(nowMs - 7200_000).toISOString(),
      expiresAt: new Date(nowMs - 60_000).toISOString(),
    });
    const expiredRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: expiredToken, newPassword: 'NewPassword456!' }),
    });
    assert.equal(expiredRes.status, 400);

    // 5. Reject regular license token prefix (domain separation)
    const wrongPrefixToken = signResetToken(
      privateKey,
      {
        resetId: randomUUID(),
        machineId,
        issuedAt: new Date(nowMs - 60_000).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      },
      'ROS1',
    );
    const wrongPrefixRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: wrongPrefixToken, newPassword: 'NewPassword456!' }),
    });
    assert.equal(wrongPrefixRes.status, 400);

    // 5b. Reject passwords shorter than 12 characters even with a valid reset token
    const shortPassToken = signResetToken(privateKey, {
      resetId: randomUUID(),
      machineId,
      issuedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    });
    const shortPassRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: shortPassToken, newPassword: 'ShortPass12' }),
    });
    assert.equal(shortPassRes.status, 400);

    // 6. Valid one-time reset token succeeds even without typing username
    const validToken = signResetToken(privateKey, {
      resetId: randomUUID(),
      machineId,
      issuedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: new Date(nowMs + 24 * 3600_000).toISOString(),
    });
    const resetRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: validToken, newPassword: 'NewPassword456!' }),
    });
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.username, 'owneradmin');

    // 7. Old session cookie is invalidated
    const oldSessionCheck = await fetch(`${baseUrl}/api/data`, {
      headers: { Cookie: oldCookie },
    });
    assert.equal(oldSessionCheck.status, 401);

    // 8. Old password fails, new password succeeds
    const failOldLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'owneradmin', password: 'OldPassword123!' }),
    });
    assert.equal(failOldLogin.status, 401);

    const newLoginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'owneradmin', password: 'NewPassword456!' }),
    });
    assert.equal(newLoginRes.status, 200);

    // 9. Replaying the exact same reset token fails with 409
    const replayRes = await fetch(`${baseUrl}/api/auth/vendor-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resetToken: validToken, newPassword: 'AnotherPassword789!' }),
    });
    assert.equal(replayRes.status, 409);
  } finally {
    await app.shutdown();
    await cleanupTempDir(dataDir);
  }
});

test('POST /api/license/reset-clock recovers CLOCK_TAMPERED via single-use ROSCLK1 token and rejects invalid/replayed tokens', async () => {
  const dataDir = await createTestTempDir('retailos-clock-reset-http-');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const machineId = 'ROS-HTTP-CLKR-WXYZ';
  let currentNowMs = Date.UTC(2026, 10, 23, 18, 0, 0);

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
  process.env.RETAILOS_COMPANY_NAME = 'شركة اختبار ساعة الترخيص';
  process.env.RETAILOS_COMPANY_CODE = 'CLKHTTP';
  process.env.RETAILOS_CURRENCY = 'EGP';
  process.env.RETAILOS_STORE_NAME = 'الفرع الرئيسي';

  const app = await createServerApp({
    host: '127.0.0.1',
    port: freePort,
    dataDir,
    watermarkSecret: randomBytes(32).toString('hex'),
    dailyBackupSecret: randomBytes(32).toString('base64url'),
    licensePublicKey: publicKey,
    licenseIdentityProvider: () => ({ machineId, isHardwareBacked: true }),
    nowProvider: () => currentNowMs,
  });

  try {
    const baseUrl = app.origin;
    const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };

    const licenseToken = signResetToken(
      privateKey,
      {
        licenseId: randomUUID(),
        customerName: 'عميل اختبار الساعة',
        machineId,
        issuedAt: new Date(currentNowMs - 3600_000).toISOString(),
        expiresAt: new Date(currentNowMs + 365 * 24 * 3600_000).toISOString(),
        planName: 'سنوية',
      },
      'ROS1',
    );
    const actRes = await fetch(`${baseUrl}/api/license/activate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: licenseToken }),
    });
    assert.equal(actRes.status, 200);

    // Jump clock 15 days forward so watermark advances, then return to real time -> CLOCK_TAMPERED
    const realTimeAfterJump = currentNowMs + 60_000;
    currentNowMs += 15 * 24 * 3600_000;
    const jumpedStatusRes = await fetch(`${baseUrl}/api/license/status`);
    assert.equal(jumpedStatusRes.status, 200);

    currentNowMs = realTimeAfterJump;
    const tamperedStatusRes = await fetch(`${baseUrl}/api/license/status`);
    assert.equal(tamperedStatusRes.status, 200);
    const tamperedBody = await tamperedStatusRes.json();
    assert.equal(tamperedBody.status, 'CLOCK_TAMPERED');

    // Invalid token -> 400
    const badResetToken = signResetToken(
      privateKey,
      {
        resetId: randomUUID(),
        machineId: 'ROS-DIFF-MACH-0000',
        issuedAt: new Date(currentNowMs - 60_000).toISOString(),
        expiresAt: new Date(currentNowMs + 3600_000).toISOString(),
      },
      'ROSCLK1',
    );
    const invalidRes = await fetch(`${baseUrl}/api/license/reset-clock`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: badResetToken }),
    });
    assert.equal(invalidRes.status, 400);

    // Valid ROSCLK1 token recovers license -> 200 ACTIVE
    const validClockResetToken = signResetToken(
      privateKey,
      {
        resetId: randomUUID(),
        machineId,
        issuedAt: new Date(currentNowMs - 60_000).toISOString(),
        expiresAt: new Date(currentNowMs + 24 * 3600_000).toISOString(),
      },
      'ROSCLK1',
    );
    const recoverRes = await fetch(`${baseUrl}/api/license/reset-clock`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: validClockResetToken }),
    });
    assert.equal(recoverRes.status, 200);
    const recoverBody = await recoverRes.json();
    assert.equal(recoverBody.status, 'ACTIVE');

    const statusAfterRecover = await (await fetch(`${baseUrl}/api/license/status`)).json();
    assert.equal(statusAfterRecover.status, 'ACTIVE');

    // Replay same ROSCLK1 token -> 409
    const replayClockRes = await fetch(`${baseUrl}/api/license/reset-clock`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: validClockResetToken }),
    });
    assert.equal(replayClockRes.status, 409);
  } finally {
    await app.shutdown();
    await cleanupTempDir(dataDir);
  }
});
