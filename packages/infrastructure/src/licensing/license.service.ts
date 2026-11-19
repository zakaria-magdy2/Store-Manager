import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  computeRemainingDaysCeiling,
  parseLicenseTokenFormat,
  validateLicensePayloadObject,
  type LicenseEvaluation,
  type LicensePayload,
  type LicenseStatus,
} from '@retailos/core';
import type { RetailOSDatabase, SystemLicensingTable } from '../database/types.js';
import { resolveMachineIdentity } from './machine-fingerprint.js';
import { EMBEDDED_LICENSE_PUBLIC_KEY_PEM } from './public-key.js';

export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

function parseLedgerTimestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // SQLite CURRENT_TIMESTAMP produces 'YYYY-MM-DD HH:MM:SS' in UTC without a timezone suffix.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return globalThis.Number.isFinite(parsed) ? parsed : null;
}

interface OperationalLedgerBaseline {
  readonly hasRecords: boolean;
  readonly maxTimestampMs: number | null;
}

export class LicenseEnforcementError extends Error {
  public readonly status = 402;
  public readonly code = 'LICENSE_REQUIRED';
  public readonly licenseStatus: LicenseStatus;

  constructor(licenseStatus: LicenseStatus, message: string) {
    super(message);
    this.name = 'LicenseEnforcementError';
    this.licenseStatus = licenseStatus;
  }
}

export class LicenseHardwareIdentityError extends Error {
  public readonly status = 503;
  public readonly code = 'HARDWARE_IDENTITY_UNAVAILABLE';
  public readonly retryable = true;

  constructor(
    message = 'تعذر التحقق المؤقت من معرف الجهاز أثناء تشغيل نظام التشغيل — يرجى إعادة المحاولة خلال لحظات',
  ) {
    super(message);
    this.name = 'LicenseHardwareIdentityError';
  }
}

export interface LicenseMachineIdentityResolution {
  readonly machineId: string;
  readonly isHardwareBacked: boolean;
}

export interface LicenseServiceOptions {
  readonly publicKeyPem?: string | undefined;
  readonly watermarkSecret?: string | undefined;
  readonly externalWatermarkMs?: number | undefined;
  readonly externalWatermarkTampered?: boolean | undefined;
  readonly onWatermarkAdvance?: ((clockMs: number) => void) | undefined;
  readonly machineIdOverride?: string | undefined;
  readonly isHardwareBackedOverride?: boolean | undefined;
  readonly identityProvider?: (() => LicenseMachineIdentityResolution) | undefined;
  readonly nowProvider?: (() => number) | undefined;
}

export class LicenseService {
  private readonly publicKeyPem: string;
  private readonly publicKey: KeyObject;
  private readonly watermarkSecret: string;
  private externalWatermarkMs: number;
  private readonly externalWatermarkTampered: boolean;
  private readonly onWatermarkAdvance: ((clockMs: number) => void) | undefined;
  private readonly machineIdOverride: string | undefined;
  private readonly isHardwareBackedOverride: boolean | undefined;
  private readonly identityProvider: (() => LicenseMachineIdentityResolution) | undefined;
  private pinnedHardwareIdentity: LicenseMachineIdentityResolution | null = null;
  private readonly nowProvider: () => number;

  constructor(
    private readonly db: Kysely<RetailOSDatabase>,
    options?: LicenseServiceOptions,
  ) {
    this.publicKeyPem = (options?.publicKeyPem ?? EMBEDDED_LICENSE_PUBLIC_KEY_PEM).trim();
    this.publicKey = createPublicKey(this.publicKeyPem);
    const providedSecret = options?.watermarkSecret?.trim();
    this.watermarkSecret =
      providedSecret && providedSecret.length >= 32
        ? providedSecret
        : randomBytes(32).toString('hex');
    const initialExtMs = options?.externalWatermarkMs;
    this.externalWatermarkMs =
      typeof initialExtMs === 'number' && globalThis.Number.isFinite(initialExtMs) && initialExtMs > 0
        ? initialExtMs
        : 0;
    this.externalWatermarkTampered = Boolean(options?.externalWatermarkTampered);
    this.onWatermarkAdvance = options?.onWatermarkAdvance;
    this.machineIdOverride = options?.machineIdOverride;
    this.isHardwareBackedOverride = options?.isHardwareBackedOverride;
    this.identityProvider = options?.identityProvider;
    this.nowProvider = options?.nowProvider ?? (() => Date.now());
  }

