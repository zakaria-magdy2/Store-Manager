import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  computeRemainingDaysCeiling,
  parseLicenseTokenFormat,
  validateLicensePayloadObject,
  type LicenseEvaluation,
  type LicensePayload,
  type LicenseStatus,
} from '@retailos/core';
import { parseNonNegativeRowid } from '../database/migrator.js';
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
  readonly onWatermarkReset?: ((clockMs: number) => void) | undefined;
  readonly machineIdOverride?: string | undefined;
  readonly isHardwareBackedOverride?: boolean | undefined;
  readonly identityProvider?: (() => LicenseMachineIdentityResolution) | undefined;
  readonly nowProvider?: (() => number) | undefined;
}

export interface PasswordResetTokenPayload {
  readonly resetId: string;
  readonly machineId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PasswordResetVerificationResult {
  readonly valid: boolean;
  readonly payload: PasswordResetTokenPayload | null;
  readonly reason: string | null;
  readonly machineId: string;
}

export type ClockResetTokenPayload = PasswordResetTokenPayload;
export type ClockResetVerificationResult = PasswordResetVerificationResult;

interface LedgerRowidCutoffs {
  readonly salesRowid: number;
  readonly shiftsRowid: number;
  readonly auditRowid: number;
}

const ZERO_LEDGER_CUTOFFS: LedgerRowidCutoffs = {
  salesRowid: 0,
  shiftsRowid: 0,
  auditRowid: 0,
};

function readRowCutoffs(row: Partial<Selectable<SystemLicensingTable>> | undefined | null): LedgerRowidCutoffs {
  return {
    salesRowid: parseNonNegativeRowid(row?.ignored_sales_rowid),
    shiftsRowid: parseNonNegativeRowid(row?.ignored_shifts_rowid),
    auditRowid: parseNonNegativeRowid(row?.ignored_audit_rowid),
  };
}

export class LicenseService {
  private readonly publicKeyPem: string;
  private readonly publicKey: KeyObject;
  private readonly watermarkSecret: string;
  private externalWatermarkMs: number;
  private externalWatermarkTampered: boolean;
  private readonly onWatermarkAdvance: ((clockMs: number) => void) | undefined;
  private readonly onWatermarkReset: ((clockMs: number) => void) | undefined;
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
    this.onWatermarkReset = options?.onWatermarkReset;
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

    const rowCutoffs = readRowCutoffs(existingRow);
    const ledgerBaseline = await this.getOperationalLedgerBaseline(rowCutoffs);
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

    const effectiveCutoffs = readRowCutoffs(row);
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
        await this.updateWatermarkRow(null, nextWatermarkMs, identity.machineId, effectiveCutoffs);
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
        await this.updateWatermarkRow(token, nextWatermarkMs, identity.machineId, effectiveCutoffs);
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
      await this.updateWatermarkRow(token, nextWatermarkMs, identity.machineId, effectiveCutoffs);
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

    const rowCutoffs = readRowCutoffs(existingPrecheck);
    const ledgerBaseline = await this.getOperationalLedgerBaseline(rowCutoffs);
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
    const effectiveCutoffs = readRowCutoffs(existingRow);
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

    await this.updateWatermarkRow(trimmed, baselineClockMs, identity.machineId, effectiveCutoffs);
    this.recordWatermarkAdvance(baselineClockMs);
    return this.buildEvaluation('ACTIVE', payload, nowMs, null, identity.machineId);
  }

