import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MACHINE_ID_PATTERN } from '@retailos/core';
import {
  DatabaseMigrator,
  deriveMachineIdFromSeed,
  LicenseEnforcementError,
  LicenseHardwareIdentityError,
  LicenseService,
  resolveHardwareIdentityDetails,
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

function signClockResetTestToken(
  privateKeyPem: string,
  payload: {
    resetId?: string;
    machineId: string;
    issuedAt: string;
    expiresAt: string;
  },
  prefix = 'ROSCLK1',
): string {
  const fullPayload = {
    resetId: payload.resetId ?? randomUUID(),
    machineId: payload.machineId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  const payloadB64u = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const signingInput = `${prefix}.${payloadB64u}`;
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

      // 2. Migration 029 trigger blocks SQLite DELETE on system_licensing; even if trigger is dropped offline, missing row -> CLOCK_TAMPERED
      await expect(db.deleteFrom('system_licensing').execute()).rejects.toThrow(
        /deletion is forbidden|system_licensing/,
      );
      await sql`DROP TRIGGER IF EXISTS trg_system_licensing_no_delete;`.execute(db);
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

  it('prevents backup-restore clock rewind via external DPAPI watermark floor', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = deriveMachineIdFromSeed('machine-backup-rewind');
      const watermarkSecret = 'd'.repeat(64);
      const token = signTestToken(privateKey, {
        customerName: 'متجر النسخ',
        machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });

      // DB represents an older backup taken on Nov 18
      let nowMs = Date.parse('2026-11-18T10:00:00.000Z');
      const backupTimeService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret,
        machineIdOverride: machineId,
        nowProvider: () => nowMs,
      });
      await backupTimeService.activate(token);

      // Simulate restoring that Nov 18 backup on Nov 20 while external DPAPI watermark reached Nov 25
      const externalNov25 = Date.parse('2026-11-25T10:00:00.000Z');
      let capturedAdvance = 0;
      nowMs = Date.parse('2026-11-20T10:00:00.000Z');
      const rewoundService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret,
        externalWatermarkMs: externalNov25,
        onWatermarkAdvance: (ms) => {
          capturedAdvance = ms;
        },
        machineIdOverride: machineId,
        nowProvider: () => nowMs,
      });

      expect((await rewoundService.getStatus()).status).toBe('CLOCK_TAMPERED');
      await expect(rewoundService.assertOperationalAccess()).rejects.toMatchObject({
        status: 402,
        licenseStatus: 'CLOCK_TAMPERED',
      });
      await expect(rewoundService.activate(token)).rejects.toMatchObject({ status: 400 });

      // When system clock is legitimate (Nov 26 >= external Nov 25), status returns ACTIVE and advances DB & external clock
      nowMs = Date.parse('2026-11-26T10:00:00.000Z');
      expect((await rewoundService.getStatus()).status).toBe('ACTIVE');
      expect(capturedAdvance).toBe(nowMs);
    } finally {
      await dbManager.close();
    }
  });

  it('retries slow hardware probes, falls back to hardware UUID, and never yields false MACHINE_MISMATCH on transient failure', async () => {
    // 1. Retries transient reg.exe failures up to 3 times with 200ms backoff before succeeding
    let regAttempts = 0;
    const sleepCalls: number[] = [];
    const retried = resolveHardwareIdentityDetails({
      platformOverride: 'win32',
      readWinGuidFn: () => {
        regAttempts += 1;
        return regAttempts < 3 ? null : '11111111-2222-3333-4444-555555555555';
      },
      readWinUuidFn: () => '99999999-aaaa-bbbb-cccc-dddddddddddd',
      sleepFn: (ms) => sleepCalls.push(ms),
    });
    expect(regAttempts).toBe(3);
    expect(sleepCalls).toEqual([200, 200]);
    expect(retried.isHardwareBacked).toBe(true);
    expect(retried.source).toBe('win32-guid');

    // 2. Falls back to hardware UUID when all 3 MachineGuid attempts fail
    let regFailCount = 0;
    const uuidFallback = resolveHardwareIdentityDetails({
      platformOverride: 'win32',
      readWinGuidFn: () => {
        regFailCount += 1;
        return null;
      },
      readWinUuidFn: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sleepFn: () => undefined,
    });
    expect(regFailCount).toBe(3);
    expect(uuidFallback.isHardwareBacked).toBe(true);
    expect(uuidFallback.source).toBe('win32-uuid');
    expect(uuidFallback.machineId).toBe(
      deriveMachineIdFromSeed('win32-uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    );

    // 3. Degraded fallback is marked isHardwareBacked=false and LicenseService refuses false MACHINE_MISMATCH
    const degraded = resolveHardwareIdentityDetails({
      platformOverride: 'win32',
      readWinGuidFn: () => null,
      readWinUuidFn: () => null,
      sleepFn: () => undefined,
    });
    expect(degraded.isHardwareBacked).toBe(false);
    expect(degraded.source).toBe('fallback');

    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();
      const { publicKey, privateKey } = createTestKeyPair();
      const nowMs = Date.parse('2026-11-18T10:00:00.000Z');
      const token = signTestToken(privateKey, {
        customerName: 'متجر الصمود',
        machineId: retried.machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });

      const bootService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret: 'e'.repeat(64),
        identityProvider: () => ({ machineId: retried.machineId, isHardwareBacked: true }),
        nowProvider: () => nowMs,
      });
      await bootService.activate(token);

      // Simulate subsequent slow boot where hardware lookup transiently degrades
      let hardwareAvailable = false;
      const slowBootService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret: 'e'.repeat(64),
        identityProvider: () =>
          hardwareAvailable
            ? { machineId: retried.machineId, isHardwareBacked: true }
            : { machineId: degraded.machineId, isHardwareBacked: false },
        nowProvider: () => nowMs + 60_000,
      });

      await expect(slowBootService.getStatus()).rejects.toMatchObject({
        name: 'LicenseHardwareIdentityError',
        status: 503,
        code: 'HARDWARE_IDENTITY_UNAVAILABLE',
        retryable: true,
      });
      await expect(slowBootService.assertOperationalAccess()).rejects.toBeInstanceOf(
        LicenseHardwareIdentityError,
      );

      // Once OS hardware subsystem responds, the active license evaluates ACTIVE with zero corruption
      hardwareAvailable = true;
      const recovered = await slowBootService.getStatus();
      expect(recovered.status).toBe('ACTIVE');
      expect(recovered.machineId).toBe(retried.machineId);
    } finally {
      await dbManager.close();
    }
  });

  it('recovers from CLOCK_TAMPERED via single-use ROSCLK1 vendor token (even with future ledger/external watermark) while preserving forward-only checks', async () => {
    const dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
    try {
      const db = dbManager.getDb();
      await new DatabaseMigrator(db).migrateToLatest();

      const { publicKey, privateKey } = createTestKeyPair();
      const machineId = 'ROS-CLKR-3456-WXYZ';
      const initialNow = Date.parse('2026-11-18T10:00:00.000Z');
      const futureJumpMs = Date.parse('2026-12-05T10:00:00.000Z');
      const realClockAfterJumpMs = Date.parse('2026-11-19T12:00:00.000Z');
      let currentNow = initialNow;
      let externalMs = initialNow;
      const resetCallbacks: number[] = [];

      const licenseToken = signTestToken(privateKey, {
        customerName: 'متجر استعادة الساعة',
        machineId,
        issuedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2027-11-01T00:00:00.000Z',
        planName: 'سنوية',
      });

      const tenantId = 'tenant-clock-reset';
      const storeId = 'store-clock-reset';
      const userId = 'user-clock-reset';
      await db.insertInto('tenants').values({ id: tenantId, name: 'Shop', code: 'CLKRES', currency: 'EGP' }).execute();
      await db.insertInto('stores').values({ id: storeId, tenant_id: tenantId, name: 'Main', code: 'MAIN', address: 'Cairo', phone: '0100' }).execute();
      await db.insertInto('users').values({ id: userId, tenant_id: tenantId, store_id: storeId, username: 'cashier_clk', password_hash: 'hash', full_name: 'Cashier', role: 'CASHIER' }).execute();

      const svc1 = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret: 'f'.repeat(64),
        machineIdOverride: machineId,
        isHardwareBackedOverride: true,
        nowProvider: () => currentNow,
        externalWatermarkMs: externalMs,
        onWatermarkAdvance: (ms) => { externalMs = Math.max(externalMs, ms); },
        onWatermarkReset: (ms) => {
          externalMs = ms;
          resetCallbacks.push(ms);
        },
      });
      await svc1.activate(licenseToken);

      // Clock jumps forward (CMOS / accidental sync) + a sale & audit entry get recorded at the future timestamp
      currentNow = futureJumpMs;
      await svc1.getStatus();
      expect(externalMs).toBe(futureJumpMs);
      await db.insertInto('sales').values({
        id: 'sale-future-1',
        tenant_id: tenantId,
        store_id: storeId,
        sale_number: 'INV-FUTURE-1',
        idempotency_key: 'idem-future-1',
        customer_name: null,
        currency: 'EGP',
        subtotal: 1000n,
        discount_total: 0n,
        total: 1000n,
        paid_total: 1000n,
        change_given: 0n,
        cashier_user_id: userId,
        status: 'COMPLETED',
        created_at: new Date(futureJumpMs).toISOString(),
      }).execute();

      // Clock returns to the real present time (and even an external watermark tamper flag is set)
      currentNow = realClockAfterJumpMs;
      const tamperedService = new LicenseService(db, {
        publicKeyPem: publicKey,
        watermarkSecret: 'f'.repeat(64),
        machineIdOverride: machineId,
        isHardwareBackedOverride: true,
        nowProvider: () => currentNow,
        externalWatermarkMs: externalMs,
        externalWatermarkTampered: true,
        onWatermarkAdvance: (ms) => { externalMs = Math.max(externalMs, ms); },
        onWatermarkReset: (ms) => {
          externalMs = ms;
          resetCallbacks.push(ms);
        },
      });

      const blocked = await tamperedService.getStatus();
      expect(blocked.status).toBe('CLOCK_TAMPERED');
      await expect(tamperedService.assertOperationalAccess()).rejects.toBeInstanceOf(LicenseEnforcementError);

      // Wrong machine, expired, and domain-separated ROS1 tokens must all fail with 400
      const wrongMachineReset = signClockResetTestToken(privateKey, {
        machineId: 'ROS-9999-8888-7777',
        issuedAt: new Date(realClockAfterJumpMs - 60_000).toISOString(),
        expiresAt: new Date(realClockAfterJumpMs + 3600_000).toISOString(),
      });
      await expect(tamperedService.resetClockWithVendorToken(wrongMachineReset)).rejects.toMatchObject({ status: 400 });

      const expiredReset = signClockResetTestToken(privateKey, {
        machineId,
        issuedAt: new Date(realClockAfterJumpMs - 7200_000).toISOString(),
        expiresAt: new Date(realClockAfterJumpMs - 60_000).toISOString(),
      });
      await expect(tamperedService.resetClockWithVendorToken(expiredReset)).rejects.toMatchObject({ status: 400 });

      const wrongPrefix = signClockResetTestToken(
        privateKey,
        {
          machineId,
          issuedAt: new Date(realClockAfterJumpMs - 60_000).toISOString(),
          expiresAt: new Date(realClockAfterJumpMs + 3600_000).toISOString(),
        },
        'ROSRST1',
      );
      await expect(tamperedService.resetClockWithVendorToken(wrongPrefix)).rejects.toMatchObject({ status: 400 });

      // Valid ROSCLK1 token recovers the license immediately and resets cutoffs + external watermark
      const validResetToken = signClockResetTestToken(privateKey, {
        machineId,
        issuedAt: new Date(realClockAfterJumpMs - 60_000).toISOString(),
        expiresAt: new Date(realClockAfterJumpMs + 24 * 3600_000).toISOString(),
      });
      const recovered = await tamperedService.resetClockWithVendorToken(validResetToken);
      expect(recovered.status).toBe('ACTIVE');
      expect(resetCallbacks).toEqual([realClockAfterJumpMs]);
      expect(externalMs).toBe(realClockAfterJumpMs);

      const postResetStatus = await tamperedService.getStatus();
      expect(postResetStatus.status).toBe('ACTIVE');
      await expect(tamperedService.assertOperationalAccess()).resolves.toMatchObject({ status: 'ACTIVE' });

      // Replaying the same ROSCLK1 token fails with 409
      await expect(tamperedService.resetClockWithVendorToken(validResetToken)).rejects.toMatchObject({ status: 409 });

      // Forward-only tamper detection still holds after reset: rolling clock backwards triggers CLOCK_TAMPERED
      currentNow = realClockAfterJumpMs - 10 * 60_000;
      const rewoundStatus = await tamperedService.getStatus();
      expect(rewoundStatus.status).toBe('CLOCK_TAMPERED');

      // New operational rows written after reset still participate in monotonic clock protection
      currentNow = realClockAfterJumpMs + 60_000;
      await tamperedService.getStatus();
      const postResetSaleTime = realClockAfterJumpMs + 15 * 60_000;
      await db.insertInto('sales').values({
        id: 'sale-after-reset-1',
        tenant_id: tenantId,
        store_id: storeId,
        sale_number: 'INV-AFTER-1',
        idempotency_key: 'idem-after-1',
        customer_name: null,
        currency: 'EGP',
        subtotal: 2000n,
        discount_total: 0n,
        total: 2000n,
        paid_total: 2000n,
        change_given: 0n,
        cashier_user_id: userId,
        status: 'COMPLETED',
        created_at: new Date(postResetSaleTime).toISOString(),
      }).execute();
      currentNow = realClockAfterJumpMs + 2 * 60_000;
      const rewoundAfterSale = await tamperedService.getStatus();
      expect(rewoundAfterSale.status).toBe('CLOCK_TAMPERED');
    } finally {
      await dbManager.close();
    }
  });
});