  private resolveCurrentIdentity(): LicenseMachineIdentityResolution {
    if (this.machineIdOverride !== undefined) {
      return {
        machineId: this.machineIdOverride,
        isHardwareBacked: this.isHardwareBackedOverride ?? true,
      };
    }
    if (this.pinnedHardwareIdentity !== null) {
      return this.pinnedHardwareIdentity;
    }
    const resolved = this.identityProvider
      ? this.identityProvider()
      : resolveMachineIdentity();
    if (resolved.isHardwareBacked) {
      this.pinnedHardwareIdentity = {
        machineId: resolved.machineId,
        isHardwareBacked: true,
      };
    }
    return resolved;
  }

  public getExternalWatermarkMs(): number {
    return this.externalWatermarkMs;
  }

  private recordWatermarkAdvance(clockMs: number): void {
    if (clockMs > this.externalWatermarkMs) {
      this.externalWatermarkMs = clockMs;
      this.onWatermarkAdvance?.(clockMs);
    }
  }

  public getMachineId(): string {
    return this.resolveCurrentIdentity().machineId;
  }

  public verifyRawToken(rawToken: string): LicensePayload | null {
    const parsed = parseLicenseTokenFormat(rawToken);
    if (!parsed) {
      return null;
    }

    let signatureBytes: Buffer;
    let payloadJsonBytes: Buffer;
    try {
      signatureBytes = Buffer.from(parsed.signatureBase64Url, 'base64url');
      payloadJsonBytes = Buffer.from(parsed.payloadBase64Url, 'base64url');
    } catch {
      return null;
    }

    const isSignatureValid = verify(
      null,
      Buffer.from(parsed.signingInput, 'utf8'),
      this.publicKey,
      signatureBytes,
    );
    if (!isSignatureValid) {
      return null;
    }

    let decodedPayload: unknown;
    try {
      decodedPayload = JSON.parse(payloadJsonBytes.toString('utf8'));
    } catch {
      return null;
    }

    return validateLicensePayloadObject(decodedPayload);
  }

  public async getStatus(): Promise<LicenseEvaluation> {
    const nowMs = this.nowProvider();
    const identity = this.resolveCurrentIdentity();
    if (this.externalWatermarkTampered) {
      return this.buildEvaluation(
        'CLOCK_TAMPERED',
        null,
        nowMs,
        'تم رصد عبث بملف توثيق التوقيت الخارجي للنظام',
        identity.machineId,
      );
    }

    const existingRow = await this.db
      .selectFrom('system_licensing')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();

    if (existingRow?.activation_token?.trim() && !identity.isHardwareBacked) {
      // Fail safely with a retryable error instead of evaluating/overwriting against a degraded digest.
      throw new LicenseHardwareIdentityError();
    }

    const ledgerBaseline = await this.getOperationalLedgerBaseline();
    const row = existingRow ?? (await this.ensureWatermarkRow(nowMs, ledgerBaseline, identity.machineId));

    if (!row) {
      return this.buildEvaluation(
        'CLOCK_TAMPERED',
        null,
        nowMs,
        'تم رصد حذف أو العبث بسجل توثيق التوقيت في قاعدة البيانات',
        identity.machineId,
      );
    }

    const token = row.activation_token?.trim() || null;
    const hmacValid = this.isWatermarkHmacValid(row, identity.machineId);
    const effectiveWatermarkMs = Math.max(
      row.last_verified_clock_ms,
      this.externalWatermarkMs,
      ledgerBaseline.maxTimestampMs ?? 0,
    );

    if (!token) {
      if (!hmacValid || nowMs + CLOCK_SKEW_TOLERANCE_MS < effectiveWatermarkMs) {
        return this.buildEvaluation(
          'CLOCK_TAMPERED',
          null,
          nowMs,
          'تم رصد تلاعب في تاريخ وساعة الجهاز أو سجل التوقيت',
          identity.machineId,
        );
      }
      const nextWatermarkMs = Math.max(nowMs, row.last_verified_clock_ms, this.externalWatermarkMs);
      if (nextWatermarkMs > row.last_verified_clock_ms) {
        await this.updateWatermarkRow(null, nextWatermarkMs, identity.machineId);
      }
      this.recordWatermarkAdvance(nextWatermarkMs);
      return this.buildEvaluation(
        'UNLICENSED',
        null,
        nowMs,
        'البرنامج غير مفعّل على هذا الجهاز',
        identity.machineId,
      );
    }

    const payload = this.verifyRawToken(token);
    if (!payload) {
      if (!hmacValid) {
        return this.buildEvaluation(
          'CLOCK_TAMPERED',
          null,
          nowMs,
          'تم رصد عبث بسجل توثيق التوقيت في قاعدة البيانات',
          identity.machineId,
        );
      }
      return this.buildEvaluation(
        'UNLICENSED',
        null,
        nowMs,
        'كود التفعيل المحفوظ غير صالح',
        identity.machineId,
      );
    }

    if (payload.machineId !== identity.machineId) {
      return this.buildEvaluation(
        'MACHINE_MISMATCH',
        payload,
        nowMs,
        'كود التفعيل المحفوظ مخصص لجهاز آخر',
        identity.machineId,
      );
    }

    if (!hmacValid || nowMs + CLOCK_SKEW_TOLERANCE_MS < effectiveWatermarkMs) {
      return this.buildEvaluation(
        'CLOCK_TAMPERED',
        payload,
        nowMs,
        'تاريخ وساعة الجهاز متأخران عن آخر تشغيل أو عملية مسجلة — يرجى ضبط التاريخ والوقت الصحيحين',
        identity.machineId,
      );
    }

    const nextWatermarkMs = Math.max(nowMs, row.last_verified_clock_ms, this.externalWatermarkMs);
    const expiresMs = Date.parse(payload.expiresAt);
    if (nowMs >= expiresMs) {
      if (nextWatermarkMs > row.last_verified_clock_ms) {
        await this.updateWatermarkRow(token, nextWatermarkMs, identity.machineId);
      }
      this.recordWatermarkAdvance(nextWatermarkMs);
      return this.buildEvaluation(
        'EXPIRED',
        payload,
        nowMs,
        'انتهت صلاحية الاشتراك — يرجى تجديد التفعيل',
        identity.machineId,
      );
    }

    if (nextWatermarkMs > row.last_verified_clock_ms) {
      await this.updateWatermarkRow(token, nextWatermarkMs, identity.machineId);
    }
    this.recordWatermarkAdvance(nextWatermarkMs);

    return this.buildEvaluation('ACTIVE', payload, nowMs, null, identity.machineId);
  }

