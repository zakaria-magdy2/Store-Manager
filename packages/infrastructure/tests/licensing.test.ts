import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MACHINE_ID_PATTERN } from '@retailos/core';
import {
  DatabaseMigrator,
  deriveMachineIdFromSeed,
  LicenseEnforcementError,
  LicenseService,
  SqliteDatabaseManager,
} from '../src/index.js';

function createTestKeyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signTestToken(
  privateKeyPem: string,
  payload: {
    licenseId?: string;
    customerName: string;
    machineId: string;
    issuedAt: string;
    expiresAt: string;
    planName: string;
  },
): string {
  const fullPayload = {
    licenseId: payload.licenseId ?? randomUUID(),
    customerName: payload.customerName,
    machineId: payload.machineId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    planName: payload.planName,
  };
  const payloadB64u = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const signingInput = `ROS1.${payloadB64u}`;
  const sigB64u = sign(null, Buffer.from(signingInput, 'utf8'), privateKeyPem).toString('base64url');
  return `${signingInput}.${sigB64u}`;
}

describe('Offline Hardware-Locked Ed25519 Licensing Engine', () => {
  it('formats deterministic machine fingerprints in ROS-XXXX-XXXX-XXXX without ambiguous characters', () => {
    const idA = deriveMachineIdFromSeed('win32-guid:11111111-2222-3333-4444-555555555555');
    const idASame = deriveMachineIdFromSeed('win32-guid:11111111-2222-3333-4444-555555555555');
    const idB = deriveMachineIdFromSeed('win32-guid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(idA).toBe(idASame);
    expect(idA).not.toBe(idB);
    expect(MACHINE_ID_PATTERN.test(idA)).toBe(true);
    expect(/[01OI]/.test(idA.slice(4))).toBe(false);
  });

  it('activates valid token, persists across restart, and blocks writes when unlicensed or expired', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = deriveMachineIdFromSeed('machine-alpha');
      const watermarkSecret = 'a'.repeat(64);
      let currentNow = Date.parse('2026-11-18T10:00:00.000Z');

      const service = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret,
        machineIdOverride: machineId,
        nowProvider: () => currentNow,
      });

      const initial = await service.getStatus();
      expect(initial.status).toBe('UNLICENSED');
      expect(initial.machineId).toBe(machineId);
      await expect(service.assertOperationalAccess()).rejects.toBeInstanceOf(
        LicenseEnforcementError,
      );

      const token = signTestToken(privateKey, {
        customerName: 'متجر النور',
        machineId,
        issuedAt: '2026-11-18T00:00:00.000Z',
        expiresAt: '2026-11-25T10:00:00.000Z',
        planName: 'اشتراك تجريبي',
      });

      const activated = await service.activate(token);
      expect(activated.status).toBe('ACTIVE');
      expect(activated.customerName).toBe('متجر النور');
      expect(activated.daysRemaining).toBe(7);

      // Re-instantiate service with the same per-install secret to verify SQLite persistence
      const restartedService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret,
        machineIdOverride: machineId,
        nowProvider: () => currentNow,
      });
      const persisted = await restartedService.getStatus();
      expect(persisted.status).toBe('ACTIVE');
      expect(persisted.customerName).toBe('متجر النور');

      // Advance past expiration date
      currentNow = Date.parse('2026-11-26T00:00:00.000Z');
      const expired = await restartedService.getStatus();
      expect(expired.status).toBe('EXPIRED');
      await expect(restartedService.assertOperationalAccess()).rejects.toMatchObject({
        status: 402,
        code: 'LICENSE_REQUIRED',
        licenseStatus: 'EXPIRED',
      });
    } finally {
      await dbManager.close();
    }
  });

  it('rejects wrong machine ID, tampered signature, and expired tokens on activate()', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = deriveMachineIdFromSeed('machine-one');
      const otherMachineId = deriveMachineIdFromSeed('machine-two');
      const nowMs = Date.parse('2026-11-18T10:00:00.000Z');

      const service = new LicenseService(db, {
        publicKeyPem: publicKey,
        machineIdOverride: machineId,
        nowProvider: () => nowMs,
      });

      const wrongMachineToken = signTestToken(privateKey, {
        customerName: 'جهاز آخر',
        machineId: otherMachineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });
      await expect(service.activate(wrongMachineToken)).rejects.toMatchObject({ status: 400 });

      const validToken = signTestToken(privateKey, {
        customerName: 'متجر الأمانة',
        machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });
      const parts = validToken.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({
          licenseId: randomUUID(),
          customerName: 'مخترق',
          machineId,
          issuedAt: '2026-11-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          planName: 'مخترقة',
        }),
        'utf8',
      ).toString('base64url');
      const tamperedToken = `${parts[0]}.${forgedPayload}.${parts[2]}`;
      await expect(service.activate(tamperedToken)).rejects.toMatchObject({ status: 400 });

      const expiredToken = signTestToken(privateKey, {
        customerName: 'متجر منتهي',
        machineId,
        issuedAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
        planName: 'سنوية',
      });
      await expect(service.activate(expiredToken)).rejects.toMatchObject({ status: 400 });

      // Simulate migrating SQLite from machine-two to machine-one directly
      await db
        .updateTable('system_licensing')
        .set({ activation_token: wrongMachineToken })
        .where('id', '=', 1)
        .execute();
      const mismatchStatus = await service.getStatus();
      expect(mismatchStatus.status).toBe('MACHINE_MISMATCH');
    } finally {
      await dbManager.close();
    }
  });

  it('detects system clock rollback and manual SQLite watermark tampering as CLOCK_TAMPERED', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = deriveMachineIdFromSeed('machine-clock');
      let currentNow = Date.parse('2026-11-18T10:00:00.000Z');

      const service = new LicenseService(db, {
        publicKeyPem: publicKey,
        machineIdOverride: machineId,
        nowProvider: () => currentNow,
      });

      const token = signTestToken(privateKey, {
        customerName: 'متجر الساعة',
        machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });
      await service.activate(token);

      // Move clock forward 2 hours and touch watermark during checkout
      currentNow += 2 * 60 * 60 * 1000;
      expect((await service.touchWatermarkOnCheckout()).status).toBe('ACTIVE');

      // Roll clock backward 10 minutes (> 5 min tolerance) -> CLOCK_TAMPERED
      currentNow -= 10 * 60 * 1000;
      const tampered = await service.getStatus();
      expect(tampered.status).toBe('CLOCK_TAMPERED');
      await expect(service.touchWatermarkOnCheckout()).rejects.toMatchObject({
        status: 402,
        licenseStatus: 'CLOCK_TAMPERED',
      });

      // Restore clock forward -> returns to ACTIVE
      currentNow += 15 * 60 * 1000;
      expect((await service.getStatus()).status).toBe('ACTIVE');

      // Manual SQLite tampering of last_verified_clock_ms breaks HMAC -> CLOCK_TAMPERED
      await db
        .updateTable('system_licensing')
        .set({ last_verified_clock_ms: 0 })
        .where('id', '=', 1)
        .execute();
      expect((await service.getStatus()).status).toBe('CLOCK_TAMPERED');
    } finally {
      await dbManager.close();
    }
  });

  it('flags CLOCK_TAMPERED when system_licensing row is deleted after business activity or clock predates sales', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = deriveMachineIdFromSeed('machine-hardened');
      const watermarkSecret = 'f'.repeat(64);
      let currentNow = Date.parse('2026-11-18T10:00:00.000Z');

      const service = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret,
        machineIdOverride: machineId,
        nowProvider: () => currentNow,
      });

      const token = signTestToken(privateKey, {
        customerName: 'متجر التحصين',
        machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });
      await service.activate(token);

      // Record tenant, store, user, and a completed sale in SQLite (using SQLite CURRENT_TIMESTAMP UTC format)
      const tenantId = randomUUID();
      const storeId = randomUUID();
      const cashierUserId = randomUUID();
      await db
        .insertInto('tenants')
        .values({
          id: tenantId,
          name: 'متجر التحصين',
          code: 'HARDEN',
          currency: 'EGP',
          timezone: 'Africa/Cairo',
        })
        .execute();
      await db
        .insertInto('stores')
        .values({
          id: storeId,
          tenant_id: tenantId,
          name: 'الفرع الرئيسي',
          code: 'MAIN',
          address: null,
          phone: null,
        })
        .execute();
      await db
        .insertInto('users')
        .values({
          id: cashierUserId,
          tenant_id: tenantId,
          store_id: storeId,
          username: 'cashier_harden',
          password_hash: 'hash',
          full_name: 'كاشير التحصين',
          role: 'CASHIER',
        })
        .execute();
      await db
        .insertInto('sales')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          store_id: storeId,
          sale_number: 'INV-1',
          idempotency_key: randomUUID(),
          customer_name: null,
          currency: 'EGP',
          subtotal: 10000n,
          discount_total: 0n,
          total: 10000n,
          paid_total: 10000n,
          change_given: 0n,
          cashier_user_id: cashierUserId,
          status: 'COMPLETED',
          created_at: '2026-11-20 12:00:00',
        })
        .execute();

      // 1. Even before watermark row advances, system clock (Nov 18) earlier than recorded sale (Nov 20) -> CLOCK_TAMPERED
      const ledgerRollback = await service.getStatus();
      expect(ledgerRollback.status).toBe('CLOCK_TAMPERED');
      await expect(service.assertOperationalAccess()).rejects.toMatchObject({
        status: 402,
        licenseStatus: 'CLOCK_TAMPERED',
      });

      // Advance clock past sale timestamp -> returns ACTIVE
      currentNow = Date.parse('2026-11-20T12:05:00.000Z');
      expect((await service.getStatus()).status).toBe('ACTIVE');

      // 2. Deleting the system_licensing row while sales exist must NOT silently recreate watermark -> CLOCK_TAMPERED
      await db.deleteFrom('system_licensing').execute();
      const deletedRowStatus = await service.getStatus();
      expect(deletedRowStatus.status).toBe('CLOCK_TAMPERED');
      const recreatedRows = await db.selectFrom('system_licensing').selectAll().execute();
      expect(recreatedRows.length).toBe(0);
      await expect(service.activate(token)).rejects.toMatchObject({ status: 400 });

      // 3. Changing the per-install secret invalidates the existing watermark HMAC -> CLOCK_TAMPERED
      const dbManager2 = new SqliteDatabaseManager({ filename: ':memory:' });
      dbManager2.connect();
      try {
        const db2 = dbManager2.getDb();
        await new DatabaseMigrator(db2).migrateToLatest();
        const freshService = new LicenseService(db2, {
          publicKeyPem: publicKey,
          watermarkSecret,
          machineIdOverride: machineId,
          nowProvider: () => currentNow,
        });
        await freshService.activate(token);
        const wrongSecretService = new LicenseService(db2, {
          publicKeyPem: publicKey,
          watermarkSecret: '0'.repeat(64),
          machineIdOverride: machineId,
          nowProvider: () => currentNow,
        });
        expect((await wrongSecretService.getStatus()).status).toBe('CLOCK_TAMPERED');
      } finally {
        await dbManager2.close();
      }
    } finally {
      await dbManager.close();
    }
  });
});