  public async resetClockWithVendorToken(rawToken: string): Promise<LicenseEvaluation> {
    const verification = this.verifyClockResetToken(rawToken);
    if (!verification.valid || !verification.payload) {
      throw Object.assign(new Error(verification.reason ?? 'كود إعادة ضبط الساعة غير صالح'), {
        status: 400,
      });
    }

    const identity = this.resolveCurrentIdentity();
    const precheckRow = await this.db
      .selectFrom('system_licensing')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();

    if (precheckRow?.activation_token?.trim() && !identity.isHardwareBacked) {
      throw new LicenseHardwareIdentityError();
    }

    const nowMs = this.nowProvider();
    const nowIso = new Date(nowMs).toISOString();
    const resetPayload = verification.payload;
    let newWatermarkMs = nowMs;

    try {
      await this.db.transaction().execute(async (trx) => {
        const [rowInTrx, salesMaxRowid, shiftsMaxRowid, auditMaxRowid] = await Promise.all([
          trx.selectFrom('system_licensing').selectAll().where('id', '=', 1).executeTakeFirst(),
          sql<{ maxId: number | null }>`SELECT COALESCE(MAX(rowid), 0) AS maxId FROM sales`.execute(trx),
          sql<{ maxId: number | null }>`SELECT COALESCE(MAX(rowid), 0) AS maxId FROM cashier_shifts`.execute(trx),
          sql<{ maxId: number | null }>`SELECT COALESCE(MAX(rowid), 0) AS maxId FROM audit_logs`.execute(trx),
        ]);

        const cutoffs: LedgerRowidCutoffs = {
          salesRowid: parseNonNegativeRowid(salesMaxRowid.rows[0]?.maxId),
          shiftsRowid: parseNonNegativeRowid(shiftsMaxRowid.rows[0]?.maxId),
          auditRowid: parseNonNegativeRowid(auditMaxRowid.rows[0]?.maxId),
        };

        const previousWatermarkMs = Math.max(
          rowInTrx?.last_verified_clock_ms ?? 0,
          this.externalWatermarkMs,
        );

        await trx
          .insertInto('used_clock_reset_tokens')
          .values({
            reset_id: resetPayload.resetId,
            machine_id: resetPayload.machineId,
            issued_at: resetPayload.issuedAt,
            applied_at: nowIso,
            previous_watermark_ms: previousWatermarkMs,
            new_watermark_ms: nowMs,
          })
          .execute();

        const preservedToken = rowInTrx?.activation_token?.trim() || null;
        const nextHmac = this.computeWatermarkHmac(
          nowMs,
          preservedToken,
          identity.machineId,
          cutoffs,
        );

        if (rowInTrx) {
          await trx
            .updateTable('system_licensing')
            .set({
              last_verified_clock_ms: nowMs,
              clock_hmac: nextHmac,
              ignored_sales_rowid: cutoffs.salesRowid,
              ignored_shifts_rowid: cutoffs.shiftsRowid,
              ignored_audit_rowid: cutoffs.auditRowid,
              updated_at: nowIso,
            })
            .where('id', '=', 1)
            .execute();
        } else {
          await trx
            .insertInto('system_licensing')
            .values({
              id: 1,
              activation_token: null,
              last_verified_clock_ms: nowMs,
              clock_hmac: nextHmac,
              ignored_sales_rowid: cutoffs.salesRowid,
              ignored_shifts_rowid: cutoffs.shiftsRowid,
              ignored_audit_rowid: cutoffs.auditRowid,
              updated_at: nowIso,
            })
            .execute();
        }
        newWatermarkMs = nowMs;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT')) {
        throw Object.assign(
          new Error('تم استخدام كود إعادة ضبط الساعة هذا من قبل — اطلب كودًا جديدًا من الدعم الفني'),
          { status: 409 },
        );
      }
      throw err;
    }

    this.externalWatermarkMs = newWatermarkMs;
    this.externalWatermarkTampered = false;
    this.onWatermarkReset?.(newWatermarkMs);
    return this.getStatus();
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

  private async getOperationalLedgerBaseline(
    cutoffs: LedgerRowidCutoffs = ZERO_LEDGER_CUTOFFS,
  ): Promise<OperationalLedgerBaseline> {
    const [salesMax, shiftsMax, auditMax] = await Promise.all([
      sql<{ maxTs: string | null }>`
        SELECT MAX(created_at) AS maxTs FROM sales WHERE rowid > ${cutoffs.salesRowid}
      `.execute(this.db),
      sql<{ maxTs: string | null }>`
        SELECT MAX(created_at) AS maxTs FROM cashier_shifts WHERE rowid > ${cutoffs.shiftsRowid}
      `.execute(this.db),
      sql<{ maxTs: string | null }>`
        SELECT MAX(created_at) AS maxTs FROM audit_logs WHERE rowid > ${cutoffs.auditRowid}
      `.execute(this.db),
    ]);

    const rawValues = [
      salesMax.rows[0]?.maxTs,
      shiftsMax.rows[0]?.maxTs,
      auditMax.rows[0]?.maxTs,
    ];
    let hasRecords =
      cutoffs.salesRowid > 0 || cutoffs.shiftsRowid > 0 || cutoffs.auditRowid > 0;
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

    if (!hasRecords) {
      const [anySale, anyShift, anyAudit] = await Promise.all([
        this.db.selectFrom('sales').select('id').limit(1).executeTakeFirst(),
        this.db.selectFrom('cashier_shifts').select('id').limit(1).executeTakeFirst(),
        this.db.selectFrom('audit_logs').select('id').limit(1).executeTakeFirst(),
      ]);
      hasRecords = Boolean(anySale || anyShift || anyAudit);
    }

    return { hasRecords, maxTimestampMs };
  }

  private async ensureWatermarkRow(
    nowMs: number,
    ledgerBaseline: OperationalLedgerBaseline,
    machineId: string,
  ): Promise<Selectable<SystemLicensingTable> | null> {
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
    cutoffs: LedgerRowidCutoffs = ZERO_LEDGER_CUTOFFS,
  ): Promise<void> {
    const nextHmac = this.computeWatermarkHmac(
      lastVerifiedClockMs,
      activationToken,
      machineId,
      cutoffs,
    );
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
    cutoffs: LedgerRowidCutoffs = ZERO_LEDGER_CUTOFFS,
  ): string {
    const hasCutoffs =
      cutoffs.salesRowid > 0 || cutoffs.shiftsRowid > 0 || cutoffs.auditRowid > 0;
    const message = hasCutoffs
      ? `RetailOS-Clock-Watermark-v3:${machineId}:${String(clockMs)}:${activationToken ?? ''}:${String(cutoffs.salesRowid)}:${String(cutoffs.shiftsRowid)}:${String(cutoffs.auditRowid)}`
      : `RetailOS-Clock-Watermark-v2:${machineId}:${String(clockMs)}:${activationToken ?? ''}`;
    return createHmac('sha256', Buffer.from(this.watermarkSecret, 'utf8'))
      .update(message)
      .digest('hex');
  }

  private isWatermarkHmacValid(row: Selectable<SystemLicensingTable>, machineId: string): boolean {
    const expected = this.computeWatermarkHmac(
      row.last_verified_clock_ms,
      row.activation_token ?? null,
      machineId,
      readRowCutoffs(row),
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

  private verifySignedEmergencyToken(
    rawToken: string,
    tokenPrefix: 'ROSRST1' | 'ROSCLK1',
    labelAr: string,
  ): PasswordResetVerificationResult {
    const machineId = this.getMachineId();
    const cleaned = String(rawToken ?? '').trim().replace(/\s+/g, '');
    const parts = cleaned.split('.');
    if (parts.length !== 3 || parts[0] !== tokenPrefix) {
      return {
        valid: false,
        payload: null,
        reason: `صيغة ${labelAr} غير صحيحة — تأكد من نسخ الكود كاملًا (يبدأ بـ ${tokenPrefix}.)`,
        machineId,
      };
    }

    const [, payloadB64u, signatureB64u] = parts;
    if (!payloadB64u || !signatureB64u) {
      return { valid: false, payload: null, reason: `${labelAr} غير مكتمل`, machineId };
    }

    const signingInput = `${tokenPrefix}.${payloadB64u}`;
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signatureB64u, 'base64url');
    } catch {
      return { valid: false, payload: null, reason: `توقيع ${labelAr} غير صالح`, machineId };
    }

    if (signatureBytes.length !== 64) {
      return { valid: false, payload: null, reason: `توقيع ${labelAr} غير صالح`, machineId };
    }

    const verified = verify(null, Buffer.from(signingInput, 'utf8'), this.publicKey, signatureBytes);
    if (!verified) {
      return {
        valid: false,
        payload: null,
        reason: `${labelAr} غير صحيح أو تم التلاعب به`,
        machineId,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payloadB64u, 'base64url').toString('utf8'));
    } catch {
      return { valid: false, payload: null, reason: `بيانات ${labelAr} تالفة`, machineId };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, payload: null, reason: `بيانات ${labelAr} غير صالحة`, machineId };
    }

    const candidate = parsed as Record<string, unknown>;
    const resetId = typeof candidate.resetId === 'string' ? candidate.resetId.trim() : '';
    const tokenMachineId = typeof candidate.machineId === 'string' ? candidate.machineId.trim().toUpperCase() : '';
    const issuedAt = typeof candidate.issuedAt === 'string' ? candidate.issuedAt.trim() : '';
    const expiresAt = typeof candidate.expiresAt === 'string' ? candidate.expiresAt.trim() : '';
    const issuedMs = Date.parse(issuedAt);
    const expiresMs = Date.parse(expiresAt);

    if (!resetId || resetId.length < 8 || !tokenMachineId || !globalThis.Number.isFinite(issuedMs) || !globalThis.Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
      return { valid: false, payload: null, reason: `بيانات ${labelAr} غير مكتملة أو غير صالحة`, machineId };
    }

    if (tokenMachineId !== machineId) {
      return {
        valid: false,
        payload: null,
        reason: `${labelAr} مخصص لجهاز آخر ولا يعمل على هذا الجهاز`,
        machineId,
      };
    }

    const nowMs = this.nowProvider();
    if (nowMs > expiresMs) {
      return {
        valid: false,
        payload: null,
        reason: `انتهت صلاحية ${labelAr} — اطلب كودًا جديدًا من الدعم الفني`,
        machineId,
      };
    }
    if (nowMs + CLOCK_SKEW_TOLERANCE_MS < issuedMs) {
      return {
        valid: false,
        payload: null,
        reason: 'ساعة الجهاز متأخرة عن وقت إصدار الكود — اضبط تاريخ ووقت الجهاز وحاول مجددًا',
        machineId,
      };
    }

    return {
      valid: true,
      payload: { resetId, machineId: tokenMachineId, issuedAt, expiresAt },
      reason: null,
      machineId,
    };
  }

  public verifyPasswordResetToken(rawToken: string): PasswordResetVerificationResult {
    return this.verifySignedEmergencyToken(rawToken, 'ROSRST1', 'كود الطوارئ');
  }

  public verifyClockResetToken(rawToken: string): ClockResetVerificationResult {
    return this.verifySignedEmergencyToken(rawToken, 'ROSCLK1', 'كود إعادة ضبط الساعة');
  }
}