  public async activate(rawToken: string): Promise<LicenseEvaluation> {
    const trimmed = rawToken.trim();
    const nowMs = this.nowProvider();
    const identity = this.resolveCurrentIdentity();
    if (this.externalWatermarkTampered) {
      throw Object.assign(
        new Error('تم رصد عبث بملف توثيق التوقيت الخارجي ولا يمكن التفعيل قبل إصلاحه'),
        { status: 400 },
      );
    }

    const existingPrecheck = await this.db
      .selectFrom('system_licensing')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
    if (existingPrecheck?.activation_token?.trim() && !identity.isHardwareBacked) {
      throw new LicenseHardwareIdentityError();
    }

    const ledgerBaseline = await this.getOperationalLedgerBaseline();
    const existingRow =
      existingPrecheck ?? (await this.ensureWatermarkRow(nowMs, ledgerBaseline, identity.machineId));

    if (!existingRow) {
      throw Object.assign(
        new Error('تم رصد حذف سجل توثيق التوقيت من قاعدة البيانات ولا يمكن التفعيل على قاعدة بيانات مفقودة السجل'),
        { status: 400 },
      );
    }

    const payload = this.verifyRawToken(trimmed);
    if (!payload) {
      throw Object.assign(new Error('كود التفعيل غير صالح أو التوقيع الرقمي غير مطابق'), {
        status: 400,
      });
    }

    if (payload.machineId !== identity.machineId) {
      if (!identity.isHardwareBacked) {
        throw new LicenseHardwareIdentityError();
      }
      throw Object.assign(
        new Error(`كود التفعيل مخصص لجهاز آخر (${payload.machineId}) ولا يعمل على هذا الجهاز (${identity.machineId})`),
        { status: 400 },
      );
    }

    // Enforce monotonic high-watermark across SQLite row, external DPAPI clock, and operational ledger.
    const existingWatermarkValid = this.isWatermarkHmacValid(existingRow, identity.machineId);
    const watermarkBaseline = existingWatermarkValid ? existingRow.last_verified_clock_ms : 0;
    const ledgerMax = ledgerBaseline.maxTimestampMs ?? 0;
    const baselineClockMs = Math.max(watermarkBaseline, this.externalWatermarkMs, ledgerMax, nowMs);

    if (nowMs + CLOCK_SKEW_TOLERANCE_MS < baselineClockMs) {
      throw Object.assign(
        new Error('تاريخ وساعة الجهاز متأخران عن آخر تشغيل موثق — اضبط الساعة أولاً ثم أعد التفعيل'),
        { status: 400 },
      );
    }

    const expiresMs = Date.parse(payload.expiresAt);
    if (nowMs >= expiresMs) {
      throw Object.assign(new Error('انتهت صلاحية كود التفعيل المُدخل ولا يمكن استخدامه'), {
        status: 400,
      });
    }

    await this.updateWatermarkRow(trimmed, baselineClockMs, identity.machineId);
    this.recordWatermarkAdvance(baselineClockMs);
    return this.buildEvaluation('ACTIVE', payload, nowMs, null, identity.machineId);
  }

  public async touchWatermarkOnCheckout(): Promise<LicenseEvaluation> {
    const status = await this.getStatus();
    if (status.status !== 'ACTIVE') {
      throw new LicenseEnforcementError(
        status.status,
        status.reason ?? 'يلزم تفعيل الاشتراك لإتمام العمليات',
      );
    }
    return status;
  }

  public async assertOperationalAccess(): Promise<LicenseEvaluation> {
    const status = await this.getStatus();
    if (status.status !== 'ACTIVE') {
      throw new LicenseEnforcementError(
        status.status,
        status.reason ?? 'يلزم تفعيل الاشتراك لإتمام العمليات',
      );
    }
    return status;
  }

  private async getOperationalLedgerBaseline(): Promise<OperationalLedgerBaseline> {
    const [salesMax, shiftsMax, auditMax] = await Promise.all([
      this.db
        .selectFrom('sales')
        .select((eb) => eb.fn.max('created_at').as('maxTs'))
        .executeTakeFirst(),
      this.db
        .selectFrom('cashier_shifts')
        .select((eb) => eb.fn.max('created_at').as('maxTs'))
        .executeTakeFirst(),
      this.db
        .selectFrom('audit_logs')
        .select((eb) => eb.fn.max('created_at').as('maxTs'))
        .executeTakeFirst(),
    ]);

    const rawValues = [salesMax?.maxTs, shiftsMax?.maxTs, auditMax?.maxTs];
    let hasRecords = false;
    let maxTimestampMs: number | null = null;
    for (const raw of rawValues) {
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        hasRecords = true;
      }
      const parsed = parseLedgerTimestampMs(raw);
      if (parsed !== null && (maxTimestampMs === null || parsed > maxTimestampMs)) {
        maxTimestampMs = parsed;
      }
    }

    return { hasRecords, maxTimestampMs };
  }

  private async ensureWatermarkRow(
    nowMs: number,
    ledgerBaseline: OperationalLedgerBaseline,
    machineId: string,
  ): Promise<SystemLicensingTable | null> {
    const existing = await this.db
      .selectFrom('system_licensing')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
    if (existing) {
      return existing;
    }

    // Refuse to recreate a missing watermark row if business history already exists in SQLite.
    if (ledgerBaseline.hasRecords) {
      return null;
    }

    const initialHmac = this.computeWatermarkHmac(nowMs, null, machineId);
    const nowIso = new Date(nowMs).toISOString();
    await this.db
      .insertInto('system_licensing')
      .values({
        id: 1,
        activation_token: null,
        last_verified_clock_ms: nowMs,
        clock_hmac: initialHmac,
        updated_at: nowIso,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    const created = await this.db
      .selectFrom('system_licensing')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return created;
  }

  private async updateWatermarkRow(
    activationToken: string | null,
    lastVerifiedClockMs: number,
    machineId: string,
  ): Promise<void> {
    const nextHmac = this.computeWatermarkHmac(lastVerifiedClockMs, activationToken, machineId);
    const nowIso = new Date(lastVerifiedClockMs).toISOString();
    await this.db
      .updateTable('system_licensing')
      .set({
        activation_token: activationToken,
        last_verified_clock_ms: lastVerifiedClockMs,
        clock_hmac: nextHmac,
        updated_at: nowIso,
      })
      .where('id', '=', 1)
      .execute();
  }

  private computeWatermarkHmac(
    clockMs: number,
    activationToken: string | null,
    machineId: string,
  ): string {
    return createHmac('sha256', Buffer.from(this.watermarkSecret, 'utf8'))
      .update(`RetailOS-Clock-Watermark-v2:${machineId}:${String(clockMs)}:${activationToken ?? ''}`)
      .digest('hex');
  }

  private isWatermarkHmacValid(row: SystemLicensingTable, machineId: string): boolean {
    const expected = this.computeWatermarkHmac(
      row.last_verified_clock_ms,
      row.activation_token ?? null,
      machineId,
    );
    const actualBuf = Buffer.from(row.clock_hmac || '', 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(actualBuf, expectedBuf);
  }

  private buildEvaluation(
    status: LicenseStatus,
    payload: LicensePayload | null,
    nowMs: number,
    reason: string | null,
    machineId: string,
  ): LicenseEvaluation {
    if (!payload) {
      return {
        status,
        machineId,
        customerName: null,
        planName: null,
        issuedAt: null,
        expiresAt: null,
        daysRemaining: null,
        licenseId: null,
        reason,
      };
    }

    const expiresMs = Date.parse(payload.expiresAt);
    const daysRemaining =
      status === 'ACTIVE' ? computeRemainingDaysCeiling(nowMs, expiresMs) : 0;

    return {
      status,
      machineId,
      customerName: payload.customerName,
      planName: payload.planName,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      daysRemaining,
      licenseId: payload.licenseId,
      reason,
    };
  }
}
