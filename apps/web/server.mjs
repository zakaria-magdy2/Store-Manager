import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { Transform } from 'node:stream';
import { createReadStream, createWriteStream, existsSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  AuthService,
  CatalogService,
  CheckoutService,
  InventoryService,
  ScopedExecutionContext,
  TenantService,
} from '@retailos/application';
import { Cart, DomainError, Money, Permissions, SalePayment, User } from '@retailos/core';
import {
  Argon2PasswordHasher,
  CryptoTokenService,
  DatabaseMigrator,
  SqliteCategoryRepository,
  SqliteDatabaseManager,
  SqliteExpenseRepository,
  SqliteReturnRepository,
  SqliteRecurringExpenseRepository,
  SqliteSupplierReturnRepository,
  SqliteAuditLogRepository,
  SqliteInventoryRepository,
  SqliteProductRepository,
  SqliteProductVariantRepository,
  SqlitePurchasingRepository,
  SqliteSaleRepository,
  SqliteSessionRepository,
  SqliteStockMovementRepository,
  SqliteStoreRepository,
  SqliteTenantRepository,
  SqliteUserRepository,
  createEncryptedSqliteBackup,
  backupDownloadName,
  removeBackupArtifact,
  installPreparedSqliteRestore,
  prepareEncryptedSqliteRestore,
  preparePlainSqliteRestore,
  recoverPendingSqliteRestore,
  checkSqliteFileQuick,
  EscPosReceiptPrinter,
  businessDateInTimeZone,
  resolveValidTimeZone,
  accountDefaults,
  postJournalEntry,
  applyStockMovementInTransaction,
  allocateDocumentNumberInTransaction,
  LicenseEnforcementError,
  LicenseHardwareIdentityError,
  LicenseService,
} from '@retailos/infrastructure';
import {
  CreateProductSchema,
  CreateUserSchema,
  ProductAttributesSchema,
  ProductImagePathSchema,
  ProductOptionSchema,
  UpdateProductSchema,
} from '@retailos/shared';
import { z } from 'zod';
import { isPreviewResetConfiguration, resetDevelopmentOperationalData } from './dev-data-reset.mjs';

const serverFilePath = fileURLToPath(import.meta.url);

function isValidDailyBackupPassphrase(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 12 || trimmed.length > 256) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function normalizeDailyBackupHistoryInput(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (isValidDailyBackupPassphrase(trimmed) && !out.includes(trimmed)) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

async function resolveHostStartupSecrets(options = {}) {
  const optWatermark = typeof options.watermarkSecret === 'string' ? options.watermarkSecret.trim() : '';
  const optDailyBackup = typeof options.dailyBackupSecret === 'string' ? options.dailyBackupSecret.trim() : '';
  const optDailyHistory = normalizeDailyBackupHistoryInput(options.dailyBackupKeyHistory);
  const optExternalClockMs =
    typeof options.externalWatermarkMs === 'number' &&
    Number.isSafeInteger(options.externalWatermarkMs) &&
    options.externalWatermarkMs > 0
      ? options.externalWatermarkMs
      : 0;
  const optExternalTampered = Boolean(options.externalWatermarkTampered);

  if (optWatermark.length >= 32) {
    return {
      watermarkSecret: optWatermark,
      dailyBackupSecret: isValidDailyBackupPassphrase(optDailyBackup) ? optDailyBackup : randomBytes(32).toString('base64url'),
      dailyBackupKeyHistory: optDailyHistory,
      externalClockMs: optExternalClockMs,
      externalClockTampered: optExternalTampered,
      hostChannel: null,
      closeHostChannel: null,
    };
  }

  if (process.argv.includes('--electron-stdio-secret')) {
    const handshake = await new Promise((resolvePromise, rejectPromise) => {
      let buffer = '';
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        process.stdin.off('error', onError);
      };
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          process.stdin.pause();
          rejectPromise(err);
        } else {
          resolvePromise(val);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('Fatal: RetailOS server timed out waiting for desktop host secret'));
      }, 5000);
      const onData = (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (buffer.length > 16384 && !buffer.includes('\n')) {
          finish(new Error('Fatal: RetailOS desktop secret payload exceeded limit'));
          return;
        }
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx !== -1) {
          finish(null, {
            line: buffer.slice(0, nlIdx).trim(),
            remainder: buffer.slice(nlIdx + 1),
          });
        }
      };
      const onEnd = () => {
        const trimmed = buffer.trim();
        if (trimmed) finish(null, { line: trimmed, remainder: '', stdinEnded: true });
        else finish(new Error('Fatal: RetailOS server must be launched via the desktop host'));
      };
      const onError = () => {
        finish(new Error('Fatal: RetailOS server failed reading desktop host secret'));
      };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);
      process.stdin.resume();
    });

    try {
      const parsed = JSON.parse(handshake.line);
      const parsedSecret = typeof parsed?.watermarkSecret === 'string' ? parsed.watermarkSecret.trim() : '';
      const parsedDaily =
        typeof parsed?.dailyBackupSecret === 'string' ? parsed.dailyBackupSecret.trim().slice(0, 256) : '';
      const parsedDailyHistory = normalizeDailyBackupHistoryInput(parsed?.dailyBackupKeyHistory);
      if (parsedSecret.length >= 32 && isValidDailyBackupPassphrase(parsedDaily)) {
        const parsedExtClock =
          typeof parsed?.externalClockMs === 'number' &&
          Number.isSafeInteger(parsed.externalClockMs) &&
          parsed.externalClockMs > 0
            ? parsed.externalClockMs
            : 0;

        const DAILY_KEY_REQ_PREFIX = '__RETAILOS_DAILY_KEY_UPDATE_REQ__:';
        const DAILY_KEY_ACK_PREFIX = '__RETAILOS_DAILY_KEY_UPDATE_ACK__:';
        const pendingDailyKeyAcks = new Map();
        let controlBuffer = handshake.remainder ?? '';
        let channelClosed = Boolean(handshake.stdinEnded);

        const rejectAllPendingAcks = (err) => {
          for (const [reqId, pending] of pendingDailyKeyAcks.entries()) {
            pendingDailyKeyAcks.delete(reqId);
            clearTimeout(pending.timer);
            pending.reject(err);
          }
        };

        const processControlBuffer = () => {
          let nlIndex = controlBuffer.indexOf('\n');
          while (nlIndex !== -1) {
            const controlLine = controlBuffer.slice(0, nlIndex).replace(/\r$/, '');
            controlBuffer = controlBuffer.slice(nlIndex + 1);
            if (controlLine.startsWith(DAILY_KEY_ACK_PREFIX)) {
              try {
                const ack = JSON.parse(controlLine.slice(DAILY_KEY_ACK_PREFIX.length).trim());
                if (ack && typeof ack.requestId === 'string') {
                  const pending = pendingDailyKeyAcks.get(ack.requestId);
                  if (pending) {
                    pendingDailyKeyAcks.delete(ack.requestId);
                    clearTimeout(pending.timer);
                    if (ack.ok === true) {
                      pending.resolve({
                        historyCount: typeof ack.historyCount === 'number' ? ack.historyCount : undefined,
                      });
                    } else {
                      pending.reject(
                        Object.assign(
                          new Error(ack.error || 'فشل تأكيد حفظ مفتاح النسخ الاحتياطي داخل مخزن النظام الآمن (DPAPI)'),
                          { status: 503, code: 'BACKUP_KEY_PERSIST_FAILED', exposeMessage: true },
                        ),
                      );
                    }
                  }
                }
              } catch {
                // Ignore malformed ACK payload
              }
            }
            nlIndex = controlBuffer.indexOf('\n');
          }
        };

        const hostChannel = {
          active: true,
          supportsKeyPersistAck: Boolean(parsed?.supportsKeyPersistAck),
          connected: !channelClosed,
          requestDailyKeyPersist(nextPassphrase, timeoutMs = 10_000) {
            if (channelClosed || !hostChannel.connected) {
              return Promise.reject(
                Object.assign(
                  new Error('انقطع اتصال حفظ مفتاح التشفير مع نافذة التطبيق الرئيسية — لم يتم تعديل المفتاح أو النسخة'),
                  { status: 503, code: 'BACKUP_KEY_PERSIST_DISCONNECTED', exposeMessage: true },
                ),
              );
            }
            if (!hostChannel.supportsKeyPersistAck) {
              return Promise.reject(
                Object.assign(
                  new Error('نافذة التطبيق الرئيسية لا تدعم بروتوكول تأكيد حفظ مفتاح التشفير'),
                  { status: 503, code: 'BACKUP_KEY_PERSIST_UNSUPPORTED', exposeMessage: true },
                ),
              );
            }
            const requestId = randomUUID();
            const encodedKey = Buffer.from(nextPassphrase, 'utf8').toString('base64url');
            return new Promise((resolveAck, rejectAck) => {
              const timer = setTimeout(() => {
                pendingDailyKeyAcks.delete(requestId);
                rejectAck(
                  Object.assign(
                    new Error('انتهت مهلة تأكيد حفظ مفتاح النسخ الاحتياطي داخل نظام الحماية (DPAPI) — لم يتم تعديل المفتاح أو النسخة'),
                    { status: 504, code: 'BACKUP_KEY_PERSIST_TIMEOUT', exposeMessage: true },
                  ),
                );
              }, timeoutMs);
              timer.unref?.();
              pendingDailyKeyAcks.set(requestId, {
                resolve: resolveAck,
                reject: rejectAck,
                timer,
              });
              try {
                process.stdout.write(
                  `${DAILY_KEY_REQ_PREFIX}${JSON.stringify({ requestId, key: encodedKey })}\n`,
                );
              } catch (writeErr) {
                clearTimeout(timer);
                pendingDailyKeyAcks.delete(requestId);
                rejectAck(
                  Object.assign(
                    new Error('تعذر إرسال طلب حفظ مفتاح التشفير إلى التطبيق الرئيسي'),
                    { status: 503, code: 'BACKUP_KEY_PERSIST_DISCONNECTED', exposeMessage: true, cause: writeErr },
                  ),
                );
              }
            });
          },
          close() {
            if (channelClosed) return;
            channelClosed = true;
            hostChannel.connected = false;
            rejectAllPendingAcks(
              Object.assign(
                new Error('أُغلق اتصال التطبيق الرئيسي قبل تأكيد حفظ مفتاح النسخ الاحتياطي'),
                { status: 503, code: 'BACKUP_KEY_PERSIST_DISCONNECTED', exposeMessage: true },
              ),
            );
            process.stdin.off('data', onControlData);
            process.stdin.off('end', onControlDisconnect);
            process.stdin.off('close', onControlDisconnect);
            process.stdin.off('error', onControlDisconnect);
            process.stdin.pause();
          },
        };

        const onControlData = (chunk) => {
          controlBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (controlBuffer.length > 65536 && !controlBuffer.includes('\n')) {
            controlBuffer = '';
            return;
          }
          processControlBuffer();
        };
        const onControlDisconnect = () => {
          hostChannel.close();
        };

        if (!channelClosed) {
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', onControlData);
          process.stdin.on('end', onControlDisconnect);
          process.stdin.on('close', onControlDisconnect);
          process.stdin.on('error', onControlDisconnect);
          process.stdin.resume();
          process.stdin.unref?.();
          if (controlBuffer.length > 0) {
            processControlBuffer();
          }
        } else {
          process.stdin.pause();
        }

        return {
          watermarkSecret: parsedSecret,
          dailyBackupSecret: parsedDaily,
          dailyBackupKeyHistory: parsedDailyHistory,
          externalClockMs: parsedExtClock,
          externalClockTampered: Boolean(parsed?.externalClockTampered),
          hostChannel,
          closeHostChannel: () => hostChannel.close(),
        };
      }
    } catch {
      // Fall through to fail-closed error below
    }
    process.stdin.pause();
    throw new Error('Fatal: RetailOS server must be launched via the desktop host');
  }

  throw new Error('Fatal: RetailOS server must be launched via the desktop host');
}

export async function createServerApp(options = {}) {
const hostSecrets = await resolveHostStartupSecrets(options);
const watermarkSecret = hostSecrets.watermarkSecret;
let dailyBackupSecret = hostSecrets.dailyBackupSecret;
const historicalDailyBackupKeys = [];
function addHistoricalDailyBackupKey(key) {
  const normalized = typeof key === 'string' ? key.trim() : '';
  if (!isValidDailyBackupPassphrase(normalized)) return;
  if (normalized === dailyBackupSecret) return;
  if (!historicalDailyBackupKeys.includes(normalized)) {
    historicalDailyBackupKeys.push(normalized);
  }
}
for (const oldKey of hostSecrets.dailyBackupKeyHistory ?? []) {
  addHistoricalDailyBackupKey(oldKey);
}
let latestExternalClockMs = hostSecrets.externalClockMs;
const appDir = dirname(serverFilePath);
const publicDir = resolve(appDir, 'public');
const defaultDataDir = appDir.endsWith(`${sep}dist`) ? resolve(appDir, '..', 'data') : join(appDir, 'data');
const dataDir = resolve(process.env.RETAILOS_DATA_DIR ?? defaultDataDir);
const companyConfig = {
  name: process.env.RETAILOS_COMPANY_NAME ?? 'متجري',
  code: process.env.RETAILOS_COMPANY_CODE ?? 'STORE',
  currency: process.env.RETAILOS_CURRENCY ?? 'EGP',
  timezone: resolveValidTimeZone(process.env.RETAILOS_TIMEZONE ?? 'Africa/Cairo'),
  storeName: process.env.RETAILOS_STORE_NAME ?? 'الفرع الرئيسي',
  storeCode: process.env.RETAILOS_STORE_CODE ?? 'MAIN',
};
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const origin = `http://127.0.0.1:${port}`;
const databasePath = process.env.RETAILOS_DB_PATH ? resolve(process.env.RETAILOS_DB_PATH) : join(dataDir, 'retailos.sqlite');
const previewMarkerPath = join(appDir, 'preview-reset-mode.js');
const developmentResetEnabled = isPreviewResetConfiguration({
  previewMarkerExists: existsSync(previewMarkerPath) || Boolean(options.betaTrialConfig?.enabled),
  dataDir: options.betaTrialConfig?.enabled ? dataDir : process.env.RETAILOS_DATA_DIR,
  databasePath,
  electronRuntime: process.argv.includes('--electron-stdio-secret') || Boolean(options.betaTrialConfig?.enabled),
});
let betaTrialConfig = options.betaTrialConfig?.enabled ? options.betaTrialConfig : null;
if (!betaTrialConfig && developmentResetEnabled && existsSync(previewMarkerPath)) {
  try {
    const mod = await import(pathToFileURL(previewMarkerPath).href);
    if (mod?.PREVIEW_RESET_MODE === true) {
      betaTrialConfig = {
        enabled: true,
        autoLogin: mod.BETA_AUTO_LOGIN === true,
        issuedAt: typeof mod.BETA_BUILD_ISSUED_AT === 'string' ? mod.BETA_BUILD_ISSUED_AT : null,
        expiresAt: typeof mod.BETA_BUILD_EXPIRES_AT === 'string' ? mod.BETA_BUILD_EXPIRES_AT : null,
      };
    }
  } catch { /* ignore unreadable marker */ }
}
const betaAutoLoginEnabled = Boolean(developmentResetEnabled && betaTrialConfig?.autoLogin && betaTrialConfig?.expiresAt);
const betaIssuedAtMs = betaTrialConfig?.issuedAt ? Date.parse(betaTrialConfig.issuedAt) : 0;
const betaExpiresAtMs = betaTrialConfig?.expiresAt ? Date.parse(betaTrialConfig.expiresAt) : 0;

function evaluateBetaTrialStatus() {
  const nowMs = typeof options.nowProvider === 'function' ? options.nowProvider() : Date.now();
  if (!Number.isFinite(betaExpiresAtMs) || betaExpiresAtMs <= 0) {
    return {
      status: 'EXPIRED',
      daysRemaining: 0,
      expiresAt: null,
      planName: 'نسخة Beta تجريبية (7 أيام)',
      customerName: 'نسخة تجريبية Beta',
      machineId: 'BETA-TRIAL-7D',
      message: 'صلاحية النسخة التجريبية غير صالحة.',
    };
  }
  if (Number.isFinite(betaIssuedAtMs) && betaIssuedAtMs > 0 && nowMs + 5 * 60 * 1000 < betaIssuedAtMs) {
    return {
      status: 'CLOCK_TAMPERED',
      daysRemaining: 0,
      expiresAt: new Date(betaExpiresAtMs).toISOString(),
      planName: 'نسخة Beta تجريبية (7 أيام)',
      customerName: 'نسخة تجريبية Beta',
      machineId: 'BETA-TRIAL-7D',
      message: 'تم رصد رجوع ساعة الجهاز للخلف — يرجى ضبط التاريخ والوقت الصحيح.',
    };
  }
  if (nowMs > betaExpiresAtMs) {
    return {
      status: 'EXPIRED',
      daysRemaining: 0,
      expiresAt: new Date(betaExpiresAtMs).toISOString(),
      planName: 'نسخة Beta تجريبية (7 أيام)',
      customerName: 'نسخة تجريبية Beta',
      machineId: 'BETA-TRIAL-7D',
      message: 'انتهت صلاحية النسخة التجريبية Beta (7 أيام). تواصل مع الدعم للحصول على النسخة الكاملة.',
    };
  }
  const daysRemaining = Math.max(0, Math.ceil((betaExpiresAtMs - nowMs) / (24 * 60 * 60 * 1000)));
  return {
    status: 'ACTIVE',
    daysRemaining,
    expiresAt: new Date(betaExpiresAtMs).toISOString(),
    planName: 'نسخة Beta تجريبية (7 أيام)',
    customerName: 'نسخة تجريبية Beta',
    machineId: 'BETA-TRIAL-7D',
  };
}
const backupBaseDir = process.env.RETAILOS_BACKUP_DIR ? resolve(process.env.RETAILOS_BACKUP_DIR) : join(dataDir, 'backups');
const dailyBackupDir = join(backupBaseDir, 'daily');
const preRestoreBackupDir = join(backupBaseDir, 'pre-restore');
const quarantineBackupDir = join(backupBaseDir, 'quarantine');
const backupSettingsPath = join(dataDir, 'backup-settings.json');
const MAX_DAILY_BACKUPS = 30;
const AUTO_DAILY_REFRESH_MS = 30 * 60 * 1000;
await mkdir(dataDir, { recursive: true });
await mkdir(dirname(databasePath), { recursive: true });
await mkdir(dailyBackupDir, { recursive: true });
await mkdir(preRestoreBackupDir, { recursive: true });
const restoredAfterCrash = await recoverPendingSqliteRestore(dataDir, databasePath);

function resolveDailyBackupPassphraseSync() {
  if (isValidDailyBackupPassphrase(dailyBackupSecret)) {
    return dailyBackupSecret.trim();
  }
  const envKey = (process.env.RETAILOS_DAILY_BACKUP_KEY ?? '').trim();
  if (isValidDailyBackupPassphrase(envKey)) return envKey;
  throw new Error('Fatal: Daily backup passphrase must be supplied by the desktop host');
}

function resolveDailyBackupCandidatePassphrases() {
  const candidates = [];
  try {
    candidates.push(resolveDailyBackupPassphraseSync());
  } catch {
    // ignore if unavailable
  }
  const envKey = (process.env.RETAILOS_DAILY_BACKUP_KEY ?? '').trim();
  if (isValidDailyBackupPassphrase(envKey) && !candidates.includes(envKey)) {
    candidates.push(envKey);
  }
  for (const prev of historicalDailyBackupKeys) {
    if (!candidates.includes(prev)) candidates.push(prev);
  }
  return candidates;
}

let activeDailyKeyPersistPromise = null;
async function persistDailyBackupMasterPassphrase(nextPassphrase) {
  const trimmed = typeof nextPassphrase === 'string' ? nextPassphrase.trim() : '';
  if (!isValidDailyBackupPassphrase(trimmed)) {
    throw Object.assign(new Error('كلمة مرور النسخ الاحتياطي يجب أن تكون بين 12 و 256 حرفًا صالحًا'), { status: 400 });
  }
  if (activeDailyKeyPersistPromise) {
    throw Object.assign(
      new Error('توجد عملية حفظ جارية لمفتاح النسخ الاحتياطي — انتظر اكتمالها ثم أعد المحاولة'),
      { status: 409, code: 'BACKUP_KEY_PERSIST_IN_PROGRESS', exposeMessage: true },
    );
  }
  if (trimmed === dailyBackupSecret) {
    return {
      changed: false,
      persisted: true,
      dailyBackupSecret: trimmed,
      historicalKeysCount: historicalDailyBackupKeys.length,
    };
  }

  const runPersist = (async () => {
    if (activeBackupPromise) {
      await activeBackupPromise.catch(() => undefined);
    }
    const previousSecret = dailyBackupSecret;
    const nextHistoryPreview = [...historicalDailyBackupKeys];
    if (
      isValidDailyBackupPassphrase(previousSecret) &&
      previousSecret !== trimmed &&
      !nextHistoryPreview.includes(previousSecret)
    ) {
      nextHistoryPreview.push(previousSecret);
    }

    const persistTimeoutMs =
      Number.isInteger(options.dailyBackupKeyPersistTimeoutMs) &&
      options.dailyBackupKeyPersistTimeoutMs > 0
        ? options.dailyBackupKeyPersistTimeoutMs
        : 10_000;

    if (process.argv.includes('--electron-stdio-secret')) {
      if (!hostSecrets.hostChannel?.connected || !hostSecrets.hostChannel?.supportsKeyPersistAck) {
        throw Object.assign(
          new Error('تعذر تأكيد حفظ مفتاح النسخ الاحتياطي عبر التطبيق الرئيسي — أعد تشغيل البرنامج ثم حاول مجددًا'),
          { status: 503, code: 'BACKUP_KEY_PERSIST_DISCONNECTED', exposeMessage: true },
        );
      }
      await hostSecrets.hostChannel.requestDailyKeyPersist(trimmed, persistTimeoutMs);
    } else if (typeof options.onDailyBackupSecretUpdate === 'function') {
      let timeoutHandle = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => options.onDailyBackupSecretUpdate(trimmed, nextHistoryPreview)),
          new Promise((_, rejectPromise) => {
            timeoutHandle = setTimeout(() => {
              rejectPromise(
                Object.assign(
                  new Error('انتهت مهلة تأكيد حفظ مفتاح النسخ الاحتياطي — لم يتم تعديل المفتاح أو النسخة'),
                  { status: 504, code: 'BACKUP_KEY_PERSIST_TIMEOUT', exposeMessage: true },
                ),
              );
            }, persistTimeoutMs);
            timeoutHandle.unref?.();
          }),
        ]);
      } catch (persistErr) {
        if (persistErr && typeof persistErr === 'object' && 'status' in persistErr) {
          persistErr.exposeMessage = true;
          throw persistErr;
        }
        throw Object.assign(
          new Error(
            persistErr instanceof Error && persistErr.message
              ? persistErr.message
              : 'فشل تأكيد حفظ مفتاح النسخ الاحتياطي داخل مخزن النظام الآمن',
          ),
          { status: 503, code: 'BACKUP_KEY_PERSIST_FAILED', exposeMessage: true, cause: persistErr },
        );
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } else if (process.env.NODE_ENV !== 'test') {
      throw Object.assign(
        new Error('لا يمكن حفظ مفتاح النسخ الاحتياطي الرئيسي بدون قناة حفظ آمنة مع التطبيق الرئيسي'),
        { status: 503, code: 'BACKUP_KEY_PERSIST_UNAVAILABLE', exposeMessage: true },
      );
    }

    dailyBackupSecret = trimmed;
    addHistoricalDailyBackupKey(previousSecret);
    return {
      changed: true,
      persisted: true,
      dailyBackupSecret: trimmed,
      historicalKeysCount: historicalDailyBackupKeys.length,
    };
  })();

  activeDailyKeyPersistPromise = runPersist;
  try {
    return await runPersist;
  } finally {
    if (activeDailyKeyPersistPromise === runPersist) {
      activeDailyKeyPersistPromise = null;
    }
  }
}

async function readBackupSettings() {
  const defaults = { mirrorPath: '', autoMirror: true, lastMirrorAt: null, lastMirrorStatus: 'UNCONFIGURED', lastMirrorError: null };
  try {
    if (!existsSync(backupSettingsPath)) return defaults;
    const parsed = JSON.parse(await readFile(backupSettingsPath, 'utf8'));
    const mirrorPath = typeof parsed.mirrorPath === 'string' ? parsed.mirrorPath.trim() : '';
    const autoMirror = parsed.autoMirror !== false;
    return {
      mirrorPath,
      autoMirror,
      lastMirrorAt: typeof parsed.lastMirrorAt === 'string' ? parsed.lastMirrorAt : null,
      lastMirrorStatus: mirrorPath ? (parsed.lastMirrorStatus || 'PENDING') : 'UNCONFIGURED',
      lastMirrorError: typeof parsed.lastMirrorError === 'string' ? parsed.lastMirrorError : null,
    };
  } catch {
    return defaults;
  }
}

async function writeBackupSettings(nextSettings) {
  const tempPath = join(dataDir, `.tmp-backup-settings-${randomUUID().slice(0, 8)}.json`);
  await writeFile(tempPath, JSON.stringify(nextSettings, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, backupSettingsPath);
}

async function findNewestVerifiedCandidate(extraDirs = []) {
  const dirs = [dailyBackupDir, ...extraDirs.filter(Boolean)];
  const candidates = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const name of files) {
        if (/^retailos-daily-\d{4}-\d{2}-\d{2}\.(rfbackup|sqlite)$/.test(name) || name === 'retailos-latest.rfbackup' || name === 'retailos-latest.sqlite') {
          const full = join(dir, name);
          const s = await stat(full).catch(() => null);
          if (s && s.size > 0) candidates.push({ path: full, name, mtimeMs: s.mtimeMs, encrypted: name.endsWith('.rfbackup') });
        }
      }
    } catch { /* ignore unreadable external path */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of candidates) {
    if (item.encrypted) {
      for (const passphrase of resolveDailyBackupCandidatePassphrases()) {
        try {
          const archive = await readFile(item.path);
          const { decryptBackupArchive } = await import('@retailos/infrastructure');
          const sqliteBytes = decryptBackupArchive(archive, passphrase);
          const tempWork = await mkdtemp(join(quarantineBackupDir, 'recover-'));
          const decryptedPath = join(tempWork, 'candidate.sqlite');
          await writeFile(decryptedPath, sqliteBytes, { mode: 0o600 });
          const quick = checkSqliteFileQuick(decryptedPath);
          if (quick.ok) return { ...item, path: decryptedPath, cleanupDir: tempWork };
          await rm(tempWork, { recursive: true, force: true }).catch(() => undefined);
        } catch { /* try historical or older candidate */ }
      }
      continue;
    }
    const quick = checkSqliteFileQuick(item.path);
    if (quick.ok) return item;
  }
  return null;
}

const database = new SqliteDatabaseManager({ filename: databasePath });
let startupRecoveryInfo = null;
let initialIntegrityStatus = { ok: true, messages: ['ok'], checkedAt: new Date().toISOString() };
try {
  database.connect();
  initialIntegrityStatus = { ...database.checkQuickIntegrity(), checkedAt: new Date().toISOString() };
  if (!initialIntegrityStatus.ok) {
    throw new Error(`Quick integrity check failed: ${initialIntegrityStatus.messages.join('; ')}`);
  }
} catch (startupError) {
  await database.close().catch(() => undefined);
  const initialSettings = await readBackupSettings();
  const candidate = await findNewestVerifiedCandidate([initialSettings.mirrorPath]);
  if (!candidate) throw startupError;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantineTargetDir = join(quarantineBackupDir, stamp);
    await mkdir(quarantineTargetDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${databasePath}${suffix}`;
      if (existsSync(src)) {
        await rename(src, join(quarantineTargetDir, `retailos.sqlite${suffix}`)).catch(async () => {
          await copyFile(src, join(quarantineTargetDir, `retailos.sqlite${suffix}`)).catch(() => undefined);
          await rm(src, { force: true }).catch(() => undefined);
        });
      }
    }
    await copyFile(candidate.path, databasePath);
    database.connect();
    initialIntegrityStatus = { ...database.checkQuickIntegrity(), checkedAt: new Date().toISOString() };
    startupRecoveryInfo = {
      recovered: true,
      restoredFrom: candidate.name,
      quarantinedAt: quarantineTargetDir,
      reason: startupError instanceof Error ? startupError.message : String(startupError),
      at: new Date().toISOString(),
    };
    console.warn(`[RetailOS Recovery] Restored damaged database automatically from ${candidate.name}`);
  } finally {
    if (candidate.cleanupDir) {
      await rm(candidate.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
const db = database.getDb();
const migration = await new DatabaseMigrator(db).migrateToLatest();
if (!migration.success) throw migration.error ?? new Error('Database migration failed');

/** Allocates a monotonically increasing, collision-free document number inside Kysely's serialized transaction queue. */
async function allocateNextDocNumber(tenantId, docType, prefix, existingTable, existingCol, trx = null) {
  const config = { tenantId, docType, prefix, existingTable, existingCol };
  return trx
    ? allocateDocumentNumberInTransaction(trx, config)
    : db.transaction().execute((executor) => allocateDocumentNumberInTransaction(executor, config));
}

function generateNextSaleNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'SALE', 'INV-', 'sales', 'sale_number', trx);
}

function generateNextShiftNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'SHIFT', 'SH-', 'cashier_shifts', 'shift_number', trx);
}

function generateNextReturnNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'RETURN', 'RET-', 'customer_returns', 'return_number', trx);
}

function generateNextStocktakeNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'STOCKTAKE', 'STK-', 'stocktake_sessions', 'session_number', trx);
}
if (restoredAfterCrash) {
  await db.updateTable('sessions').set({ is_revoked: 1 }).execute();
  console.warn('A database restore was recovered; all prior login sessions were revoked.');
}

const tenantRepo = new SqliteTenantRepository(db);
const storeRepo = new SqliteStoreRepository(db);
const userRepo = new SqliteUserRepository(db);
const sessionRepo = new SqliteSessionRepository(db);
const categoryRepo = new SqliteCategoryRepository(db);
const productRepo = new SqliteProductRepository(db);
const variantRepo = new SqliteProductVariantRepository(db);
const inventoryRepo = new SqliteInventoryRepository(db);
const movementRepo = new SqliteStockMovementRepository(db);
const saleRepo = new SqliteSaleRepository(db);
const passwordHasher = new Argon2PasswordHasher();
const tokenService = new CryptoTokenService();
const auth = new AuthService(tenantRepo, userRepo, sessionRepo, passwordHasher, tokenService);
const tenantService = new TenantService(tenantRepo, storeRepo, userRepo, passwordHasher);
const catalog = new CatalogService(categoryRepo, productRepo, variantRepo);
const inventory = new InventoryService(inventoryRepo, movementRepo, variantRepo, storeRepo, tenantRepo);
const checkout = new CheckoutService(saleRepo, saleRepo, variantRepo, productRepo, storeRepo, tenantRepo);
const purchasing = new SqlitePurchasingRepository(db);
const expenses = new SqliteExpenseRepository(db);
const returns = new SqliteReturnRepository(db);
const licenseService = new LicenseService(db, {
  publicKeyPem: typeof options.licensePublicKey === 'string' ? options.licensePublicKey : undefined,
  watermarkSecret,
  externalWatermarkMs: latestExternalClockMs,
  externalWatermarkTampered: hostSecrets.externalClockTampered,
  onWatermarkAdvance: (clockMs) => {
    if (clockMs > latestExternalClockMs) {
      latestExternalClockMs = clockMs;
      if (process.argv.includes('--electron-stdio-secret')) {
        process.stdout.write(`__RETAILOS_CLOCK_ADVANCE__:${String(clockMs)}\n`);
      }
      options.onWatermarkAdvance?.(clockMs);
    }
  },
  identityProvider: typeof options.licenseIdentityProvider === 'function' ? options.licenseIdentityProvider : undefined,
  nowProvider: typeof options.nowProvider === 'function' ? options.nowProvider : undefined,
});

async function readDeviceLicenseStateForRestore() {
  const row = await db.selectFrom('system_licensing').selectAll().where('id', '=', 1).executeTakeFirst();
  if (!row) {
    throw Object.assign(new Error('تعذر تأمين حالة ترخيص هذا الجهاز؛ لم تبدأ الاستعادة'), { status: 503 });
  }
  return row;
}

const recurringExpenses = new SqliteRecurringExpenseRepository(db);
const supplierReturnsRepo = new SqliteSupplierReturnRepository(db);
const auditLogs = new SqliteAuditLogRepository(db);

async function recordAudit(ctx, details) {
  const actor = details.actorUsername
    ? { username: details.actorUsername }
    : await db.selectFrom('users').select('username').where('tenant_id', '=', ctx.tenantId).where('id', '=', ctx.userId).executeTakeFirst();
  await auditLogs.record(ctx, {
    storeId: details.storeId ?? ctx.storeId ?? null,
    actorUserId: details.actorUserId === undefined ? (ctx.userId === 'system' ? null : ctx.userId) : details.actorUserId,
    actorUsername: actor?.username ?? 'system',
    actorRole: details.actorRole ?? ctx.roleId,
    action: details.action,
    entityType: details.entityType,
    entityId: details.entityId ?? null,
    summary: details.summary,
    metadata: details.metadata ?? {},
  });
}

if ((await tenantRepo.listAll()).length === 0) {
  const tenantId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('tenants').values({ id: tenantId, name: companyConfig.name, code: companyConfig.code, currency: companyConfig.currency, timezone: companyConfig.timezone }).execute();
    await trx.insertInto('stores').values({ id: randomUUID(), tenant_id: tenantId, name: companyConfig.storeName, code: companyConfig.storeCode, address: null, phone: null }).execute();
  });
} else {
  const existing = (await tenantRepo.listAll())[0];
  if (process.env.RETAILOS_COMPANY_NAME) {
    await db.updateTable('tenants').set({ name: process.env.RETAILOS_COMPANY_NAME }).where('id', '=', existing.id).execute();
    if (process.env.RETAILOS_STORE_NAME) await db.updateTable('stores').set({ name: process.env.RETAILOS_STORE_NAME }).where('tenant_id', '=', existing.id).where('code', '=', companyConfig.storeCode).execute();
  }
  if (process.env.RETAILOS_TIMEZONE) {
    await db.updateTable('tenants').set({ timezone: companyConfig.timezone }).where('id', '=', existing.id).execute();
  }
}

const OwnerSchema = z.object({
  ownerUsername: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/).trim(),
  ownerName: z.string().min(2).max(100).trim(),
  password: z.string().min(12).max(128),
  dailyBackupPassphrase: z
    .string()
    .trim()
    .max(256)
    .optional()
    .refine((value) => !value || isValidDailyBackupPassphrase(value), {
      message: 'كلمة مرور النسخ الاحتياطي الرئيسية يجب أن تكون 12 حرفًا صالحة على الأقل',
    }),
});
const CheckoutPaymentMethodSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => ['CASH', 'CARD', 'MOBILE', 'WALLET', 'OTHER'].includes(v), {
    message: 'طريقة الدفع غير مدعومة',
  })
  .transform((v) => (v === 'WALLET' ? 'MOBILE' : v));

const CheckoutMinorAmountSchema = z
  .union([
    z.string().regex(/^\d{1,15}$/),
    z.number().int().min(0).max(999999999999999),
  ])
  .transform((v) => String(v));

const CheckoutTenderSchema = z
  .object({
    method: CheckoutPaymentMethodSchema,
    amount: CheckoutMinorAmountSchema.optional(),
    amountMinor: CheckoutMinorAmountSchema.optional(),
  })
  .refine((t) => t.amount !== undefined || t.amountMinor !== undefined, {
    message: 'قيمة الدفع مطلوبة',
  });

const CheckoutSchema = z
  .object({
    storeId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    customerName: z.string().max(120).trim().optional(),
    cartDiscount: z.string().regex(/^\d{1,15}$/).optional(),
    items: z.array(z.object({
      variantId: z.string().uuid(),
      quantity: z.string().regex(/^[1-9]\d{0,8}$/),
      lineDiscount: z.string().regex(/^\d{1,15}$/).optional(),
    })).min(1).max(100),
    payment: CheckoutTenderSchema.optional(),
    payments: z.array(CheckoutTenderSchema).min(1).max(10).optional(),
    paymentMethod: CheckoutPaymentMethodSchema.optional(),
    amountPaidMinor: CheckoutMinorAmountSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const hasPaymentsArray = Array.isArray(body.payments) && body.payments.length > 0;
    const hasSingleObject = Boolean(body.payment);
    const hasLegacySingle = body.paymentMethod !== undefined || body.amountPaidMinor !== undefined;
    const modeCount = Number(hasPaymentsArray) + Number(hasSingleObject) + Number(hasLegacySingle);
    if (modeCount === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'بيانات الدفع مطلوبة' });
      return;
    }
    if (modeCount > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا يمكن إرسال أكثر من صيغة لبيانات الدفع في نفس الطلب' });
      return;
    }
    if (hasLegacySingle && !(body.paymentMethod && body.amountPaidMinor !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'بيانات الدفع مطلوبة' });
      return;
    }
    if (hasPaymentsArray) {
      const seen = new Set();
      for (const tender of body.payments) {
        if (seen.has(tender.method)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'لا يمكن تكرار نفس وسيلة الدفع أكثر من مرة في الدفع المجزأ' });
          return;
        }
        seen.add(tender.method);
      }
    }
  });
const SaleExchangeSchema = z.object({
  idempotencyKey: z.string().uuid(),
  storeId: z.string().uuid(),
  paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE', 'OTHER']),
  returnedItems: z.array(z.object({ originalSaleItemId: z.string().min(1).max(80), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100),
  replacementItems: z.array(z.object({ variantId: z.string().uuid(), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100),
  notes: z.string().max(500).trim().optional(),
});
const SupplierSchema = z.object({ name: z.string().min(2).max(120).trim(), phone: z.string().max(40).trim().optional(), notes: z.string().max(500).trim().optional() });
const InlinePurchaseVariantSchema = z.object({
  sku: z.string().min(1, 'كود التركيبة مطلوب').max(64, 'كود التركيبة طويل جدًا').trim(),
  barcode: z.string().min(1, 'الباركود غير صالح').max(64, 'الباركود طويل جدًا').trim().optional(),
  attributes: ProductAttributesSchema.default({}),
  quantity: z.string().regex(/^\d{1,9}$/, 'الكمية يجب أن تكون رقمًا صحيحًا بدون كسور'),
  unitCost: z.string().regex(/^\d{1,15}$/, 'سعر الشراء غير صالح'),
  retailPrice: z.string().regex(/^\d{1,15}$/, 'سعر البيع غير صالح').nullable().optional(),
  reorderPoint: z.string().regex(/^\d{1,9}$/, 'حد التنبيه غير صالح').optional(),
});
const InlinePurchaseProductSchema = z.object({
  name: z.string().min(2, 'اسم المنتج يجب أن يكون حرفين على الأقل').max(120, 'اسم المنتج طويل جدًا').trim(),
  sku: z.string().min(1, 'كود المنتج مطلوب').max(64, 'كود المنتج طويل جدًا').trim(),
  barcode: z.string().min(1, 'باركود المنتج غير صالح').max(64, 'باركود المنتج طويل جدًا').trim().optional(),
  categoryId: z.string().uuid('الفئة المحددة غير صالحة').nullable().optional(),
  brand: z.string().max(100, 'اسم الماركة طويل جدًا').trim().optional(),
  description: z.string().max(2000, 'الوصف طويل جدًا').trim().optional(),
  imagePath: ProductImagePathSchema.optional(),
  options: z.array(ProductOptionSchema).max(8, 'الحد الأقصى للخيارات هو 8 خيارات').default([]),
  variants: z.array(InlinePurchaseVariantSchema).min(1, 'يجب إضافة تركيبة واحدة على الأقل للمنتج').max(200, 'الحد الأقصى للتركيبات هو 200 تركيبة'),
});
const PurchaseSchema = z.object({
  idempotencyKey: z.string().uuid('معرف العملية غير صالح، أعد فتح النموذج وحاول مرة أخرى'),
  supplierId: z.string().uuid('اختر التاجر / المورد أولًا'),
  storeId: z.string().uuid('اختر الفرع أولًا'),
  invoiceNumber: z.string().max(80, 'رقم الفاتورة طويل جدًا').trim().optional(),
  totalAmount: z.string().regex(/^[1-9]\d{0,14}$/, 'إجمالي الفاتورة يجب أن يكون أكبر من صفر'),
  paidAmount: z.string().regex(/^\d{1,15}$/, 'المبلغ المدفوع غير صالح'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']).default('CASH'),
  targetProfitPercent: z.number().min(0, 'نسبة الربح يجب أن تكون صفرًا أو أكثر').max(100000, 'نسبة الربح كبيرة جدًا').nullable().optional(),
  referenceNumber: z.string().max(80, 'الرقم المرجعي طويل جدًا').trim().optional(),
  notes: z.string().max(500, 'الملاحظات طويلة جدًا').trim().optional(),
  items: z.array(z.object({
    variantId: z.string().uuid('الصنف المحدد غير صالح'),
    quantity: z.string().regex(/^[1-9]\d{0,8}$/, 'الكمية يجب أن تكون رقمًا صحيحًا أكبر من صفر'),
    unitCost: z.string().regex(/^\d{1,15}$/, 'سعر الشراء غير صالح'),
    retailPrice: z.string().regex(/^\d{1,15}$/, 'سعر البيع غير صالح').nullable().optional(),
  })).max(200, 'الحد الأقصى للأصناف في الفاتورة هو 200 صنف').default([]),
  newProducts: z.array(InlinePurchaseProductSchema).max(50, 'الحد الأقصى للمنتجات الجديدة في فاتورة واحدة هو 50 منتجًا').default([]),
}).superRefine((body, refinementCtx) => {
  let newPurchasedLines = 0;
  for (const np of body.newProducts) {
    const productPurchased = np.variants.filter((variant) => BigInt(variant.quantity) > 0n).length;
    if (productPurchased === 0) {
      refinementCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `حدد كمية أكبر من صفر لتركيبة واحدة على الأقل للمنتج (${np.name})`,
      });
      return;
    }
    newPurchasedLines += productPurchased;
  }
  const totalLines = body.items.length + newPurchasedLines;
  if (totalLines === 0) {
    refinementCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'يجب أن تحتوي فاتورة الشراء على صنف واحد على الأقل بكمية أكبر من صفر',
    });
    return;
  }
  if (totalLines > 300) {
    refinementCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'تجاوزت الفاتورة الحد الأقصى لعدد البنود (300 بند)',
    });
  }
});
const SupplierPaymentSchema = z.object({ idempotencyKey: z.string().uuid(), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']), referenceNumber: z.string().max(80).trim().optional() });
const UpdatePurchaseMetaSchema = z.object({
  invoiceNumber: z.string().max(80).trim().nullable().optional(),
  notes: z.string().max(500).trim().nullable().optional(),
  targetProfitPercent: z.number().min(0).max(100000).nullable().optional(),
});
const UpdateExpenseSchema = z.object({
  idempotencyKey: z.string().uuid(),
  categoryCode: z.enum(['RENT', 'UTILITIES', 'TRANSPORT', 'MAINTENANCE', 'SUPPLIES', 'OTHER']),
  amount: z.string().regex(/^[1-9]\d{0,14}$/, 'قيمة المصروف يجب أن تكون أكبر من صفر'),
  paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ المصروف غير صالح'),
  notes: z.string().max(500).trim().optional(),
  referenceNumber: z.string().max(80).trim().optional(),
});
const ExpenseSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), categoryCode: z.enum(['RENT', 'UTILITIES', 'TRANSPORT', 'MAINTENANCE', 'SUPPLIES', 'OTHER']), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']), expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().max(500).trim().optional(), referenceNumber: z.string().max(80).trim().optional() });
const CustomerReturnSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE', 'OTHER']), items: z.array(z.object({ originalSaleItemId: z.string().min(1).max(80), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100) });
const RecurringObligationSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), categoryCode: z.enum(['RENT', 'UTILITIES', 'TRANSPORT', 'MAINTENANCE', 'SUPPLIES', 'OTHER']), name: z.string().min(2).max(120).trim(), dueDay: z.number().int().min(1).max(31), initialAmount: z.string().regex(/^[1-9]\d{0,14}$/).optional() });
const MonthlyActualSchema = z.object({ year: z.number().int().min(2000).max(9999), month: z.number().int().min(1).max(12), amount: z.string().regex(/^[1-9]\d{0,14}$/) });
const MonthlyPaymentSchema = z.object({ idempotencyKey: z.string().uuid(), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']), referenceNumber: z.string().max(80).trim().optional(), tzOffset: z.number().int().min(-840).max(840).optional() });
const SupplierReturnSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), items: z.array(z.object({ purchaseItemId: z.string().min(1).max(80), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100) });
const BackupSchema = z.object({ passphrase: z.string().min(12).max(256) });
const CreateStocktakeSchema = z.object({
  storeId: z.string().uuid(),
  title: z.string().min(2).max(120).trim().optional(),
  scope: z.enum(['FULL', 'CATEGORY', 'PARTIAL']).default('FULL'),
  categoryId: z.string().uuid().optional().nullable(),
  blindMode: z.boolean().default(false),
  includeZeroStock: z.boolean().default(false),
  notes: z.string().max(500).trim().optional(),
});
const UpdateStocktakeSettingsSchema = z.object({
  title: z.string().min(2).max(120).trim().optional(),
  notes: z.string().max(500).trim().optional().nullable(),
  blindMode: z.boolean().optional(),
});
const PatchStocktakeLinesSchema = z.object({
  action: z.enum(['MARK_REMAINING_EXACT']).optional(),
  scanCode: z.string().min(1).max(120).trim().optional(),
  delta: z.number().int().min(-10000).max(10000).optional(),
  addVariantId: z.string().uuid().optional(),
  addDelta: z.number().int().min(0).max(10000).optional(),
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    countedQuantity: z.number().int().min(0).max(100000000).nullable().optional(),
    overrideUnitCost: z.union([z.string().regex(/^\d{1,15}$/), z.number().int().min(0).max(999999999999999)]).nullable().optional(),
    reason: z.string().max(240).trim().nullable().optional(),
  })).max(500).optional(),
});
const CommitStocktakeSchema = z.object({
  idempotencyKey: z.string().uuid(),
  uncountedStrategy: z.enum(['SKIP_UNCOUNTED', 'ZERO_UNCOUNTED']).default('SKIP_UNCOUNTED'),
  notes: z.string().max(500).trim().optional().nullable(),
});
const BackupSettingsSchema = z.object({ mirrorPath: z.string().max(500).trim().default(''), autoMirror: z.boolean().default(true) });
const DailyRestoreSchema = z.object({ filename: z.string().regex(/^retailos-daily-\d{4}-\d{2}-\d{2}\.(rfbackup|sqlite)$/) });
const DailyKeyExportSchema = z.object({ currentPassword: z.string().min(1).max(128) });
const DailyMasterKeySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  masterPassphrase: z
    .string()
    .trim()
    .min(12, 'كلمة مرور النسخ الاحتياطي يجب أن تكون 12 حرفًا على الأقل')
    .max(256)
    .refine(isValidDailyBackupPassphrase, {
      message: 'كلمة مرور النسخ الاحتياطي تحتوي على رموز غير مسموحة',
    }),
});
const PasswordChangeSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) });
const EmployeeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const EmployeePhoneSchema = z.string().trim().max(32).regex(/^[+0-9().\-\s]*$/);
const ShiftStartTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'صيغة موعد بدء الشيفت يجب أن تكون HH:MM');
const UpdateUserSchema = z.object({ fullName: z.string().min(2).max(100).trim().optional(), phone: EmployeePhoneSchema.nullable().optional(), employmentStartDate: EmployeeDateSchema.optional(), shiftStartTime: ShiftStartTimeSchema.nullable().optional(), lateGraceMinutes: z.number().int().min(0).max(180).optional(), role: z.enum(['OWNER', 'STORE_MANAGER', 'CASHIER', 'AUDITOR']).optional(), storeId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional(), newPassword: z.string().min(12).max(128).optional() }).refine((body) => Object.keys(body).length > 0);
const BulkShiftScheduleSchema = z.object({
  userIds: z.array(z.string().uuid()).max(200).optional(),
  shiftStartTime: ShiftStartTimeSchema.nullable(),
  lateGraceMinutes: z.number().int().min(0).max(180).optional(),
});
const CreateStoreSchema = z.object({ name: z.string().min(2).max(100).trim(), code: z.string().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/).trim(), address: z.string().max(240).trim().optional(), phone: z.string().max(40).trim().optional() });
const InventoryTransferSchema = z.object({ fromStoreId: z.string().uuid(), toStoreId: z.string().uuid(), variantId: z.string().uuid(), quantity: z.string().regex(/^[1-9]\d{0,8}$/) });
const ShiftCloseSchema = z.object({ storeId: z.string().uuid(), idempotencyKey: z.string().uuid(), actualCashAmount: z.string().regex(/^-?\d{1,15}$/), notes: z.string().max(300).trim().optional() });
const CloseAccountingPeriodSchema = z.object({ periodId: z.string().min(1).max(120).trim() });
const TreasuryTransferSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  fromAccount: z.enum(['1010', '1015', '1020']),
  toAccount: z.enum(['1010', '1015', '1020']),
  amount: z.string().regex(/^[1-9]\d{0,14}$/),
  notes: z.string().max(300).trim().optional(),
});
const SupplierRefundSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  amount: z.string().regex(/^[1-9]\d{0,14}$/),
  paymentMethod: z.enum(['CASH', 'CASH_SAFE', 'BANK_TRANSFER']),
  referenceNumber: z.string().max(80).trim().optional(),
  notes: z.string().max(300).trim().optional(),
});
const OpeningBalancesSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  entryDate: EmployeeDateSchema,
  cashDrawer: z.string().regex(/^\d{1,15}$/).default('0'),
  cashSafe: z.string().regex(/^\d{1,15}$/).default('0'),
  bank: z.string().regex(/^\d{1,15}$/).default('0'),
  inventory: z.string().regex(/^\d{1,15}$/).default('0'),
  supplierPayables: z.string().regex(/^\d{1,15}$/).default('0'),
  notes: z.string().max(300).trim().optional(),
});
const InventoryDamageSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: z.string().regex(/^[1-9]\d{0,8}$/),
  reason: z.string().max(300).trim().optional(),
});
const InventoryAdjustSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  variantId: z.string().uuid(),
  targetQuantity: z.string().regex(/^\d{1,9}$/),
  unitCost: z.string().regex(/^\d{1,15}$/).optional(),
  reason: z.string().max(300).trim().optional(),
});

function timeZoneStartOfDayUtcMs(dateStr, timeZone = companyConfig.timezone) {
  const safeTz = resolveValidTimeZone(timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  let utcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
    const wallAsUtc = Date.UTC(
      Number.parseInt(parts.year, 10),
      Number.parseInt(parts.month, 10) - 1,
      Number.parseInt(parts.day, 10),
      Number.parseInt(parts.hour, 10),
      Number.parseInt(parts.minute, 10),
      Number.parseInt(parts.second, 10),
    );
    const delta = wallAsUtc - Date.UTC(y, m - 1, d, 0, 0, 0);
    if (delta === 0) break;
    utcMs -= delta;
  }
  return utcMs;
}

function normalizeTzOffsetMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < -840 || parsed > 840) return null;
  return parsed;
}

function localDayUtcBounds(dateMs = Date.now(), tzOffsetMinutes = null, timeZone = companyConfig.timezone) {
  const explicitOffset = normalizeTzOffsetMinutes(tzOffsetMinutes);
  if (explicitOffset !== null) {
    const offsetMs = explicitOffset * 60000;
    const shifted = new Date(dateMs - offsetMs);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const startUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0) + offsetMs;
    const endUtcMs = startUtcMs + 86400000;
    return {
      dateStr,
      monthStr: dateStr.slice(0, 7),
      startIso: new Date(startUtcMs).toISOString(),
      endIso: new Date(endUtcMs).toISOString(),
    };
  }
  const safeTz = resolveValidTimeZone(timeZone);
  const dateStr = businessDateInTimeZone(new Date(dateMs), safeTz);
  const nextDateStr = businessDateInTimeZone(new Date(timeZoneStartOfDayUtcMs(dateStr, safeTz) + 30 * 3600 * 1000), safeTz);
  const startUtcMs = timeZoneStartOfDayUtcMs(dateStr, safeTz);
  const endUtcMs = timeZoneStartOfDayUtcMs(nextDateStr, safeTz);
  return {
    dateStr,
    monthStr: dateStr.slice(0, 7),
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
  };
}

function queryRangeBounds(fromStr, toStr, _url, timeZone = companyConfig.timezone) {
  const safeTz = resolveValidTimeZone(timeZone);
  const startUtcMs = timeZoneStartOfDayUtcMs(fromStr, safeTz);
  const toStartMs = timeZoneStartOfDayUtcMs(toStr, safeTz);
  const nextAfterTo = businessDateInTimeZone(new Date(toStartMs + 30 * 3600 * 1000), safeTz);
  const endExclusiveUtcMs = timeZoneStartOfDayUtcMs(nextAfterTo, safeTz);
  return {
    fromStr,
    toStr,
    timeZone: safeTz,
    startIso: new Date(startUtcMs).toISOString(),
    endExclusiveIso: new Date(endExclusiveUtcMs).toISOString(),
  };
}

function parseNonNegativeMinorInput(value, label = 'القيمة النقدية') {
  const str = String(value ?? '0').trim();
  if (!/^\d{1,15}$/.test(str)) {
    throw Object.assign(new Error(`${label} غير صالحة`), { status: 400 });
  }
  return BigInt(str);
}

function toNonNegativeBigInt(value) {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Invalid safe integer monetary minor value: ${String(value)}`);
    }
    return value > 0 ? BigInt(value) : 0n;
  }
  const trimmed = String(value).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid integer string monetary minor value: ${trimmed}`);
  }
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : 0n;
}

function paymentMethodArabicLabel(method) {
  switch (String(method || 'CASH').toUpperCase()) {
    case 'CASH':
    case 'CASH_DRAWER':
      return 'نقدي (الدرج)';
    case 'CASH_SAFE':
      return 'الخزينة';
    case 'BANK_TRANSFER':
      return 'تحويل بنكي / إنستاباي';
    case 'CARD':
      return 'بطاقة بنكية';
    case 'MOBILE':
      return 'محفظة إلكترونية';
    default:
      return String(method || 'نقدي');
  }
}

function parseShiftStartMinutes(shiftStartTime) {
  if (!shiftStartTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftStartTime)) return null;
  const [hh, mm] = shiftStartTime.split(':').map(Number);
  return hh * 60 + mm;
}

function evaluateAttendanceTimestamp(createdAtIso, shiftStartTime, lateGraceMinutes, tzOffsetMinutes) {
  const utcMs = Date.parse(createdAtIso);
  if (Number.isNaN(utcMs)) return null;
  const shifted = new Date(utcMs - tzOffsetMinutes * 60000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const dateStr = `${year}-${month}-${day}`;
  const arrivalMinutes = hour * 60 + minute;
  const arrivalTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const scheduledMinutes = parseShiftStartMinutes(shiftStartTime);
  const grace = Math.max(0, Number(lateGraceMinutes ?? 0) || 0);
  if (scheduledMinutes === null) {
    return {
      dateStr,
      monthStr: dateStr.slice(0, 7),
      arrivalTime,
      arrivalMinutes,
      isLate: false,
      lateMinutes: 0,
      status: 'UNSCHEDULED',
    };
  }
  const isLate = arrivalMinutes > scheduledMinutes + grace;
  const lateMinutes = isLate ? arrivalMinutes - scheduledMinutes : 0;
  return {
    dateStr,
    monthStr: dateStr.slice(0, 7),
    arrivalTime,
    arrivalMinutes,
    isLate,
    lateMinutes,
    status: isLate ? 'LATE' : 'ON_TIME',
  };
}

async function computeTreasuryBalancesMinor(conn, tenantId, storeId) {
  const rows = await conn
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.journal_entry_id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select(['accounts.account_code as code', 'journal_lines.entry_type as side', 'journal_lines.amount as amount'])
    .where('journal_entries.tenant_id', '=', tenantId)
    .where('journal_entries.store_id', '=', storeId)
    .where('journal_entries.status', '=', 'POSTED')
    .where('accounts.account_code', 'in', ['1010', '1015', '1020'])
    .execute();
  let drawer = 0n;
  let safe = 0n;
  let bank = 0n;
  for (const row of rows) {
    const amt = BigInt(row.amount);
    const delta = row.side === 'DEBIT' ? amt : -amt;
    if (row.code === '1010') drawer += delta;
    else if (row.code === '1015') safe += delta;
    else if (row.code === '1020') bank += delta;
  }
  return { drawer, safe, bank };
}

async function computeDrawerBookBalanceMinor(conn, tenantId, storeId) {
  const { drawer } = await computeTreasuryBalancesMinor(conn, tenantId, storeId);
  return drawer;
}

// ---------------------------------------------------------------------------
// Paged history helpers (purchases, journal entries, customer returns).
// The bootstrap payload only carries a recent window; these helpers give the UI
// access to the complete history with filters while totals always come from SQL
// aggregates over every matching row, never from the loaded window.
// ---------------------------------------------------------------------------
const BOOTSTRAP_PURCHASE_WINDOW = 200;
const HISTORY_PAGE_MAX = 100;

function chunkIds(ids, size = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function parsePaging(url, defaultLimit = 50) {
  const offset = Math.max(0, Math.min(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 100000000));
  const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? String(defaultLimit), 10) || defaultLimit, HISTORY_PAGE_MAX));
  return { offset, limit };
}

function parseHistoryRange(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if ((from === null || from === '') !== (to === null || to === '')) throw Object.assign(new Error('يجب تحديد تاريخ البداية والنهاية معًا'), { status: 400 });
  if (!from || !to) return { from: null, to: null, bounds: null };
  reportDay(from); reportDay(to);
  if (from > to) throw Object.assign(new Error('تاريخ البداية يجب أن يسبق تاريخ النهاية'), { status: 400 });
  return { from, to, bounds: queryRangeBounds(from, to, url) };
}

async function resolveHistoryStore(ctx, url) {
  const stores = await storeRepo.listByTenant(ctx);
  const storeId = ctx.storeId ?? url.searchParams.get('storeId') ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('الفرع المحدد غير متاح لهذا المستخدم'), { status: 403 });
  return storeId;
}

async function tenantCurrencyCode(tenantId) {
  const tenant = await tenantRepo.findById(tenantId);
  return typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
}

async function tenantUserNameMap(tenantId) {
  const rows = await db.selectFrom('users').select(['id', 'username', 'full_name as fullName']).where('tenant_id', '=', tenantId).execute();
  return new Map(rows.map((u) => [u.id, u.fullName || u.username]));
}

function unrepresentedInitialPaidSql(alias = 'p') {
  return `(CASE WHEN ${alias}.initial_paid_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM supplier_payments sp_init
    WHERE sp_init.tenant_id = ${alias}.tenant_id
      AND sp_init.purchase_id = ${alias}.id
      AND (
        sp_init.id = ${alias}.id || ':payment:initial'
        OR sp_init.idempotency_key = ${alias}.idempotency_key || ':initial'
      )
  ) THEN ${alias}.initial_paid_amount ELSE 0 END)`;
}

function effectiveLegacyInitialPaid(purchase, purchasePayments) {
  const legacyInitial = BigInt(purchase.initial_paid_amount ?? 0);
  if (legacyInitial <= 0n) return 0n;
  const alreadyRepresented = purchasePayments.some(
    (payment) =>
      payment.id === `${purchase.id}:payment:initial` ||
      payment.idempotency_key === `${purchase.idempotency_key}:initial`,
  );
  return alreadyRepresented ? 0n : legacyInitial;
}

function purchaseFilterSql({ tenantId, storeId, bounds = null, supplierId = null, search = '' }) {
  const conds = ['p.tenant_id = ?', 'p.store_id = ?'];
  const args = [tenantId, storeId];
  if (bounds) {
    conds.push("replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ?", "replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?");
    args.push(bounds.startIso, bounds.endExclusiveIso);
  }
  if (supplierId) { conds.push('p.supplier_id = ?'); args.push(supplierId); }
  if (search) {
    conds.push(`(instr(lower(coalesce(p.invoice_number, '')), lower(?)) > 0 OR instr(lower(coalesce(p.notes, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM suppliers sup WHERE sup.id = p.supplier_id AND sup.tenant_id = p.tenant_id AND instr(lower(sup.name), lower(?)) > 0) OR EXISTS (SELECT 1 FROM supplier_purchase_items i WHERE i.tenant_id = p.tenant_id AND i.purchase_id = p.id AND (instr(lower(i.product_name), lower(?)) > 0 OR instr(lower(i.sku), lower(?)) > 0)))`);
    args.push(search, search, search, search, search);
  }
  return { where: conds.join(' AND '), args };
}

/**
 * Finds all supplier IDs matching a text search across supplier names,
 * matching purchases/items, or supplier refund references/notes.
 */
function findMatchingSupplierIds(filter) {
  const searchLower = (filter.search ?? '').trim().toLowerCase();
  if (!searchLower) return null;
  const rawDb = database.getRawDatabase();
  const matched = new Set();

  const { where, args } = purchaseFilterSql(filter);
  const purSuppliers = rawDb.prepare(`SELECT DISTINCT p.supplier_id AS supplierId FROM supplier_purchases p WHERE ${where}`).all(...args);
  for (const row of purSuppliers) matched.add(row.supplierId);

  const rConds = ['sr.tenant_id = ?', 'sr.store_id = ?'];
  const rArgs = [filter.tenantId, filter.storeId];
  if (filter.supplierId) { rConds.push('sr.supplier_id = ?'); rArgs.push(filter.supplierId); }
  if (filter.bounds) {
    rConds.push("replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') >= ?", "replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') < ?");
    rArgs.push(filter.bounds.startIso, filter.bounds.endExclusiveIso);
  }
  rConds.push(`(instr(lower(coalesce(sup.name, '')), lower(?)) > 0 OR instr(lower(coalesce(sr.reference_number, '')), lower(?)) > 0 OR instr(lower(coalesce(sr.notes, '')), lower(?)) > 0)`);
  rArgs.push(searchLower, searchLower, searchLower);
  const refSuppliers = rawDb.prepare(`
    SELECT DISTINCT sr.supplier_id AS supplierId
    FROM supplier_refunds sr
    INNER JOIN suppliers sup ON sup.id = sr.supplier_id AND sup.tenant_id = sr.tenant_id
    WHERE ${rConds.join(' AND ')}
  `).all(...rArgs);
  for (const row of refSuppliers) matched.add(row.supplierId);

  const nameSuppliers = rawDb.prepare(`
    SELECT id FROM suppliers WHERE tenant_id = ? AND is_active = 1 AND instr(lower(name), lower(?)) > 0
  `).all(filter.tenantId, searchLower);
  for (const row of nameSuppliers) matched.add(row.id);

  return matched;
}

/** Full-history (or date-bounded) supplier totals computed in SQL: never distorted by text search or page window. */
function supplierPurchaseAggregates(filter) {
  const { where, args } = purchaseFilterSql({
    tenantId: filter.tenantId,
    storeId: filter.storeId,
    bounds: filter.bounds,
    supplierId: filter.supplierId,
    search: '',
  });
  const rawDb = database.getRawDatabase();
  const rows = rawDb.prepare(`
    SELECT p.supplier_id AS supplierId,
      COUNT(*) AS purchaseCount,
      COALESCE(SUM(p.total_amount), 0) AS totalAmount,
      COALESCE(SUM(${unrepresentedInitialPaidSql('p')}), 0) AS initialPaid,
      COALESCE(SUM((SELECT COALESCE(SUM(sp.amount), 0) FROM supplier_payments sp WHERE sp.tenant_id = p.tenant_id AND sp.purchase_id = p.id AND sp.deleted_at IS NULL)), 0) AS laterPaid,
      COALESCE(SUM((SELECT COALESCE(SUM(sr.credit_amount), 0) FROM supplier_returns sr WHERE sr.tenant_id = p.tenant_id AND sr.purchase_id = p.id)), 0) AS returnedCredit
    FROM supplier_purchases p
    WHERE ${where}
    GROUP BY p.supplier_id
  `).all(...args);

  const rConds = ['sr.tenant_id = ?', 'sr.store_id = ?'];
  const rArgs = [filter.tenantId, filter.storeId];
  if (filter.supplierId) { rConds.push('sr.supplier_id = ?'); rArgs.push(filter.supplierId); }
  if (filter.bounds) {
    rConds.push("replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') >= ?", "replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') < ?");
    rArgs.push(filter.bounds.startIso, filter.bounds.endExclusiveIso);
  }
  const rRows = rawDb.prepare(`
    SELECT sr.supplier_id AS supplierId, sr.amount AS amount
    FROM supplier_refunds sr
    WHERE ${rConds.join(' AND ')}
  `).all(...rArgs);

  const refundedBySupplier = new Map();
  for (const r of rRows) {
    refundedBySupplier.set(r.supplierId, (refundedBySupplier.get(r.supplierId) ?? 0n) + BigInt(r.amount ?? 0));
  }

  const map = new Map();
  for (const row of rows) {
    const total = BigInt(row.totalAmount ?? 0);
    const paid = BigInt(row.initialPaid ?? 0) + BigInt(row.laterPaid ?? 0);
    const returned = BigInt(row.returnedCredit ?? 0);
    const refundedToStore = refundedBySupplier.get(row.supplierId) ?? 0n;
    map.set(row.supplierId, { purchaseCount: Number(row.purchaseCount ?? 0), total, paid, returned, refundedToStore, due: total - paid - returned + refundedToStore });
  }
  for (const [supplierId, refundedToStore] of refundedBySupplier.entries()) {
    if (!map.has(supplierId)) {
      map.set(supplierId, { purchaseCount: 0, total: 0n, paid: 0n, returned: 0n, refundedToStore, due: refundedToStore });
    }
  }
  return map;
}

function serializeSupplierSummary(supplier, totals, currency, purchases, supplierRefunds = []) {
  const t = totals ?? { purchaseCount: 0, total: 0n, paid: 0n, returned: 0n, refundedToStore: 0n, due: 0n };
  const creditFromSupplier = t.due < 0n ? (-t.due).toString() : '0';
  const amountOwed = t.due > 0n ? t.due.toString() : '0';
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    notes: supplier.notes,
    isActive: supplier.is_active === 1,
    purchases,
    supplierRefunds,
    purchaseCount: t.purchaseCount,
    purchasesComplete: purchases.length >= t.purchaseCount,
    totalPurchased: t.total.toString(),
    totalPaid: t.paid.toString(),
    returnedCredit: t.returned.toString(),
    refundedToStore: (t.refundedToStore ?? 0n).toString(),
    creditFromSupplier,
    amountOwed,
    balanceDue: t.due.toString(),
    currency,
  };
}

/** Serializes purchase rows with their items, payments and returns, loading children only for these rows. */
async function loadPurchaseEntries(tenantId, purchaseRows, userMap) {
  if (!purchaseRows.length) return [];
  const ids = purchaseRows.map((p) => p.id);
  const items = [];
  const payments = [];
  const vendorReturns = [];
  for (const chunk of chunkIds(ids)) {
    items.push(...await db.selectFrom('supplier_purchase_items').selectAll().where('tenant_id', '=', tenantId).where('purchase_id', 'in', chunk).execute());
    payments.push(...await db.selectFrom('supplier_payments').selectAll().where('tenant_id', '=', tenantId).where('purchase_id', 'in', chunk).execute());
    vendorReturns.push(...await db.selectFrom('supplier_returns').selectAll().where('tenant_id', '=', tenantId).where('purchase_id', 'in', chunk).orderBy('created_at', 'desc').execute());
  }
  const returnedQuantityByPurchaseItem = new Map();
  for (const chunk of chunkIds(items.map((item) => item.id))) {
    const rows = await db.selectFrom('supplier_return_items').selectAll().where('tenant_id', '=', tenantId).where('purchase_item_id', 'in', chunk).execute();
    for (const row of rows) returnedQuantityByPurchaseItem.set(row.purchase_item_id, (returnedQuantityByPurchaseItem.get(row.purchase_item_id) ?? 0n) + BigInt(row.quantity));
  }
  const group = (rows, key) => {
    const map = new Map();
    for (const row of rows) { const bucket = map.get(row[key]) ?? []; bucket.push(row); map.set(row[key], bucket); }
    return map;
  };
  const itemsByPurchase = group(items, 'purchase_id');
  const paymentsByPurchase = group(payments, 'purchase_id');
  const returnsByPurchase = group(vendorReturns, 'purchase_id');
  return purchaseRows.map((purchase) => {
    const purchasePayments = paymentsByPurchase.get(purchase.id) ?? [];
    const activePurchasePayments = purchasePayments.filter((payment) => !payment.deleted_at);
    const purchaseReturns = returnsByPurchase.get(purchase.id) ?? [];
    const paid = effectiveLegacyInitialPaid(purchase, purchasePayments) + activePurchasePayments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
    const returnCredit = purchaseReturns.reduce((sum, item) => sum + BigInt(item.credit_amount), 0n);
    return {
      id: purchase.id,
      supplierId: purchase.supplier_id,
      invoiceNumber: purchase.invoice_number,
      purchasedAt: purchase.purchased_at,
      createdByUserId: purchase.created_by_user_id,
      createdByName: userMap.get(purchase.created_by_user_id) || 'المسؤول',
      totalAmount: moneyJson(Money.fromMinor(BigInt(purchase.total_amount), purchase.currency)),
      paidAmount: moneyJson(Money.fromMinor(paid, purchase.currency)),
      returnedCredit: moneyJson(Money.fromMinor(returnCredit, purchase.currency)),
      remainingAmount: moneyJson(Money.fromMinor(BigInt(purchase.total_amount) - paid - returnCredit, purchase.currency)),
      targetProfitPercent: purchase.target_profit_percent ?? null,
      expectedRetailTotal: purchase.expected_retail_total !== null && purchase.expected_retail_total !== undefined ? moneyJson(Money.fromMinor(BigInt(purchase.expected_retail_total), purchase.currency)) : null,
      notes: purchase.notes,
      items: (itemsByPurchase.get(purchase.id) ?? []).map((line) => {
        const returned = returnedQuantityByPurchaseItem.get(line.id) ?? 0n;
        return {
          id: line.id,
          productName: line.product_name,
          sku: line.sku,
          quantity: line.quantity.toString(),
          returnableQuantity: (BigInt(line.quantity) - returned).toString(),
          unitCost: moneyJson(Money.fromMinor(BigInt(line.unit_cost), line.currency)),
          retailPrice: line.retail_price !== null && line.retail_price !== undefined ? moneyJson(Money.fromMinor(BigInt(line.retail_price), line.currency)) : null,
        };
      }),
      payments: activePurchasePayments.map((payment) => ({ id: payment.id, amount: moneyJson(Money.fromMinor(BigInt(payment.amount), payment.currency)), paymentMethod: payment.payment_method, referenceNumber: payment.reference_number, paidAt: payment.paid_at, createdByUserId: payment.created_by_user_id, createdByName: userMap.get(payment.created_by_user_id) || 'المسؤول' })),
      returns: purchaseReturns.map((item) => ({ id: item.id, returnNumber: item.return_number, creditAmount: moneyJson(Money.fromMinor(BigInt(item.credit_amount), item.currency)), createdAt: item.created_at })),
    };
  });
}

async function serializeJournalEntries(journalHeaders) {
  const lines = [];
  for (const chunk of chunkIds(journalHeaders.map((entry) => entry.id))) {
    lines.push(...await db.selectFrom('journal_lines').innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
      .select(['journal_lines.journal_entry_id as entryId', 'journal_lines.entry_type as side', 'journal_lines.amount as amount', 'journal_lines.currency as currency', 'journal_lines.memo as memo', 'accounts.account_code as accountCode', 'accounts.account_name as accountName'])
      .where('journal_lines.journal_entry_id', 'in', chunk).orderBy('journal_lines.created_at').execute());
  }
  const linesByEntryId = new Map();
  for (const line of lines) {
    const bucket = linesByEntryId.get(line.entryId) ?? [];
    bucket.push(line);
    linesByEntryId.set(line.entryId, bucket);
  }
  return journalHeaders.map((entry) => {
    const entryLines = linesByEntryId.get(entry.id) ?? [];
    const debit = entryLines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + BigInt(line.amount), 0n);
    const credit = entryLines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + BigInt(line.amount), 0n);
    return { id: entry.id, entryNumber: entry.entry_number, date: entry.entry_date, sourceType: entry.source_type, description: entryLines[0]?.memo?.split(' — ')[0] ?? entry.source_type, debitTotal: debit.toString(), creditTotal: credit.toString(), balanced: debit === credit, lines: entryLines.map((line) => ({ side: line.side, accountCode: line.accountCode, accountName: line.accountName, amount: moneyJson(Money.fromMinor(BigInt(line.amount), line.currency)), memo: line.memo })) };
  });
}

function customerReturnFilterSql({ tenantId, storeId, bounds = null, search = '' }) {
  const conds = ['cr.tenant_id = ?', 'cr.store_id = ?'];
  const args = [tenantId, storeId];
  if (bounds) { conds.push('cr.created_at >= ?', 'cr.created_at < ?'); args.push(bounds.startIso, bounds.endExclusiveIso); }
  if (search) {
    conds.push(`(instr(lower(cr.return_number), lower(?)) > 0 OR instr(lower(s.sale_number), lower(?)) > 0 OR instr(lower(coalesce(cr.payment_method, '')), lower(?)) > 0 OR instr(lower(coalesce(s.customer_name, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id AND (instr(lower(si.product_name), lower(?)) > 0 OR instr(lower(si.sku), lower(?)) > 0)))`);
    args.push(search, search, search, search, search, search);
  }
  return { where: conds.join(' AND '), args };
}
const MAX_FAILED_LOGINS = 6;
const MAX_FAILED_PASSWORD_CHANGES = 5;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const BASE_LOGIN_BACKOFF_MS = 30 * 1000;
const MAX_LOGIN_BACKOFF_MS = 60 * 1000;
const MAX_FAILED_KEYS = 2000;

function computeLoginBackoffMs(failureCount) {
  if (failureCount < MAX_FAILED_LOGINS) return 0;
  const exp = Math.min(2, failureCount - MAX_FAILED_LOGINS);
  return Math.min(MAX_LOGIN_BACKOFF_MS, BASE_LOGIN_BACKOFF_MS * (2 ** exp));
}

function getAuthFailures(scope, key) {
  const row = database.getRawDatabase().prepare('SELECT count, started_at AS startedAt FROM auth_rate_limits WHERE scope = ? AND key = ?').get(scope, key);
  return row ? { count: Number(row.count), startedAt: Number(row.startedAt) } : { count: 0, startedAt: Date.now() };
}

function recordAuthFailure(scope, key, windowMs = LOCK_WINDOW_MS) {
  const now = Date.now();
  const current = getAuthFailures(scope, key);
  const inWindow = now - current.startedAt < windowMs;
  const nextCount = (inWindow ? current.count : 0) + 1;
  const nextStart = scope === 'login' && nextCount >= MAX_FAILED_LOGINS
    ? now
    : (inWindow ? current.startedAt : now);
  database.getRawDatabase().prepare(`
    INSERT INTO auth_rate_limits (scope, key, count, started_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope, key) DO UPDATE SET count = excluded.count, started_at = excluded.started_at
  `).run(scope, key, nextCount, nextStart);
  return { count: nextCount, startedAt: nextStart };
}

function clearAuthFailures(scope, key) {
  database.getRawDatabase().prepare('DELETE FROM auth_rate_limits WHERE scope = ? AND key = ?').run(scope, key);
}

function pruneAuthRateLimits(scope = null) {
  const rawDb = database.getRawDatabase();
  const cutoff = Date.now() - LOCK_WINDOW_MS;
  if (scope) {
    rawDb.prepare('DELETE FROM auth_rate_limits WHERE scope = ? AND started_at <= ?').run(scope, cutoff);
    const total = Number(rawDb.prepare('SELECT COUNT(*) AS cnt FROM auth_rate_limits WHERE scope = ?').get(scope)?.cnt ?? 0);
    if (total > MAX_FAILED_KEYS) {
      rawDb.prepare('DELETE FROM auth_rate_limits WHERE scope = ? AND key IN (SELECT key FROM auth_rate_limits WHERE scope = ? ORDER BY started_at ASC LIMIT ?)').run(scope, scope, total - MAX_FAILED_KEYS);
    }
    return;
  }
  rawDb.prepare('DELETE FROM auth_rate_limits WHERE started_at <= ?').run(cutoff);
}

function pruneFailedLogins() {
  pruneAuthRateLimits('login');
}

function pruneFailedPasswordChanges() {
  pruneAuthRateLimits('pwd_change');
}

async function verifyCurrentUserPasswordOrThrow(ctx, currentPassword) {
  pruneFailedPasswordChanges();
  const rateLimitKey = `${ctx.tenantId}:${ctx.userId}`;
  const failures = getAuthFailures('pwd_change', rateLimitKey);
  if (Date.now() - failures.startedAt < LOCK_WINDOW_MS && failures.count >= MAX_FAILED_PASSWORD_CHANGES) {
    throw Object.assign(new Error('محاولات كثيرة خاطئة. يرجى الانتظار 10 دقائق قبل المحاولة مجدداً.'), { status: 429 });
  }
  const currentUser = await userRepo.findById(ctx, ctx.userId);
  const validCurrent = currentUser && await passwordHasher.verify(currentUser.passwordHash, currentPassword);
  if (!validCurrent) {
    recordAuthFailure('pwd_change', rateLimitKey);
    throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
  }
  clearAuthFailures('pwd_change', rateLimitKey);
  return currentUser;
}

function escapeCsvCell(value) {
  const str = String(value ?? '');
  const sanitized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(sanitized)) return `"${sanitized.replaceAll('"', '""')}"`;
  return sanitized;
}

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function readCookie(req, name) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!cookie) return undefined;
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DRAIN_OVERSIZED_BYTES = 32 * 1024 * 1024;

async function readJson(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  let exceeded = false;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        // Stop reading unbounded payloads above drain cap; below cap, finish draining so keep-alive browsers receive JSON 413 instead of TCP reset ("Failed to fetch").
        if (totalBytes > MAX_DRAIN_OVERSIZED_BYTES) {
          req.destroy();
          break;
        }
        continue;
      }
      chunks.push(buf);
    }
  } catch {
    throw Object.assign(new Error('انقطع الاتصال قبل اكتمال البيانات — لم يتم تنفيذ العملية'), { status: 400 });
  }
  if (req.aborted) {
    throw Object.assign(new Error('تم إلغاء الطلب قبل اكتمال الإرسال — لم يتم تنفيذ العملية'), { status: 400 });
  }
  if (exceeded) {
    throw Object.assign(new Error('حجم البيانات المرسلة كبير جدًا، يرجى تقليل حجم الصورة والمحاولة مرة أخرى'), { status: 413 });
  }
  const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('البيانات المرسلة غير صالحة، يرجى المحاولة مرة أخرى'), { status: 400 });
  }
}

const VALIDATION_FIELD_LABELS = {
  name: 'الاسم',
  sku: 'الكود',
  barcode: 'الباركود',
  categoryId: 'الفئة',
  supplierId: 'التاجر / المورد',
  storeId: 'الفرع',
  items: 'أصناف الفاتورة',
  newProducts: 'المنتجات الجديدة',
  variants: 'التركيبات (الألوان والمقاسات)',
  options: 'خيارات المنتج',
  values: 'قيم الخيار',
  quantity: 'الكمية',
  unitCost: 'سعر الشراء',
  retailPrice: 'سعر البيع',
  totalAmount: 'إجمالي الفاتورة',
  paidAmount: 'المبلغ المدفوع',
  amount: 'المبلغ',
  paymentMethod: 'طريقة الدفع',
  invoiceNumber: 'رقم الفاتورة',
  notes: 'الملاحظات',
  phone: 'رقم الهاتف',
  username: 'اسم المستخدم',
  password: 'كلمة المرور',
  passphrase: 'كلمة سر النسخة الاحتياطية',
  fullName: 'الاسم الكامل',
  ownerName: 'اسم المدير',
  ownerUsername: 'اسم مستخدم المدير',
  reorderPoint: 'حد التنبيه لنقص المخزون',
  expenseDate: 'تاريخ المصروف',
  reason: 'السبب',
};

function formatValidationIssue(issue) {
  const rawMsg = String(issue.message ?? '').trim();
  const hasArabic = /[\u0600-\u06FF]/.test(rawMsg);
  if (hasArabic) return rawMsg;

  const pathKeys = Array.isArray(issue.path) ? issue.path.filter((p) => typeof p === 'string') : [];
  const lastField = pathKeys[pathKeys.length - 1];
  const label = (lastField && VALIDATION_FIELD_LABELS[lastField]) || 'البيانات المدخلة';

  if (issue.code === 'too_small') {
    if (issue.origin === 'array') return `يجب إدخال عنصر واحد على الأقل في ${label}`;
    if (issue.origin === 'string') return `${label} قصير جدًا، يرجى استكماله`;
    return `قيمة ${label} أقل من الحد المسموح`;
  }
  if (issue.code === 'too_big') {
    if (issue.origin === 'array') return `عدد عناصر ${label} يتجاوز الحد المسموح`;
    if (issue.origin === 'string') return `${label} أطول من الحد المسموح`;
    return `قيمة ${label} أكبر من الحد المسموح`;
  }
  if (issue.code === 'invalid_format' || issue.code === 'invalid_string') {
    if (lastField === 'totalAmount') return 'إجمالي الفاتورة يجب أن يكون أكبر من صفر';
    if (lastField === 'quantity') return 'الكمية يجب أن تكون رقمًا صحيحًا أكبر من صفر';
    if (lastField === 'unitCost' || lastField === 'retailPrice' || lastField === 'paidAmount' || lastField === 'amount') {
      return `يرجى إدخال رقم صحيح في ${label}`;
    }
    return `صيغة ${label} غير صحيحة`;
  }
  if (issue.code === 'invalid_type') {
    return `يرجى استكمال حقل ${label} بشكل صحيح`;
  }
  if (issue.code === 'invalid_value' || issue.code === 'invalid_enum_value') {
    return `القيمة المختارة في ${label} غير صالحة`;
  }
  return `يرجى مراجعة حقل ${label} والتأكد من إدخاله بشكل صحيح`;
}

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const messages = [...new Set(result.error.issues.map(formatValidationIssue))];
    throw Object.assign(new Error(messages.join('، ')), { status: 400 });
  }
  return result.data;
}

function assertVariantOptions(options, variants) {
  if (!options.length) return;
  const keys = options.map((option) => option.key);
  if (new Set(keys).size !== keys.length) throw Object.assign(new Error('لا يمكن تكرار اسم الخيار'), { status: 400 });
  const seen = new Set();
  for (const variant of variants) {
    const attributes = variant.attributes ?? {};
    if (Object.keys(attributes).length !== keys.length || keys.some((key) => !optionValueExists(options, key, attributes[key]))) {
      throw Object.assign(new Error('تركيبة النسخة لا تطابق خيارات المنتج'), { status: 400 });
    }
    const combination = JSON.stringify(Object.fromEntries(keys.map((key) => [key, attributes[key]])));
    if (seen.has(combination)) throw Object.assign(new Error('تركيبات المنتج مكررة'), { status: 400 });
    seen.add(combination);
  }
}

function optionValueExists(options, key, value) {
  const option = options.find((entry) => entry.key === key);
  return Boolean(option && option.values.includes(String(value)));
}

function moneyJson(amount) {
  return amount.toJSON();
}

function saleJson(sale) {
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    createdAt: sale.createdAt.toISOString(),
    total: moneyJson(sale.total),
    subtotal: moneyJson(sale.subtotal),
    discountTotal: moneyJson(sale.discountTotal),
    paidTotal: moneyJson(sale.paidTotal),
    changeGiven: moneyJson(sale.changeGiven),
    customerName: sale.customerName ?? null,
    status: sale.status,
    cashierUserId: sale.cashierUserId,
    items: sale.items.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.productName,
      sku: item.sku,
      variantAttributes: item.variantAttributes,
      quantity: item.quantity.toString(),
      unitPrice: moneyJson(item.unitPrice),
      lineDiscount: moneyJson(item.lineDiscount),
      cartDiscountShare: moneyJson(item.cartDiscountShare),
      netRevenue: moneyJson(item.netRevenue),
    })),
    payments: sale.payments.map((payment) => ({ method: payment.method, amount: moneyJson(payment.amount) })),
  };
}

function loadSaleReturnsAndCogs(rawDb, tenantId, storeId, saleIds) {
  const map = new Map();
  if (!saleIds || !saleIds.length) return map;
  const uniqueIds = [...new Set(saleIds)];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const saleItemRows = rawDb.prepare(`
    SELECT id, sale_id, item_type, quantity, cost_of_goods_sold
    FROM sale_items
    WHERE tenant_id = ? AND store_id = ? AND sale_id IN (${placeholders})
  `).all(tenantId, storeId, ...uniqueIds);
  const returnHeaderRows = rawDb.prepare(`
    SELECT original_sale_id, COALESCE(SUM(refund_amount), 0) AS refund_total
    FROM customer_returns
    WHERE tenant_id = ? AND store_id = ? AND original_sale_id IN (${placeholders})
    GROUP BY original_sale_id
  `).all(tenantId, storeId, ...uniqueIds);
  const returnItemRows = rawDb.prepare(`
    SELECT cr.original_sale_id, cri.original_sale_item_id,
      COALESCE(SUM(cri.quantity), 0) AS returned_qty,
      COALESCE(SUM(cri.refund_amount), 0) AS returned_refund,
      COALESCE(SUM(cri.cost_amount), 0) AS returned_cost
    FROM customer_return_items cri
    INNER JOIN customer_returns cr ON cr.id = cri.return_id AND cr.tenant_id = cri.tenant_id
    WHERE cri.tenant_id = ? AND cr.store_id = ? AND cr.original_sale_id IN (${placeholders})
    GROUP BY cr.original_sale_id, cri.original_sale_item_id
  `).all(tenantId, storeId, ...uniqueIds);

  for (const id of uniqueIds) {
    map.set(id, {
      soldQty: 0n,
      grossCogs: 0n,
      returnedAmount: 0n,
      returnedQty: 0n,
      returnedCost: 0n,
      itemMap: new Map(),
      returnedByItemId: new Map(),
    });
  }
  for (const row of saleItemRows) {
    const entry = map.get(row.sale_id);
    if (!entry) continue;
    const qty = BigInt(row.quantity ?? 0);
    entry.soldQty += qty;
    entry.grossCogs += BigInt(row.cost_of_goods_sold ?? 0);
    entry.itemMap.set(row.id, { cogs: BigInt(row.cost_of_goods_sold ?? 0), qty });
  }
  for (const row of returnHeaderRows) {
    const entry = map.get(row.original_sale_id);
    if (entry) entry.returnedAmount += BigInt(row.refund_total ?? 0);
  }
  for (const row of returnItemRows) {
    const entry = map.get(row.original_sale_id);
    if (!entry) continue;
    const rQty = BigInt(row.returned_qty ?? 0);
    const rRefund = BigInt(row.returned_refund ?? 0);
    const rCost = BigInt(row.returned_cost ?? 0);
    entry.returnedQty += rQty;
    entry.returnedCost += rCost;
    entry.returnedByItemId.set(row.original_sale_item_id, { qty: rQty, refund: rRefund, cost: rCost });
  }
  return map;
}

function enrichSerializedSale(sale, metricsMap, currency, canViewCogs) {
  const m = metricsMap.get(sale.id) ?? {
    soldQty: sale.items.reduce((s, i) => s + BigInt(i.quantity ?? 0), 0n),
    grossCogs: 0n,
    returnedAmount: 0n,
    returnedQty: 0n,
    returnedCost: 0n,
    itemMap: new Map(),
    returnedByItemId: new Map(),
  };
  const grossTotal = BigInt(sale.total.amount);
  const netTotal = grossTotal > m.returnedAmount ? grossTotal - m.returnedAmount : 0n;
  const netCogs = m.grossCogs - m.returnedCost;
  const grossProfit = netTotal - netCogs;
  const netQty = m.soldQty > m.returnedQty ? m.soldQty - m.returnedQty : 0n;
  const returnStatus = (m.returnedAmount === 0n && m.returnedQty === 0n)
    ? 'NONE'
    : (netQty <= 0n || netTotal <= 0n ? 'FULL' : 'PARTIAL');
  const toMoney = (minor) => moneyJson(Money.fromMinor(minor, currency));
  return {
    ...sale,
    originalTotal: sale.total,
    returnedAmount: toMoney(m.returnedAmount),
    netTotal: toMoney(netTotal),
    soldQuantity: m.soldQty.toString(),
    returnedQuantity: m.returnedQty.toString(),
    netQuantity: netQty.toString(),
    returnStatus,
    cogs: canViewCogs ? toMoney(netCogs) : null,
    grossProfit: canViewCogs ? toMoney(grossProfit) : null,
    items: sale.items.map((item) => {
      const ret = m.returnedByItemId.get(item.id) ?? { qty: 0n, refund: 0n, cost: 0n };
      const origItemCogs = m.itemMap.get(item.id)?.cogs ?? 0n;
      const itemQty = BigInt(item.quantity ?? 0);
      const returnableQty = item.type === 'SALE' ? (itemQty > ret.qty ? itemQty - ret.qty : 0n) : 0n;
      const netItemRevenue = BigInt(item.netRevenue.amount) - ret.refund;
      const netItemCogs = origItemCogs - ret.cost;
      return {
        ...item,
        returnedQuantity: ret.qty.toString(),
        returnableQuantity: returnableQty.toString(),
        netQuantity: (itemQty > ret.qty ? itemQty - ret.qty : 0n).toString(),
        netRevenueAfterReturn: toMoney(netItemRevenue > 0n ? netItemRevenue : 0n),
        ...(canViewCogs ? { cogs: toMoney(netItemCogs), profit: toMoney(netItemRevenue - netItemCogs) } : {}),
      };
    }),
  };
}

function assertStoreScope(ctx, storeId) {
  if (ctx.storeId && ctx.storeId !== storeId) {
    throw Object.assign(new Error('غير مصرح بالوصول إلى هذا الفرع'), { status: 403 });
  }
}

function signedMoneyJson(minorValue, currency) {
  const currencyCode = typeof currency === 'string' ? currency : (currency?.code ?? 'EGP');
  let minor;
  if (typeof minorValue === 'bigint') {
    minor = minorValue;
  } else if (minorValue === null || minorValue === undefined) {
    minor = 0n;
  } else if (typeof minorValue === 'number') {
    if (!Number.isSafeInteger(minorValue)) {
      throw new Error(`Invalid safe integer monetary minor value: ${String(minorValue)}`);
    }
    minor = BigInt(minorValue);
  } else if (typeof minorValue === 'string') {
    const trimmed = minorValue.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid integer string monetary minor value: ${trimmed}`);
    }
    minor = BigInt(trimmed);
  } else {
    throw new Error(`Unsupported monetary minor value type: ${typeof minorValue}`);
  }
  const meta = Money.zero(currencyCode).toJSON();
  return { amount: minor.toString(), currency: currencyCode, decimals: meta.decimals };
}

const VARIANT_ATTR_LABELS = {
  color: 'اللون',
  colour: 'اللون',
  size: 'المقاس',
  style: 'الموديل',
  material: 'الخامة',
  type: 'النوع',
};

function parseVariantLabelFromJson(attributesJson) {
  try {
    const parsed = JSON.parse(attributesJson || '{}');
    if (!parsed || typeof parsed !== 'object') return '';
    return Object.entries(parsed)
      .map(([k, v]) => `${VARIANT_ATTR_LABELS[String(k).toLowerCase()] ?? k}: ${v}`)
      .join(' · ');
  } catch {
    return '';
  }
}

async function syncStocktakeDraftTotals(conn, sessionId, tenantId, storeId) {
  const rows = await conn
    .selectFrom('stocktake_lines as l')
    .leftJoin('inventory_items as ii', (join) =>
      join
        .onRef('ii.variant_id', '=', 'l.variant_id')
        .onRef('ii.tenant_id', '=', 'l.tenant_id')
        .onRef('ii.store_id', '=', 'l.store_id'),
    )
    .select([
      'l.counted_quantity',
      'l.expected_quantity',
      'l.unit_wac',
      'l.retail_price',
      'l.override_unit_cost',
      'ii.quantity_on_hand as live_quantity',
      'ii.wac_cost as live_wac_cost',
    ])
    .where('l.session_id', '=', sessionId)
    .where('l.tenant_id', '=', tenantId)
    .where('l.store_id', '=', storeId)
    .execute();

  let countedLines = 0;
  let totalVarianceQty = 0;
  let totalSurplusCost = 0n;
  let totalShortageCost = 0n;
  let netVarianceRetail = 0n;

  for (const row of rows) {
    if (row.counted_quantity === null || row.counted_quantity === undefined) continue;
    countedLines += 1;
    const counted = Number(row.counted_quantity);
    const liveQty = Number(row.live_quantity ?? 0);
    const diff = counted - liveQty;
    totalVarianceQty += diff;
    const liveWac = BigInt(row.live_wac_cost ?? row.unit_wac ?? 0);
    const surplusCost = row.override_unit_cost !== null && row.override_unit_cost !== undefined ? BigInt(row.override_unit_cost) : liveWac;
    if (diff > 0) totalSurplusCost += BigInt(diff) * surplusCost;
    else if (diff < 0) totalShortageCost += BigInt(-diff) * liveWac;
    netVarianceRetail += BigInt(diff) * BigInt(row.retail_price ?? 0);
  }

  const netVarianceCost = totalSurplusCost - totalShortageCost;
  await conn
    .updateTable('stocktake_sessions')
    .set({
      total_lines: rows.length,
      counted_lines: countedLines,
      total_variance_qty: totalVarianceQty,
      total_surplus_cost: totalSurplusCost,
      total_shortage_cost: totalShortageCost,
      net_variance_cost: netVarianceCost,
      net_variance_retail: netVarianceRetail,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', sessionId)
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'DRAFT')
    .execute();
}

function serializeStocktakeSessionSummary(session) {
  const currency = session.currency || 'EGP';
  const isDraft = session.status === 'DRAFT';
  const blindHidden = isDraft && Number(session.blind_mode) === 1;
  return {
    id: session.id,
    storeId: session.store_id,
    sessionNumber: session.session_number,
    title: session.title,
    scope: session.scope,
    categoryId: session.category_id ?? null,
    categoryName: session.category_name ?? null,
    blindMode: Number(session.blind_mode) === 1,
    blindHidden,
    includeZeroStock: Number(session.include_zero_stock) === 1,
    status: session.status,
    uncountedStrategy: session.uncounted_strategy ?? null,
    currency,
    notes: session.notes ?? '',
    totalLines: Number(session.total_lines ?? 0),
    countedLines: Number(session.counted_lines ?? 0),
    uncountedLines: Math.max(0, Number(session.total_lines ?? 0) - Number(session.counted_lines ?? 0)),
    totalVarianceQty: blindHidden ? null : Number(session.total_variance_qty ?? 0),
    totalSurplusCost: blindHidden ? null : signedMoneyJson(session.total_surplus_cost ?? 0, currency),
    totalShortageCost: blindHidden ? null : signedMoneyJson(session.total_shortage_cost ?? 0, currency),
    netVarianceCost: blindHidden ? null : signedMoneyJson(session.net_variance_cost ?? 0, currency),
    netVarianceRetail: blindHidden ? null : signedMoneyJson(session.net_variance_retail ?? 0, currency),
    journalEntryId: session.journal_entry_id ?? null,
    createdByUserId: session.created_by_user_id,
    createdByName: session.created_by_name ?? null,
    committedByUserId: session.committed_by_user_id ?? null,
    committedByName: session.committed_by_name ?? null,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    committedAt: session.committed_at ?? null,
    cancelledAt: session.cancelled_at ?? null,
  };
}

function loadStocktakeSessionDetail(ctx, sessionId, { includeBlindReview = false, lastScannedLineId = null } = {}) {
  const rawDb = database.getRawDatabase();
  const session = rawDb.prepare(`
    SELECT s.*, c.name AS category_name, u1.full_name AS created_by_name, u2.full_name AS committed_by_name
    FROM stocktake_sessions s
    LEFT JOIN categories c ON c.id = s.category_id AND c.tenant_id = s.tenant_id
    LEFT JOIN users u1 ON u1.id = s.created_by_user_id AND u1.tenant_id = s.tenant_id
    LEFT JOIN users u2 ON u2.id = s.committed_by_user_id AND u2.tenant_id = s.tenant_id
    WHERE s.id = ? AND s.tenant_id = ?
  `).get(sessionId, ctx.tenantId);

  if (!session) throw Object.assign(new Error('جلسة الجرد غير موجودة'), { status: 404 });
  assertStoreScope(ctx, session.store_id);

  const lineRows = rawDb.prepare(`
    SELECT l.*, ii.quantity_on_hand AS live_quantity, ii.wac_cost AS live_wac_cost, pv.attributes_json, p.image_path AS image_path
    FROM stocktake_lines l
    LEFT JOIN inventory_items ii ON ii.tenant_id = l.tenant_id AND ii.store_id = l.store_id AND ii.variant_id = l.variant_id
    LEFT JOIN product_variants pv ON pv.id = l.variant_id AND pv.tenant_id = l.tenant_id
    LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
    WHERE l.session_id = ? AND l.tenant_id = ?
    ORDER BY l.product_name ASC, l.sku ASC, l.created_at ASC
  `).all(session.id, ctx.tenantId);

  const currency = session.currency || 'EGP';
  const isCommitted = session.status === 'COMMITTED';
  const isDraft = session.status === 'DRAFT';
  const hideBlind = isDraft && Number(session.blind_mode) === 1 && !includeBlindReview;

  const totalLines = lineRows.length;
  let countedLines = 0;
  let matchedLines = 0;
  let discrepancyLines = 0;
  let surplusLines = 0;
  let shortageLines = 0;
  let surplusQty = 0;
  let shortageQty = 0;
  let totalVarianceQty = 0;
  let totalSurplusCostMinor = 0n;
  let totalShortageCostMinor = 0n;
  let netVarianceRetailMinor = 0n;
  let movedLinesCount = 0;
  let missingCostCount = 0;

  const lines = lineRows.map((line) => {
    const liveQty = Number(line.live_quantity ?? 0);
    const snapshotExpectedQty = Number(line.expected_quantity ?? 0);
    const effectiveExpectedQty = isCommitted ? Number(line.committed_expected_quantity ?? snapshotExpectedQty) : liveQty;
    const stockMovedSinceSnapshot = isDraft && liveQty !== snapshotExpectedQty;
    if (stockMovedSinceSnapshot) movedLinesCount += 1;

    const countedQty = line.counted_quantity === null || line.counted_quantity === undefined ? null : Number(line.counted_quantity);
    if (countedQty !== null) countedLines += 1;

    const liveWacMinor = BigInt(line.live_wac_cost ?? line.unit_wac ?? 0);
    const overrideCostMinor = line.override_unit_cost === null || line.override_unit_cost === undefined ? null : BigInt(line.override_unit_cost);
    const committedCostMinor = line.committed_unit_cost === null || line.committed_unit_cost === undefined ? null : BigInt(line.committed_unit_cost);
    const effectiveSurplusWacMinor = overrideCostMinor !== null ? overrideCostMinor : liveWacMinor;

    let varianceQty = null;
    let varianceCostMinor = 0n;
    let varianceRetailMinor = 0n;

    if (isCommitted) {
      varianceQty = line.committed_variance_qty === null || line.committed_variance_qty === undefined ? 0 : Number(line.committed_variance_qty);
      varianceCostMinor = BigInt(line.committed_variance_cost ?? 0);
      varianceRetailMinor = BigInt(varianceQty) * BigInt(line.retail_price ?? 0);
    } else if (countedQty !== null) {
      varianceQty = countedQty - effectiveExpectedQty;
      const costUnit = varianceQty > 0 ? effectiveSurplusWacMinor : liveWacMinor;
      varianceCostMinor = BigInt(varianceQty) * costUnit;
      varianceRetailMinor = BigInt(varianceQty) * BigInt(line.retail_price ?? 0);
    }

    if (varianceQty !== null) {
      if (varianceQty === 0) {
        matchedLines += 1;
      } else {
        discrepancyLines += 1;
        totalVarianceQty += varianceQty;
        if (varianceQty > 0) {
          surplusLines += 1;
          surplusQty += varianceQty;
          totalSurplusCostMinor += varianceCostMinor;
        } else {
          shortageLines += 1;
          shortageQty += -varianceQty;
          totalShortageCostMinor += -varianceCostMinor;
        }
        netVarianceRetailMinor += varianceRetailMinor;
      }
    }

    const needsSurplusCost = isDraft && countedQty !== null && (countedQty - effectiveExpectedQty) > 0 && overrideCostMinor === null && liveWacMinor <= 0n;
    if (needsSurplusCost) missingCostCount += 1;

    const unitCostDisplay = isCommitted && committedCostMinor !== null ? committedCostMinor : (varianceQty !== null && varianceQty > 0 ? effectiveSurplusWacMinor : liveWacMinor);

    return {
      id: line.id,
      variantId: line.variant_id,
      productId: line.product_id,
      productName: line.product_name,
      variantLabel: parseVariantLabelFromJson(line.attributes_json),
      sku: line.sku,
      barcode: line.barcode ?? null,
      imageUrl: line.image_path ?? null,
      categoryId: line.category_id ?? null,
      categoryName: line.category_name ?? null,
      expectedQuantity: hideBlind ? null : effectiveExpectedQty,
      snapshotExpectedQuantity: hideBlind ? null : snapshotExpectedQty,
      liveQuantity: hideBlind ? null : liveQty,
      stockMovedSinceSnapshot: hideBlind ? false : stockMovedSinceSnapshot,
      countedQuantity: countedQty,
      varianceQty: hideBlind ? null : varianceQty,
      unitWac: signedMoneyJson(unitCostDisplay, currency),
      retailPrice: signedMoneyJson(line.retail_price ?? 0, currency),
      overrideUnitCost: overrideCostMinor !== null ? signedMoneyJson(overrideCostMinor, currency) : null,
      needsSurplusCost,
      varianceCost: hideBlind ? null : signedMoneyJson(varianceCostMinor, currency),
      varianceRetail: hideBlind ? null : signedMoneyJson(varianceRetailMinor, currency),
      scannedCount: Number(line.scanned_count ?? 0),
      reason: line.reason ?? '',
      lastCountedAt: line.last_counted_at ?? null,
    };
  });

  const netVarianceCostMinor = totalSurplusCostMinor - totalShortageCostMinor;
  const baseSummary = serializeStocktakeSessionSummary(session);
  return {
    session: {
      ...baseSummary,
      blindHidden: hideBlind,
      totalLines,
      countedLines,
      uncountedLines: totalLines - countedLines,
      matchedLines: hideBlind ? null : matchedLines,
      discrepancyLines: hideBlind ? null : discrepancyLines,
      surplusLines: hideBlind ? null : surplusLines,
      shortageLines: hideBlind ? null : shortageLines,
      surplusQty: hideBlind ? null : surplusQty,
      shortageQty: hideBlind ? null : shortageQty,
      totalVarianceQty: hideBlind ? null : totalVarianceQty,
      totalSurplusCost: hideBlind ? null : signedMoneyJson(totalSurplusCostMinor, currency),
      totalShortageCost: hideBlind ? null : signedMoneyJson(totalShortageCostMinor, currency),
      netVarianceCost: hideBlind ? null : signedMoneyJson(netVarianceCostMinor, currency),
      netVarianceRetail: hideBlind ? null : signedMoneyJson(netVarianceRetailMinor, currency),
      movedLinesCount: hideBlind ? 0 : movedLinesCount,
      missingCostCount,
    },
    lines,
    lastScannedLineId,
  };
}

let betaOwnerBootstrapPromise = null;
async function ensureBetaOwnerContext(requestId = undefined) {
  if (!betaOwnerBootstrapPromise) {
    betaOwnerBootstrapPromise = (async () => {
      const tenants = await tenantRepo.listAll();
      if (tenants.length !== 1) throw new Error('Beta preview requires a single configured company');
      const tenant = tenants[0];
      let owner = await db
        .selectFrom('users')
        .select(['id', 'tenant_id', 'store_id', 'role'])
        .where('tenant_id', '=', tenant.id)
        .where('role', '=', 'OWNER')
        .where('is_active', '=', 1)
        .executeTakeFirst();
      if (!owner) {
        const ownerId = randomUUID();
        const passwordHash = await passwordHasher.hash(randomBytes(24).toString('base64url'));
        await db.insertInto('users').values({
          id: ownerId,
          tenant_id: tenant.id,
          store_id: null,
          username: 'beta_owner',
          password_hash: passwordHash,
          full_name: 'مدير النسخة التجريبية',
          phone: null,
          employment_start_date: null,
          role: 'OWNER',
          is_active: 1,
        }).execute();
        owner = { id: ownerId, tenant_id: tenant.id, store_id: null, role: 'OWNER' };
      }
      return owner;
    })().catch((err) => {
      betaOwnerBootstrapPromise = null;
      throw err;
    });
  }
  const owner = await betaOwnerBootstrapPromise;
  return new ScopedExecutionContext({
    tenantId: owner.tenant_id,
    userId: owner.id,
    roleId: 'OWNER',
    permissions: new Set(Object.values(Permissions)),
    correlationId: requestId ? String(requestId) : randomUUID(),
  });
}

async function requireContext(req) {
  const token = readCookie(req, 'retailos_session');
  if (!token) {
    if (betaAutoLoginEnabled && evaluateBetaTrialStatus().status === 'ACTIVE') {
      return ensureBetaOwnerContext(req.headers['x-request-id']);
    }
    throw Object.assign(new Error('يلزم تسجيل الدخول'), { status: 401 });
  }
  try {
    return await auth.validateSession(token, req.headers['x-request-id']);
  } catch {
    if (betaAutoLoginEnabled && evaluateBetaTrialStatus().status === 'ACTIVE') {
      return ensureBetaOwnerContext(req.headers['x-request-id']);
    }
    throw Object.assign(new Error('انتهت الجلسة. سجّل الدخول مرة أخرى.'), { status: 401 });
  }
}

function reportDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw Object.assign(new Error('Invalid report date'), { status: 400 });
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('Invalid report date'), { status: 400 });
  return parsed;
}

async function profitLossReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const from = reportDay(url.searchParams.get('from'));
  const to = reportDay(url.searchParams.get('to'));
  if (from > to) throw Object.assign(new Error('Report start date must be before end date'), { status: 400 });
  const requestedStore = url.searchParams.get('storeId');
  const stores = await storeRepo.listByTenant(ctx);
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const fromStr = url.searchParams.get('from');
  const toStr = url.searchParams.get('to');
  const bounds = queryRangeBounds(fromStr, toStr, url);
  const start = bounds.startIso;
  const endExclusive = bounds.endExclusiveIso;
  const sales = await db.selectFrom('sales').innerJoin('sale_items', 'sale_items.sale_id', 'sales.id')
    .select(['sales.id as id', 'sales.created_at as createdAt', 'sale_items.quantity as quantity', 'sale_items.unit_price as unitPrice', 'sale_items.line_discount as lineDiscount', 'sale_items.cart_discount_share as cartDiscountShare', 'sale_items.cost_of_goods_sold as cogs'])
    .where('sales.tenant_id', '=', ctx.tenantId).where('sales.store_id', '=', storeId).where('sales.status', '=', 'COMPLETED')
    .where('sales.created_at', '>=', start).where('sales.created_at', '<', endExclusive).execute();
  const returns = await db.selectFrom('customer_returns').select(['id', 'refund_amount as refundAmount', 'payment_method as paymentMethod', 'created_at as createdAt'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('created_at', '>=', start).where('created_at', '<', endExclusive).execute();
  const returnLines = returns.length ? await db.selectFrom('customer_return_items').select(['return_id as returnId', 'cost_amount as costAmount'])
    .where('tenant_id', '=', ctx.tenantId).where('return_id', 'in', returns.map((item) => item.id)).execute() : [];
  const varianceRows = await db.selectFrom('journal_entries').innerJoin('journal_lines', 'journal_lines.journal_entry_id', 'journal_entries.id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id').select(['journal_lines.entry_type as side', 'journal_lines.amount as amount'])
    .where('journal_entries.tenant_id', '=', ctx.tenantId).where('journal_entries.store_id', '=', storeId)
    .where('journal_entries.source_type', '=', 'SUPPLIER_RETURN').where('journal_entries.created_at', '>=', start)
    .where('journal_entries.created_at', '<', endExclusive).where('accounts.account_code', '=', '5090').execute();
  const invAdjustmentRows = await db.selectFrom('journal_entries').innerJoin('journal_lines', 'journal_lines.journal_entry_id', 'journal_entries.id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id').select(['journal_lines.entry_type as side', 'journal_lines.amount as amount'])
    .where('journal_entries.tenant_id', '=', ctx.tenantId).where('journal_entries.store_id', '=', storeId)
    .where('journal_entries.source_type', '=', 'ADJUSTMENT').where('journal_entries.created_at', '>=', start)
    .where('journal_entries.created_at', '<', endExclusive).where('accounts.account_code', '=', '5090').execute();
  const shiftClosingRows = await db.selectFrom('journal_entries').innerJoin('journal_lines', 'journal_lines.journal_entry_id', 'journal_entries.id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id').select(['accounts.account_code as code', 'journal_lines.entry_type as side', 'journal_lines.amount as amount'])
    .where('journal_entries.tenant_id', '=', ctx.tenantId).where('journal_entries.store_id', '=', storeId)
    .where('journal_entries.source_type', '=', 'SESSION_CLOSING').where('journal_entries.created_at', '>=', start)
    .where('journal_entries.created_at', '<', endExclusive).where('accounts.account_code', 'in', ['6090', '4010']).execute();
  const directExpenses = await db.selectFrom('operating_expense_records').select(['amount', 'payment_method as paymentMethod'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'DIRECT_DAILY')
    .where('deleted_at', 'is', null)
    .where('expense_date', '>=', fromStr).where('expense_date', '<=', toStr).execute();
  const monthlyPayments = await db.selectFrom('operating_expense_records').select(['amount', 'expense_date as expenseDate', 'payment_method as paymentMethod'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'MONTHLY_RECURRING_PAYMENT')
    .where('deleted_at', 'is', null)
    .where('expense_date', '>=', fromStr).where('expense_date', '<=', toStr).execute();
  const salePayments = await db.selectFrom('sale_payments').innerJoin('sales', 'sales.id', 'sale_payments.sale_id')
    .select(['sale_payments.sale_id as saleId', 'sale_payments.method as method', 'sale_payments.amount as amount', 'sales.change_given as changeGiven'])
    .where('sale_payments.tenant_id', '=', ctx.tenantId).where('sales.store_id', '=', storeId).where('sales.status', '=', 'COMPLETED')
    .where('sale_payments.created_at', '>=', start).where('sale_payments.created_at', '<', endExclusive).execute();
  const minYear = from.getUTCFullYear(), maxYear = to.getUTCFullYear();
  const actuals = await db.selectFrom('monthly_expense_actuals').selectAll().where('tenant_id', '=', ctx.tenantId)
    .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)]))
    .where('year', '>=', minYear).where('year', '<=', maxYear).execute();
  const obligations = await db.selectFrom('recurring_expense_obligations').select(['id', 'name'])
    .where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1)
    .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)])).execute();
  let grossSales = 0n, discounts = 0n, cogs = 0n;
  for (const line of sales) {
    const quantity = BigInt(line.quantity);
    grossSales += BigInt(line.unitPrice) * quantity;
    discounts += BigInt(line.lineDiscount) + BigInt(line.cartDiscountShare);
    cogs += BigInt(line.cogs);
  }
  const refunds = returns.reduce((sum, item) => sum + BigInt(item.refundAmount), 0n);
  const returnedCost = returnLines.reduce((sum, item) => sum + BigInt(item.costAmount), 0n);
  const inventoryCostVariance = varianceRows.reduce((sum, item) => sum + (item.side === 'DEBIT' ? BigInt(item.amount) : -BigInt(item.amount)), 0n);
  const inventoryAdjustmentsLoss = invAdjustmentRows.reduce((sum, item) => sum + (item.side === 'DEBIT' ? BigInt(item.amount) : -BigInt(item.amount)), 0n);
  const shiftCashVarianceLoss = shiftClosingRows.reduce((sum, item) => {
    if (item.code === '6090') return sum + (item.side === 'DEBIT' ? BigInt(item.amount) : -BigInt(item.amount));
    if (item.code === '4010') return sum - (item.side === 'CREDIT' ? BigInt(item.amount) : -BigInt(item.amount));
    return sum;
  }, 0n);
  cogs += inventoryCostVariance - returnedCost;
  const netSales = grossSales - discounts - refunds;
  const grossProfit = netSales - cogs;
  const directExpenseTotal = directExpenses.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  // Only deduct actually confirmed and paid monthly obligations:
  const monthlyExpenseTotal = monthlyPayments.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const missingMonthlyActuals = [];
  for (let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); cursor <= to; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth() + 1;
    for (const obligation of obligations) {
      if (!actuals.some((item) => item.obligation_id === obligation.id && item.year === year && item.month === month)) missingMonthlyActuals.push({ name: obligation.name, year, month });
    }
  }
  const operatingProfit = grossProfit - directExpenseTotal - monthlyExpenseTotal - inventoryAdjustmentsLoss - shiftCashVarianceLoss;
  const seenCashSaleChange = new Set();
  let totalCashChangeGiven = 0n;
  for (const item of salePayments) {
    if (item.method === 'CASH' && !seenCashSaleChange.has(item.saleId)) {
      seenCashSaleChange.add(item.saleId);
      totalCashChangeGiven += BigInt(item.changeGiven ?? 0);
    }
  }
  const cashSales = salePayments.filter((item) => item.method === 'CASH').reduce((sum, item) => sum + BigInt(item.amount), 0n)
    - totalCashChangeGiven
    - returns.filter((item) => item.paymentMethod === 'CASH').reduce((sum, item) => sum + BigInt(item.refundAmount), 0n);
  const electronicSales = salePayments.filter((item) => item.method !== 'CASH').reduce((sum, item) => sum + BigInt(item.amount), 0n)
    - returns.filter((item) => item.paymentMethod !== 'CASH').reduce((sum, item) => sum + BigInt(item.refundAmount), 0n);
  const directCashOutflow = directExpenseTotal;
  const monthlyCashOutflow = monthlyPayments.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const unpaid = await db.selectFrom('monthly_expense_actuals').select(['amount', 'paid_amount as paidAmount'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .where((eb) => eb.or([eb('year', '<', to.getUTCFullYear()), eb.and([eb('year', '=', to.getUTCFullYear()), eb('month', '<=', to.getUTCMonth() + 1)])])).execute();
  const pendingDue = unpaid.reduce((sum, item) => sum + BigInt(item.amount) - BigInt(item.paidAmount), 0n);

  const rawDb = database.getRawDatabase();
  const userRowsPl = rawDb.prepare('SELECT id, full_name, username FROM users WHERE tenant_id = ?').all(ctx.tenantId);
  const userMapPl = new Map(userRowsPl.map((u) => [u.id, u.full_name || u.username]));

  const supInitRows = rawDb.prepare(`
    SELECT p.id, p.invoice_number, COALESCE(p.purchased_at, p.created_at) AS paid_at,
      p.initial_paid_amount AS amount, p.notes, p.created_by_user_id,
      s.id AS supplier_id, s.name AS supplier_name
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND ${unrepresentedInitialPaidSql('p')} > 0
      AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ?
      AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?
    ORDER BY COALESCE(p.purchased_at, p.created_at) DESC
  `).all(ctx.tenantId, storeId, start, endExclusive);

  const supPayRows = rawDb.prepare(`
    SELECT sp.id, sp.purchase_id, sp.idempotency_key, p.invoice_number, COALESCE(sp.paid_at, sp.created_at) AS paid_at,
      sp.amount, sp.payment_method, sp.reference_number, sp.created_by_user_id,
      s.id AS supplier_id, s.name AS supplier_name
    FROM supplier_payments sp
    INNER JOIN supplier_purchases p ON p.id = sp.purchase_id AND p.tenant_id = sp.tenant_id
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE sp.tenant_id = ? AND p.store_id = ? AND sp.deleted_at IS NULL
      AND replace(COALESCE(sp.paid_at, sp.created_at), ' ', 'T') >= ?
      AND replace(COALESCE(sp.paid_at, sp.created_at), ' ', 'T') < ?
    ORDER BY COALESCE(sp.paid_at, sp.created_at) DESC
  `).all(ctx.tenantId, storeId, start, endExclusive);

  const supRetCreditRow = rawDb.prepare(`
    SELECT COALESCE(SUM(credit_amount), 0) AS total_credit
    FROM supplier_returns
    WHERE tenant_id = ? AND store_id = ?
      AND replace(created_at, ' ', 'T') >= ? AND replace(created_at, ' ', 'T') < ?
  `).get(ctx.tenantId, storeId, start, endExclusive);

  const plExpenseRows = rawDb.prepare(`
    SELECT oer.id, oer.expense_date, COALESCE(oer.created_at, oer.expense_date) AS recorded_at,
      oer.amount, oer.payment_method, oer.notes, oer.reference_number, oer.expense_type, oer.created_by_user_id,
      COALESCE(ec.name, 'مصروف تشغيلي') AS category_name,
      COALESCE(reo.name, ec.name, 'التزام شهري') AS obligation_name
    FROM operating_expense_records oer
    LEFT JOIN expense_categories ec ON ec.id = oer.category_id AND ec.tenant_id = oer.tenant_id
    LEFT JOIN monthly_expense_actuals mea ON mea.id = oer.monthly_actual_id AND mea.tenant_id = oer.tenant_id
    LEFT JOIN recurring_expense_obligations reo ON reo.id = mea.obligation_id AND reo.tenant_id = oer.tenant_id
    WHERE oer.tenant_id = ? AND oer.store_id = ?
      AND oer.deleted_at IS NULL
      AND oer.expense_date >= ? AND oer.expense_date <= ?
    ORDER BY oer.expense_date DESC, COALESCE(oer.created_at, oer.expense_date) DESC
  `).all(ctx.tenantId, storeId, fromStr, toStr);

  const money = (amount) => moneyJson(Money.fromMinor(amount, tenant.currency));

  const expenseItems = plExpenseRows.map((row) => {
    const isMonthly = row.expense_type === 'MONTHLY_RECURRING_PAYMENT';
    return {
      id: row.id,
      expenseDate: row.expense_date,
      recordedAt: row.recorded_at,
      type: isMonthly ? 'MONTHLY' : 'DAILY',
      categoryName: isMonthly ? row.obligation_name : row.category_name,
      paymentMethod: row.payment_method,
      notes: row.notes || row.reference_number || '',
      actorName: userMapPl.get(row.created_by_user_id) || 'المسؤول',
      amount: money(BigInt(row.amount ?? 0)),
    };
  });

  let supplierInitialPaid = 0n;
  let supplierInstallmentPaid = 0n;
  const supplierPaymentItems = [];

  for (const row of supInitRows) {
    const amt = BigInt(row.amount ?? 0);
    supplierInitialPaid += amt;
    supplierPaymentItems.push({
      id: `${row.id}-init`,
      purchaseId: row.id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      invoiceNumber: row.invoice_number || row.id.slice(0, 8),
      type: 'INITIAL',
      paymentMethod: 'CASH',
      referenceNumber: null,
      paidAt: row.paid_at,
      actorName: userMapPl.get(row.created_by_user_id) || 'المسؤول',
      amount: money(amt),
    });
  }
  for (const row of supPayRows) {
    const amt = BigInt(row.amount ?? 0);
    const isInitial = String(row.idempotency_key || '').endsWith(':initial') || String(row.id || '').endsWith(':payment:initial');
    if (isInitial) supplierInitialPaid += amt;
    else supplierInstallmentPaid += amt;
    supplierPaymentItems.push({
      id: row.id,
      purchaseId: row.purchase_id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      invoiceNumber: row.invoice_number || row.purchase_id.slice(0, 8),
      type: isInitial ? 'INITIAL' : 'INSTALLMENT',
      paymentMethod: row.payment_method || 'CASH',
      referenceNumber: row.reference_number || null,
      paidAt: row.paid_at,
      actorName: userMapPl.get(row.created_by_user_id) || 'المسؤول',
      amount: money(amt),
    });
  }
  supplierPaymentItems.sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)));

  const totalSupplierPaid = supplierInitialPaid + supplierInstallmentPaid;
  const supplierReturnsCreditTotal = BigInt(supRetCreditRow?.total_credit ?? 0);
  const supRefundRow = rawDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total_refunded
    FROM supplier_refunds
    WHERE tenant_id = ? AND store_id = ?
      AND replace(COALESCE(refunded_at, created_at), ' ', 'T') >= ?
      AND replace(COALESCE(refunded_at, created_at), ' ', 'T') < ?
  `).get(ctx.tenantId, storeId, start, endExclusive);
  const totalSupplierRefunded = BigInt(supRefundRow?.total_refunded ?? 0);
  const openingCashRow = rawDb.prepare(`
    SELECT COALESCE(SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS cash_in
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    INNER JOIN accounts a ON a.id = jl.account_id
    WHERE je.tenant_id = ? AND je.store_id = ?
      AND je.idempotency_key LIKE 'opening-balance:%'
      AND a.account_code IN ('1010', '1015', '1020')
      AND je.entry_date >= ? AND je.entry_date <= ?
  `).get(ctx.tenantId, storeId, fromStr, toStr);
  const openingCashIn = BigInt(openingCashRow?.cash_in ?? 0);
  const netCollections = cashSales + electronicSales;
  const totalCashOutflows = directCashOutflow + monthlyCashOutflow + totalSupplierPaid;
  const netCashRemaining = netCollections + totalSupplierRefunded + openingCashIn - totalCashOutflows;

  return { storeId, from: fromStr, to: toStr, currency: tenant.currency, missingMonthlyActuals,
    profitLoss: {
      grossSales: money(grossSales),
      discounts: money(discounts),
      returns: money(refunds),
      netSales: money(netSales),
      cogs: money(cogs),
      grossProfit: money(grossProfit),
      directExpenses: money(directExpenseTotal),
      monthlyExpenses: money(monthlyExpenseTotal),
      inventoryAdjustmentsLoss: money(inventoryAdjustmentsLoss),
      shiftCashVarianceLoss: money(shiftCashVarianceLoss),
      operatingProfit: money(operatingProfit),
    },
    expenseItems,
    cashFlow: { cashSales: money(cashSales), electronicSales: money(electronicSales), directExpenseOutflow: money(directCashOutflow), monthlyObligationOutflow: money(monthlyCashOutflow), pendingUnpaidObligations: money(pendingDue) },
    supplierPayments: {
      initialPaid: money(supplierInitialPaid),
      installmentPaid: money(supplierInstallmentPaid),
      totalPaid: money(totalSupplierPaid),
      supplierReturnsCredit: money(supplierReturnsCreditTotal),
      supplierRefunded: money(totalSupplierRefunded),
      count: supplierPaymentItems.length,
      items: supplierPaymentItems,
    },
    cashPosition: {
      totalCollections: money(netCollections),
      cashCollections: money(cashSales),
      electronicCollections: money(electronicSales),
      supplierRefundsReceived: money(totalSupplierRefunded),
      openingCashIn: money(openingCashIn),
      directExpenses: money(directCashOutflow),
      monthlyExpenses: money(monthlyCashOutflow),
      supplierPayments: money(totalSupplierPaid),
      totalOutflows: money(totalCashOutflows),
      netCashRemaining: money(netCashRemaining),
    } };
}

let activeBackupPromise = null;
let restoreMaintenanceMode = false;
let activeApiRequestCount = 0;
let walCheckpointTimer = null;
let initialDailyBackupTimer = null;
const scheduledDatabaseTasks = new Set();

function runScheduledDatabaseTask(task) {
  if (restoreMaintenanceMode) return;
  const pending = Promise.resolve().then(async () => {
    if (process.env.NODE_ENV === 'test' && typeof options.beforeScheduledDatabaseTask === 'function') {
      await options.beforeScheduledDatabaseTask();
    }
    return task();
  });
  scheduledDatabaseTasks.add(pending);
  void pending.then(
    () => scheduledDatabaseTasks.delete(pending),
    () => scheduledDatabaseTasks.delete(pending),
  );
}

function stopScheduledDatabaseTasks() {
  if (walCheckpointTimer) clearInterval(walCheckpointTimer);
  if (initialDailyBackupTimer) clearTimeout(initialDailyBackupTimer);
  walCheckpointTimer = null;
  initialDailyBackupTimer = null;
}

function startScheduledDatabaseTasks() {
  if (restoreMaintenanceMode || walCheckpointTimer) return;
  walCheckpointTimer = setInterval(() => {
    runScheduledDatabaseTask(async () => {
      database.checkpointPassive();
      pruneFailedLogins();
      pruneFailedPasswordChanges();
      await ensureDailyBackup({ force: false }).catch(() => undefined);
      await db
        .deleteFrom('sessions')
        .where((eb) => eb.or([eb('is_revoked', '=', 1), eb('expires_at', '<', new Date().toISOString())]))
        .execute()
        .catch(() => undefined);
    });
  }, 5 * 60 * 1000);
  walCheckpointTimer.unref();
  initialDailyBackupTimer = setTimeout(() => {
    initialDailyBackupTimer = null;
    runScheduledDatabaseTask(() => ensureDailyBackup({ force: false }));
  }, 1500);
  initialDailyBackupTimer.unref();
}

async function enterRestoreMaintenanceMode() {
  if (restoreMaintenanceMode) {
    throw Object.assign(new Error('Database restore is already in progress'), { status: 503, code: 'RESTORE_IN_PROGRESS' });
  }
  restoreMaintenanceMode = true;
  stopScheduledDatabaseTasks();
  if (process.env.NODE_ENV === 'test' && typeof options.onRestoreMaintenanceStarted === 'function') {
    options.onRestoreMaintenanceStarted();
  }
  const deadline = Date.now() + 30_000;
  try {
    // The restoring request itself is counted; wait for every other API request to finish.
    while (activeApiRequestCount > 1) {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('Timed out waiting for active requests before restore'), { status: 503, code: 'RESTORE_DRAIN_TIMEOUT' });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (activeBackupPromise) await activeBackupPromise;
    while (scheduledDatabaseTasks.size > 0) {
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('Timed out waiting for scheduled database work before restore'), { status: 503, code: 'RESTORE_TASK_DRAIN_TIMEOUT' });
      }
      await Promise.all(Array.from(scheduledDatabaseTasks));
    }
  } catch (error) {
    restoreMaintenanceMode = false;
    startScheduledDatabaseTasks();
    throw error;
  }
}

async function waitAtRestoreTestBarrier() {
  if (process.env.NODE_ENV === 'test' && typeof options.beforeRestoreInstall === 'function') {
    await options.beforeRestoreInstall();
  }
}

function restoreFileOperationsForTest() {
  return process.env.NODE_ENV === 'test' ? options.restoreFileOperations : undefined;
}

function validateMirrorPath(rawInput) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) return '';
  const resolved = resolve(trimmed);
  if (!isAbsolute(resolved)) {
    throw Object.assign(new Error('يجب إدخال مسار كامل للمجلد الخارجي، مثل E:\\RafBackups'), { status: 400 });
  }
  const parsedRoot = parse(resolved).root;
  if (resolved.toLowerCase() === parsedRoot.toLowerCase()) {
    throw Object.assign(new Error('يرجى تحديد اسم مجلد داخل القرص، مثل E:\\RafBackups بدلاً من جذر القرص مباشرة'), { status: 400 });
  }
  const normalizedDataDir = resolve(dataDir);
  const relToData = relative(normalizedDataDir, resolved);
  if (relToData === '' || (!relToData.startsWith('..') && !isAbsolute(relToData))) {
    throw Object.assign(new Error('يجب أن يكون المجلد الخارجي خارج مجلد بيانات البرنامج نفسه لضمان الأمان إذا تعطل النظام'), { status: 400 });
  }
  const lower = resolved.toLowerCase();
  const forbiddenPrefixes = [
    'c:\\windows',
    'c:\\program files',
    'c:\\programdata',
    '/windows',
    '/etc',
    '/bin',
    '/usr',
    '/system',
  ];
  if (forbiddenPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix}${sep}`))) {
    throw Object.assign(new Error('لا يمكن حفظ النسخ الاحتياطية داخل مجلدات نظام التشغيل'), { status: 400 });
  }
  return resolved;
}

function detectBackupDestinations() {
  const destinations = [];
  const seen = new Set();
  const addDest = (pathValue, label, kind, available = true) => {
    const clean = resolve(pathValue);
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    destinations.push({ path: clean, label, kind, available });
  };

  const home = homedir();
  const dataRoot = parse(resolve(dataDir)).root.toLowerCase();

  const cloudCandidates = [
    [process.env.OneDrive, 'OneDrive (مزامنة سحابية تلقائية)'],
    [process.env.OneDriveCommercial, 'OneDrive للأعمال (مزامنة سحابية)'],
    [join(home, 'OneDrive'), 'OneDrive (مزامنة سحابية تلقائية)'],
    [join(home, 'Google Drive'), 'Google Drive (مزامنة سحابية تلقائية)'],
    [join(home, 'My Drive'), 'Google Drive (مزامنة سحابية تلقائية)'],
    [join(home, 'Dropbox'), 'Dropbox (مزامنة سحابية تلقائية)'],
  ];
  for (const [base, label] of cloudCandidates) {
    if (base && existsSync(base)) {
      addDest(join(base, 'RafBackups'), label, 'CLOUD', true);
    }
  }

  if (process.platform === 'win32') {
    for (let code = 68; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      const driveRoot = `${letter}:\\`;
      if (driveRoot.toLowerCase() === dataRoot) continue;
      try {
        if (existsSync(driveRoot)) {
          addDest(`${driveRoot}RafBackups`, `قرص أو فلاشة (${letter}:) — خارج قرص النظام`, 'EXTERNAL_DRIVE', true);
        }
      } catch { /* ignore inaccessible drive */ }
    }
  }

  const docsDir = join(home, 'Documents');
  if (existsSync(docsDir)) {
    addDest(join(docsDir, 'RafBackups'), 'مجلد المستندات (Documents) على الجهاز', 'LOCAL', true);
  }
  return destinations;
}

async function copyFileAtomic(sourcePath, destinationPath) {
  const destDir = dirname(destinationPath);
  const tempPath = join(destDir, `.tmp-${randomUUID().slice(0, 8)}-${parse(destinationPath).base}`);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, destinationPath);
  } finally {
    if (existsSync(tempPath)) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function syncDailyBackupToMirror(sourceDailyPath, dailyFilename, currentSettings = null) {
  const settings = currentSettings ?? await readBackupSettings();
  const mirrorDir = settings.mirrorPath?.trim();
  if (!mirrorDir) {
    return { status: 'UNCONFIGURED', lastMirrorAt: settings.lastMirrorAt, lastMirrorError: null, connected: false };
  }
  const mirrorRoot = parse(mirrorDir).root;
  if (mirrorRoot && !existsSync(mirrorRoot)) {
    const next = {
      ...settings,
      lastMirrorStatus: 'DISCONNECTED',
      lastMirrorError: `محرك الأقراص (${mirrorRoot}) غير متصل حاليًا — وصّل الفلاشة أو الهارد الخارجي وستتم المزامنة تلقائيًا.`,
    };
    await writeBackupSettings(next).catch(() => undefined);
    return { status: next.lastMirrorStatus, lastMirrorAt: next.lastMirrorAt, lastMirrorError: next.lastMirrorError, connected: false };
  }
  try {
    await mkdir(mirrorDir, { recursive: true });
    await copyFileAtomic(sourceDailyPath, join(mirrorDir, dailyFilename));
    await copyFileAtomic(sourceDailyPath, join(mirrorDir, 'retailos-latest.rfbackup'));
    // Clean up any legacy unencrypted .sqlite mirror files once encrypted .rfbackup exists
    const mirrorAll = await readdir(mirrorDir);
    for (const stale of mirrorAll) {
      if (/^retailos-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(stale) || stale === 'retailos-latest.sqlite') {
        await rm(join(mirrorDir, stale), { force: true }).catch(() => undefined);
      }
    }
    const mirrorFiles = (await readdir(mirrorDir))
      .filter((f) => /^retailos-daily-\d{4}-\d{2}-\d{2}\.rfbackup$/.test(f))
      .sort()
      .reverse();
    for (const oldFile of mirrorFiles.slice(MAX_DAILY_BACKUPS)) {
      await rm(join(mirrorDir, oldFile), { force: true }).catch(() => undefined);
    }
    const next = {
      ...settings,
      lastMirrorAt: new Date().toISOString(),
      lastMirrorStatus: 'OK',
      lastMirrorError: null,
    };
    await writeBackupSettings(next).catch(() => undefined);
    return { status: 'OK', lastMirrorAt: next.lastMirrorAt, lastMirrorError: null, connected: true };
  } catch (error) {
    const next = {
      ...settings,
      lastMirrorStatus: 'ERROR',
      lastMirrorError: error instanceof Error ? error.message : 'تعذر النسخ إلى المجلد الخارجي',
    };
    await writeBackupSettings(next).catch(() => undefined);
    return { status: 'ERROR', lastMirrorAt: next.lastMirrorAt, lastMirrorError: next.lastMirrorError, connected: false };
  }
}

async function ensureDailyBackup({ force = false, minAgeMs = AUTO_DAILY_REFRESH_MS, syncMirror = true } = {}) {
  if (activeDailyKeyPersistPromise) {
    throw Object.assign(
      new Error('لا يمكن إنشاء أو تحديث نسخة احتياطية أثناء حفظ مفتاح التشفير الرئيسي — أعد المحاولة بعد اكتمال الحفظ'),
      { status: 409, code: 'BACKUP_KEY_PERSIST_IN_PROGRESS', exposeMessage: true },
    );
  }
  if (activeBackupPromise) return activeBackupPromise;
  activeBackupPromise = (async () => {
    await mkdir(dailyBackupDir, { recursive: true });
    const localDate = businessDateInTimeZone(new Date(), companyConfig.timezone);
    const filename = `retailos-daily-${localDate}.rfbackup`;
    const targetPath = join(dailyBackupDir, filename);
    const settings = await readBackupSettings();

    if (!force && existsSync(targetPath)) {
      const fileStat = await stat(targetPath);
      const ageMs = Date.now() - fileStat.mtimeMs;
      if (ageMs < minAgeMs) {
        if (syncMirror && settings.autoMirror && settings.mirrorPath) {
          const mirrorDailyPath = join(settings.mirrorPath, filename);
          if (settings.lastMirrorStatus !== 'OK' || !existsSync(mirrorDailyPath)) {
            await syncDailyBackupToMirror(targetPath, filename, settings).catch(() => undefined);
          }
        }
        return { filename, date: localDate, size: fileStat.size, encrypted: true, updatedAt: fileStat.mtime.toISOString(), createdNew: false };
      }
    }

    const dailyPassphrase = resolveDailyBackupPassphraseSync();
    let createdBackup = null;
    try {
      database.checkpointPassive();
      createdBackup = await createEncryptedSqliteBackup(database.getRawDatabase(), dailyBackupDir, dailyPassphrase);
      await copyFileAtomic(createdBackup.path, targetPath);
    } finally {
      if (createdBackup?.path) {
        await removeBackupArtifact(createdBackup.path).catch(() => undefined);
      }
    }

    // Remove legacy plaintext daily backups once encrypted snapshot is written
    const allDaily = await readdir(dailyBackupDir);
    for (const f of allDaily) {
      if (/^retailos-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)) {
        await rm(join(dailyBackupDir, f), { force: true }).catch(() => undefined);
      }
    }

    const files = allDaily
      .filter((f) => /^retailos-daily-\d{4}-\d{2}-\d{2}\.rfbackup$/.test(f))
      .sort()
      .reverse();
    for (const oldFile of files.slice(MAX_DAILY_BACKUPS)) {
      await rm(join(dailyBackupDir, oldFile), { force: true }).catch(() => undefined);
    }

    if (syncMirror && settings.autoMirror && settings.mirrorPath) {
      await syncDailyBackupToMirror(targetPath, filename, settings).catch(() => undefined);
    }

    const fileStat = await stat(targetPath);
    return { filename, date: localDate, size: fileStat.size, encrypted: true, updatedAt: fileStat.mtime.toISOString(), createdNew: true };
  })();
  try {
    return await activeBackupPromise;
  } finally {
    activeBackupPromise = null;
  }
}

async function createPreRestoreSafetySnapshot() {
  await mkdir(preRestoreBackupDir, { recursive: true });
  const preStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestorePath = join(preRestoreBackupDir, `retailos-pre-restore-${preStamp}.sqlite`);
  const tempPath = `${preRestorePath}.${randomBytes(6).toString('hex')}.tmp`;
  database.checkpointPassive();
  try {
    // Write to a temp file, verify it, then atomically publish; a torn/corrupt snapshot never
    // appears under the final name and the restore is aborted before touching the live database.
    await database.getRawDatabase().backup(tempPath);
    const quick = checkSqliteFileQuick(tempPath);
    if (!quick.ok) {
      throw Object.assign(new Error('Pre-restore safety snapshot failed verification; restore aborted'), { status: 500 });
    }
    await rename(tempPath, preRestorePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const existing = (await readdir(preRestoreBackupDir))
    .filter((f) => /^retailos-pre-restore-.*\.sqlite$/.test(f))
    .sort()
    .reverse();
  for (const oldFile of existing.slice(10)) {
    await rm(join(preRestoreBackupDir, oldFile), { force: true }).catch(() => undefined);
  }
  return preRestorePath;
}

async function getBackupSafetyPayload() {
  const settings = await readBackupSettings();
  const backups = await listDailyBackups();
  const integrity = database.checkQuickIntegrity();
  const mirrorRoot = settings.mirrorPath ? parse(settings.mirrorPath).root : '';
  const mirrorConnected = Boolean(settings.mirrorPath && (!mirrorRoot || existsSync(mirrorRoot)));
  return {
    enabled: true,
    autoSchedule: 'DAILY_NIGHTLY',
    retentionDays: MAX_DAILY_BACKUPS,
    refreshMinutes: Math.round(AUTO_DAILY_REFRESH_MS / 60000),
    scheduleLabel: 'نسخ احتياطي يومي تلقائي محدث كل 30 دقيقة وعند الإغلاق + حماية فورية ضد انقطاع الكهرباء',
    integrity: {
      status: integrity.ok ? 'OK' : 'WARN',
      quickCheckOk: integrity.ok,
      messages: integrity.messages,
      journalMode: 'WAL',
      synchronousMode: 'FULL',
      checkedAt: new Date().toISOString(),
    },
    startupRecovery: {
      restoredAfterCrash,
      startupRecoveryInfo,
    },
    mirror: {
      mirrorPath: settings.mirrorPath,
      autoMirror: settings.autoMirror,
      connected: mirrorConnected,
      lastMirrorAt: settings.lastMirrorAt,
      lastMirrorStatus: settings.mirrorPath ? (mirrorConnected ? settings.lastMirrorStatus : 'DISCONNECTED') : 'UNCONFIGURED',
      lastMirrorError: mirrorConnected ? settings.lastMirrorError : (settings.mirrorPath ? `محرك الأقراص (${mirrorRoot}) غير متصل حاليًا` : null),
      suggestedDestinations: detectBackupDestinations(),
    },
    latestBackup: backups[0] ?? null,
    backups,
    historicalKeysCount: historicalDailyBackupKeys.length,
  };
}

async function listDailyBackups() {
  await mkdir(dailyBackupDir, { recursive: true });
  const names = (await readdir(dailyBackupDir))
    .filter((f) => /^retailos-daily-\d{4}-\d{2}-\d{2}\.(rfbackup|sqlite)$/.test(f))
    .sort()
    .reverse();
  const backups = [];
  for (const filename of names) {
    try {
      const fileStat = await stat(join(dailyBackupDir, filename));
      const dateMatch = filename.match(/^retailos-daily-(\d{4}-\d{2}-\d{2})\.(rfbackup|sqlite)$/);
      backups.push({
        filename,
        date: dateMatch ? dateMatch[1] : filename,
        encrypted: filename.endsWith('.rfbackup'),
        size: fileStat.size,
        sizeBytes: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        createdAt: fileStat.mtime.toISOString(),
      });
    } catch { /* ignore transient file race */ }
  }
  return backups;
}

async function topProductsReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_DAILY_VIEW);
  const fromValue = url.searchParams.get('from');
  const toValue = url.searchParams.get('to');
  if ((fromValue === null) !== (toValue === null)) throw Object.assign(new Error('Both report dates are required'), { status: 400 });
  let start = null, endExclusive = null;
  if (fromValue && toValue) {
    const from = reportDay(fromValue), to = reportDay(toValue);
    if (from > to) throw Object.assign(new Error('Report start date must be before end date'), { status: 400 });
    const bounds = queryRangeBounds(fromValue, toValue, url);
    start = bounds.startIso;
    endExclusive = bounds.endExclusiveIso;
  }
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const rawDb = database.getRawDatabase();
  const result = rawDb.prepare(`
    SELECT p.id AS productId, p.name AS productName, p.sku AS productSku,
      SUM(si.quantity - COALESCE((SELECT SUM(ri.quantity) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS unitsSold,
      SUM(COALESCE((SELECT SUM(ri.quantity) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS returnedUnits,
      SUM(si.net_revenue - COALESCE((SELECT SUM(ri.refund_amount) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS netRevenue,
      SUM(si.cost_of_goods_sold - COALESCE((SELECT SUM(ri.cost_amount) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS netCogs,
      COUNT(DISTINCT s.id) AS orderCount
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id AND s.store_id = si.store_id
    INNER JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
    WHERE si.tenant_id = ? AND si.store_id = ? AND s.status = 'COMPLETED'
      AND (? IS NULL OR s.created_at >= ?)
      AND (? IS NULL OR s.created_at < ?)
    GROUP BY p.id, p.name, p.sku
    HAVING unitsSold > 0
  `).all(ctx.tenantId, storeId, start, start, endExclusive, endExclusive);
  const products = result.map((row) => {
    const revMinor = BigInt(row.netRevenue ?? 0);
    const cogsMinor = BigInt(row.netCogs ?? 0);
    const profitMinor = revMinor - cogsMinor;
    const marginPercent = revMinor > 0n ? Number((profitMinor * 100n) / revMinor) : 0;
    return {
      id: row.productId,
      name: row.productName,
      sku: row.productSku,
      unitsSold: String(row.unitsSold),
      returnedUnits: String(row.returnedUnits ?? 0),
      netRevenue: moneyJson(Money.fromMinor(revMinor, tenant.currency)),
      cogs: moneyJson(Money.fromMinor(cogsMinor, tenant.currency)),
      grossProfit: moneyJson(Money.fromMinor(profitMinor, tenant.currency)),
      marginPercent,
      orderCount: String(row.orderCount),
    };
  });
  const byUnits = [...products].sort((a, b) => {
    if (a.unitsSold !== b.unitsSold) return BigInt(a.unitsSold) > BigInt(b.unitsSold) ? -1 : 1;
    if (a.netRevenue.amount !== b.netRevenue.amount) return BigInt(a.netRevenue.amount) > BigInt(b.netRevenue.amount) ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const byRevenue = [...products].sort((a, b) => {
    if (a.netRevenue.amount !== b.netRevenue.amount) return BigInt(a.netRevenue.amount) > BigInt(b.netRevenue.amount) ? -1 : 1;
    if (a.unitsSold !== b.unitsSold) return BigInt(a.unitsSold) > BigInt(b.unitsSold) ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const byProfit = [...products].sort((a, b) => {
    if (a.grossProfit.amount !== b.grossProfit.amount) return BigInt(a.grossProfit.amount) > BigInt(b.grossProfit.amount) ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Most purchased / ordered products from suppliers ("أكثر المنتجات التي طلبناها وجت")
  const purchasedRows = rawDb.prepare(`
    SELECT COALESCE(p.id, spi.variant_id) AS productId,
           COALESCE(p.name, spi.product_name) AS productName,
           COALESCE(p.sku, spi.sku) AS productSku,
           SUM(spi.quantity) AS unitsOrdered,
           SUM(COALESCE((SELECT SUM(sri.quantity) FROM supplier_return_items sri WHERE sri.tenant_id = spi.tenant_id AND sri.purchase_item_id = spi.id), 0)) AS returnedToSupplier,
           SUM(spi.quantity * spi.unit_cost) AS totalPurchaseCost,
           COUNT(DISTINCT sp.id) AS purchaseInvoiceCount
    FROM supplier_purchase_items spi
    INNER JOIN supplier_purchases sp ON sp.id = spi.purchase_id AND sp.tenant_id = spi.tenant_id AND sp.store_id = spi.store_id
    LEFT JOIN product_variants pv ON pv.id = spi.variant_id AND pv.tenant_id = spi.tenant_id
    LEFT JOIN products p ON p.id = pv.product_id AND p.tenant_id = spi.tenant_id
    WHERE spi.tenant_id = ? AND spi.store_id = ?
      AND (? IS NULL OR replace(COALESCE(sp.purchased_at, sp.created_at), ' ', 'T') >= ?)
      AND (? IS NULL OR replace(COALESCE(sp.purchased_at, sp.created_at), ' ', 'T') < ?)
    GROUP BY COALESCE(p.id, spi.variant_id), COALESCE(p.name, spi.product_name), COALESCE(p.sku, spi.sku)
    HAVING unitsOrdered > 0
  `).all(ctx.tenantId, storeId, start, start, endExclusive, endExclusive);
  const mostPurchasedProducts = purchasedRows.map((row) => {
    const ordered = BigInt(row.unitsOrdered ?? 0);
    const returned = BigInt(row.returnedToSupplier ?? 0);
    const netReceived = ordered - returned;
    const totalCostMinor = BigInt(row.totalPurchaseCost ?? 0);
    const avgCostMinor = ordered > 0n ? totalCostMinor / ordered : 0n;
    return {
      id: row.productId,
      name: row.productName,
      sku: row.productSku,
      unitsOrdered: ordered.toString(),
      returnedUnits: returned.toString(),
      netUnitsReceived: netReceived.toString(),
      invoiceCount: String(row.purchaseInvoiceCount ?? 0),
      totalCost: moneyJson(Money.fromMinor(totalCostMinor, tenant.currency)),
      avgUnitCost: moneyJson(Money.fromMinor(avgCostMinor, tenant.currency)),
    };
  }).sort((a, b) => BigInt(b.unitsOrdered) !== BigInt(a.unitsOrdered) ? (BigInt(b.unitsOrdered) > BigInt(a.unitsOrdered) ? 1 : -1) : (BigInt(b.totalCost.amount) > BigInt(a.totalCost.amount) ? 1 : -1));

  // Variant / Size / Color breakdown
  const variantRows = rawDb.prepare(`
    SELECT si.variant_id AS variantId, si.product_name AS itemLabel, si.sku AS sku, si.variant_attributes_json AS attrsJson, p.name AS productName, p.options_json AS optionsJson,
      SUM(si.quantity - COALESCE((SELECT SUM(ri.quantity) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS unitsSold,
      SUM(si.net_revenue - COALESCE((SELECT SUM(ri.refund_amount) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS netRevenue
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id AND s.store_id = si.store_id
    INNER JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
    WHERE si.tenant_id = ? AND si.store_id = ? AND s.status = 'COMPLETED'
      AND (? IS NULL OR s.created_at >= ?)
      AND (? IS NULL OR s.created_at < ?)
    GROUP BY si.variant_id, si.product_name, si.sku, si.variant_attributes_json, p.name, p.options_json
    HAVING unitsSold > 0
  `).all(ctx.tenantId, storeId, start, start, endExclusive, endExclusive);
  const sizeCounter = new Map();
  const colorCounter = new Map();
  let totalVariantUnits = 0n;
  const topVariants = variantRows.map((row) => {
    const qty = BigInt(row.unitsSold ?? 0);
    totalVariantUnits += qty;
    let attrs = {};
    let opts = [];
    try { attrs = JSON.parse(row.attrsJson || '{}'); } catch { /* ignore */ }
    try { opts = JSON.parse(row.optionsJson || '[]'); } catch { /* ignore */ }
    for (const [k, v] of Object.entries(attrs)) {
      const optName = (opts.find((o) => o.key === k)?.name ?? k).toLowerCase();
      const val = String(v).trim();
      if (!val) continue;
      if (optName.includes('مقاس') || optName.includes('size') || /^(2[89]|3\d|4\d|50|xs|s|m|l|xl|xxl|xxxl)$/i.test(val)) {
        sizeCounter.set(val, (sizeCounter.get(val) ?? 0n) + qty);
      } else if (optName.includes('لون') || optName.includes('color') || optName.includes('colour')) {
        colorCounter.set(val, (colorCounter.get(val) ?? 0n) + qty);
      }
    }
    return {
      variantId: row.variantId,
      productName: row.productName,
      label: row.itemLabel,
      sku: row.sku,
      unitsSold: qty.toString(),
      netRevenue: moneyJson(Money.fromMinor(BigInt(row.netRevenue ?? 0), tenant.currency)),
    };
  }).sort((a, b) => BigInt(b.unitsSold) > BigInt(a.unitsSold) ? 1 : -1).slice(0, 15);

  const topSizes = [...sizeCounter.entries()]
    .map(([size, count]) => ({ size, unitsSold: count.toString(), sharePercent: totalVariantUnits > 0n ? Number((count * 100n) / totalVariantUnits) : 0 }))
    .sort((a, b) => BigInt(b.unitsSold) > BigInt(a.unitsSold) ? 1 : -1);
  const topColors = [...colorCounter.entries()]
    .map(([color, count]) => ({ color, unitsSold: count.toString(), sharePercent: totalVariantUnits > 0n ? Number((count * 100n) / totalVariantUnits) : 0 }))
    .sort((a, b) => BigInt(b.unitsSold) > BigInt(a.unitsSold) ? 1 : -1);

  return {
    range: fromValue && toValue ? { from: fromValue, to: toValue } : { from: null, to: null },
    topByUnits: byUnits[0] ?? null,
    topByRevenue: byRevenue[0] ?? null,
    topByProfit: byProfit[0] ?? null,
    products: byUnits.slice(0, 20),
    mostPurchasedProducts: mostPurchasedProducts.slice(0, 20),
    topPurchasedByUnits: mostPurchasedProducts[0] ?? null,
    topVariants,
    topSizes,
    topColors,
  };
}

async function purchaseSupplierReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const fromValue = url.searchParams.get('from'), toValue = url.searchParams.get('to');
  if (!fromValue || !toValue) throw Object.assign(new Error('Both report dates are required'), { status: 400 });
  const from = reportDay(fromValue), to = reportDay(toValue);
  if (from > to) throw Object.assign(new Error('Report start date must be before end date'), { status: 400 });
  const bounds = queryRangeBounds(fromValue, toValue, url);
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const rows = database.getRawDatabase().prepare(`
    SELECT s.id AS supplierId, s.name AS supplierName, COUNT(p.id) AS invoiceCount, SUM(p.total_amount) AS totalAmount,
      SUM(${unrepresentedInitialPaidSql('p')} + COALESCE((SELECT SUM(pay.amount) FROM supplier_payments pay WHERE pay.tenant_id = p.tenant_id AND pay.purchase_id = p.id AND pay.deleted_at IS NULL), 0)) AS paidAmount,
      SUM(COALESCE((SELECT SUM(sr.credit_amount) FROM supplier_returns sr WHERE sr.tenant_id = p.tenant_id AND sr.purchase_id = p.id), 0)) AS returnedCredit,
      SUM(COALESCE((SELECT SUM(spi.quantity) FROM supplier_purchase_items spi WHERE spi.tenant_id = p.tenant_id AND spi.purchase_id = p.id), 0)) AS unitsOrdered
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?
    GROUP BY s.id, s.name
  `).all(ctx.tenantId, storeId, bounds.startIso, bounds.endExclusiveIso);
  const refundRows = database.getRawDatabase().prepare(`
    SELECT supplier_id AS supplierId, COALESCE(SUM(amount), 0) AS refundedAmount
    FROM supplier_refunds
    WHERE tenant_id = ? AND store_id = ?
      AND replace(COALESCE(refunded_at, created_at), ' ', 'T') >= ?
      AND replace(COALESCE(refunded_at, created_at), ' ', 'T') < ?
    GROUP BY supplier_id
  `).all(ctx.tenantId, storeId, bounds.startIso, bounds.endExclusiveIso);
  const refundedMap = new Map(refundRows.map((r) => [r.supplierId, BigInt(r.refundedAmount ?? 0)]));
  const suppliers = rows.map((row) => {
    const totalMinor = BigInt(row.totalAmount ?? 0);
    const paidMinor = BigInt(row.paidAmount ?? 0);
    const creditMinor = BigInt(row.returnedCredit ?? 0);
    const refundedMinor = refundedMap.get(row.supplierId) ?? 0n;
    const remainingMinor = totalMinor - paidMinor - creditMinor + refundedMinor;
    return {
      id: row.supplierId,
      name: row.supplierName,
      invoiceCount: String(row.invoiceCount),
      unitsOrdered: String(row.unitsOrdered ?? 0),
      totalAmount: moneyJson(Money.fromMinor(totalMinor, tenant.currency)),
      paidAmount: moneyJson(Money.fromMinor(paidMinor, tenant.currency)),
      returnedCredit: moneyJson(Money.fromMinor(creditMinor, tenant.currency)),
      refundedToStore: moneyJson(Money.fromMinor(refundedMinor, tenant.currency)),
      creditFromSupplier: moneyJson(Money.fromMinor(remainingMinor < 0n ? -remainingMinor : 0n, tenant.currency)),
      balanceDue: moneyJson(Money.fromMinor(remainingMinor, tenant.currency)),
    };
  });
  const bySpend = [...suppliers].sort((a, b) => BigInt(a.totalAmount.amount) === BigInt(b.totalAmount.amount) ? a.name.localeCompare(b.name) : BigInt(a.totalAmount.amount) > BigInt(b.totalAmount.amount) ? -1 : 1);
  const byInvoices = [...suppliers].sort((a, b) => Number(b.invoiceCount) - Number(a.invoiceCount) || a.name.localeCompare(b.name));
  return { range: { from: fromValue, to: toValue }, topBySpend: bySpend[0] ?? null, topByInvoices: byInvoices[0] ?? null, suppliers: bySpend };
}

async function financialMapReport(ctx, url) {
  if (!ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW) && !ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) && ctx.roleId !== 'OWNER' && ctx.roleId !== 'STORE_MANAGER') {
    throw Object.assign(new Error('غير مصرح بعرض المسار المالي'), { status: 403 });
  }
  const requestedStore = url.searchParams.get('storeId');
  const stores = await storeRepo.listByTenant(ctx);
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((s) => s.id === storeId)) throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('الشركة غير موجودة'), { status: 404 });
  const currency = tenant.currency;

  const rawDb = database.getRawDatabase();
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if (Boolean(from) !== Boolean(to)) throw Object.assign(new Error('يجب تحديد تاريخ البداية والنهاية معًا'), { status: 400 });
  let bounds = null;
  if (from && to) {
    const f = reportDay(from), t = reportDay(to);
    if (f > t) throw Object.assign(new Error('تاريخ البداية يجب أن يسبق تاريخ النهاية'), { status: 400 });
    bounds = queryRangeBounds(from, to, url);
  }

  const userRows = await db.selectFrom('users').select(['id', 'full_name as fullName', 'username']).where('tenant_id', '=', ctx.tenantId).execute();
  const userMap = new Map(userRows.map((u) => [u.id, u.fullName || u.username]));

  const toIsoTimestamp = (val, fallbackDate) => {
    if (!val) return fallbackDate ? `${fallbackDate}T12:00:00.000Z` : new Date().toISOString();
    if (val instanceof Date) return val.toISOString();
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str)) {
      return str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str) ? str : `${str}Z`;
    }
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
      return `${str.replace(' ', 'T')}Z`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return `${str}T12:00:00.000Z`;
    }
    return str;
  };

  // 1. Sales (with original merchandise COGS)
  let salesSql = `
    SELECT s.id, s.sale_number, s.created_at, s.customer_name, s.cashier_user_id,
      CASE WHEN (SELECT COUNT(*) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id) > 1 THEN 'MIXED' ELSE (SELECT sp.method FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id LIMIT 1) END AS payment_method,
      COALESCE((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS revenue,
      COALESCE((SELECT SUM(si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS cogs,
      COALESCE((SELECT SUM(si.net_revenue - si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS gross_profit
    FROM sales s
    WHERE s.tenant_id = ? AND s.store_id = ? AND s.status = 'COMPLETED'
  `;
  const salesParams = [ctx.tenantId, storeId];
  if (bounds) { salesSql += ` AND s.created_at >= ? AND s.created_at < ?`; salesParams.push(bounds.startIso, bounds.endExclusiveIso); }
  salesSql += ` ORDER BY s.created_at ASC`;
  const salesRows = rawDb.prepare(salesSql).all(...salesParams);

  // 2. Supplier Purchase Bills (includes credit / partial purchases for complete timeline audit)
  let supBillsSql = `
    SELECT p.id, p.invoice_number, COALESCE(p.purchased_at, p.created_at) AS created_at, p.total_amount, p.initial_paid_amount, p.notes, p.created_by_user_id, s.name AS supplier_name
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ?
  `;
  const supBillsParams = [ctx.tenantId, storeId];
  if (bounds) { supBillsSql += ` AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?`; supBillsParams.push(bounds.startIso, bounds.endExclusiveIso); }
  supBillsSql += ` ORDER BY COALESCE(p.purchased_at, p.created_at) ASC`;
  const supBillsRows = rawDb.prepare(supBillsSql).all(...supBillsParams);

  // 3. Supplier purchases legacy initial_paid_amount > 0 + supplier_payments table
  let supInitSql = `
    SELECT p.id, p.invoice_number, COALESCE(p.purchased_at, p.created_at) as created_at, p.initial_paid_amount as amount, p.notes, p.created_by_user_id, s.name as supplier_name
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND ${unrepresentedInitialPaidSql('p')} > 0
  `;
  const supInitParams = [ctx.tenantId, storeId];
  if (bounds) { supInitSql += ` AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?`; supInitParams.push(bounds.startIso, bounds.endExclusiveIso); }
  supInitSql += ` ORDER BY COALESCE(p.purchased_at, p.created_at) ASC`;
  const supInitRows = rawDb.prepare(supInitSql).all(...supInitParams);

  let supPaySql = `
    SELECT sp.id, sp.idempotency_key, p.invoice_number, COALESCE(sp.paid_at, sp.created_at) as created_at, sp.amount, sp.payment_method, sp.reference_number, sp.created_by_user_id, s.name as supplier_name
    FROM supplier_payments sp
    INNER JOIN supplier_purchases p ON p.id = sp.purchase_id AND p.tenant_id = sp.tenant_id
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE sp.tenant_id = ? AND p.store_id = ? AND sp.deleted_at IS NULL
  `;
  const supPayParams = [ctx.tenantId, storeId];
  if (bounds) { supPaySql += ` AND replace(COALESCE(sp.paid_at, sp.created_at), ' ', 'T') >= ? AND replace(COALESCE(sp.paid_at, sp.created_at), ' ', 'T') < ?`; supPayParams.push(bounds.startIso, bounds.endExclusiveIso); }
  supPaySql += ` ORDER BY COALESCE(sp.paid_at, sp.created_at) ASC`;
  const supPayRows = rawDb.prepare(supPaySql).all(...supPayParams);

  // 4. Operating Expenses (stored with local calendar expense_date)
  let expSql = `
    SELECT oer.id, COALESCE(oer.created_at, oer.expense_date) as created_at, oer.expense_date, oer.amount, oer.payment_method, oer.notes, oer.expense_type, oer.created_by_user_id,
      COALESCE(ec.name, 'مصروف تشغيلي') AS category_name,
      COALESCE(reo.name, 'التزام شهري') AS obligation_name
    FROM operating_expense_records oer
    LEFT JOIN expense_categories ec ON ec.id = oer.category_id AND ec.tenant_id = oer.tenant_id
    LEFT JOIN monthly_expense_actuals mea ON mea.id = oer.monthly_actual_id AND mea.tenant_id = oer.tenant_id
    LEFT JOIN recurring_expense_obligations reo ON reo.id = mea.obligation_id AND reo.tenant_id = oer.tenant_id
    WHERE oer.tenant_id = ? AND oer.store_id = ? AND oer.deleted_at IS NULL
  `;
  const expParams = [ctx.tenantId, storeId];
  if (from) { expSql += ` AND substr(oer.expense_date, 1, 10) >= ?`; expParams.push(from); }
  if (to) { expSql += ` AND substr(oer.expense_date, 1, 10) <= ?`; expParams.push(to); }
  expSql += ` ORDER BY COALESCE(oer.created_at, oer.expense_date) ASC`;
  const expRows = rawDb.prepare(expSql).all(...expParams);

  // 5. Customer Returns
  let retSql = `
    SELECT cr.id, cr.return_number, cr.created_at, cr.refund_amount, cr.payment_method, cr.created_by_user_id,
      COALESCE((SELECT SUM(cri.cost_amount) FROM customer_return_items cri WHERE cri.return_id = cr.id AND cri.tenant_id = cr.tenant_id), 0) as returned_cost
    FROM customer_returns cr
    WHERE cr.tenant_id = ? AND cr.store_id = ?
  `;
  const retParams = [ctx.tenantId, storeId];
  if (bounds) { retSql += ` AND cr.created_at >= ? AND cr.created_at < ?`; retParams.push(bounds.startIso, bounds.endExclusiveIso); }
  retSql += ` ORDER BY cr.created_at ASC`;
  const retRows = rawDb.prepare(retSql).all(...retParams);

  // 6. Supplier Return Credit Events & Variance (Account 5090)
  let supRetSql = `
    SELECT sr.id, sr.return_number, sr.credit_amount, sr.created_at, sr.created_by_user_id,
      p.invoice_number, s.name AS supplier_name
    FROM supplier_returns sr
    INNER JOIN supplier_purchases p ON p.id = sr.purchase_id AND p.tenant_id = sr.tenant_id
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE sr.tenant_id = ? AND sr.store_id = ?
  `;
  const supRetParams = [ctx.tenantId, storeId];
  if (bounds) { supRetSql += ` AND replace(sr.created_at, ' ', 'T') >= ? AND replace(sr.created_at, ' ', 'T') < ?`; supRetParams.push(bounds.startIso, bounds.endExclusiveIso); }
  supRetSql += ` ORDER BY sr.created_at ASC`;
  const supRetRows = rawDb.prepare(supRetSql).all(...supRetParams);

  let varSql = `
    SELECT jl.entry_type AS side, jl.amount
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    INNER JOIN accounts a ON a.id = jl.account_id
    WHERE je.tenant_id = ? AND je.store_id = ? AND je.source_type = 'SUPPLIER_RETURN' AND a.account_code = '5090'
  `;
  const varParams = [ctx.tenantId, storeId];
  if (bounds) { varSql += ` AND je.created_at >= ? AND je.created_at < ?`; varParams.push(bounds.startIso, bounds.endExclusiveIso); }
  const varRows = rawDb.prepare(varSql).all(...varParams);
  const supplierReturnVarianceMinor = varRows.reduce((sum, r) => sum + (r.side === 'DEBIT' ? BigInt(r.amount) : -BigInt(r.amount)), 0n);

  // 7. Inventory Damage, Stock Adjustments & Stocktake Shrinkage/Surplus (Account 5090 / source_type='ADJUSTMENT')
  let invAdjSql = `
    SELECT je.id, je.entry_number, je.created_at, je.created_by_user_id, MAX(jl.memo) AS memo,
      SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END) AS net_loss
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    INNER JOIN accounts a ON a.id = jl.account_id
    WHERE je.tenant_id = ? AND je.store_id = ? AND je.source_type = 'ADJUSTMENT' AND a.account_code = '5090'
  `;
  const invAdjParams = [ctx.tenantId, storeId];
  if (bounds) { invAdjSql += ` AND je.created_at >= ? AND je.created_at < ?`; invAdjParams.push(bounds.startIso, bounds.endExclusiveIso); }
  invAdjSql += ` GROUP BY je.id ORDER BY je.created_at ASC`;
  const invAdjRows = rawDb.prepare(invAdjSql).all(...invAdjParams);

  // 8. Drawer Shift-Close Adjustments (Account 1010 / source_type='SESSION_CLOSING')
  let shiftCloseSql = `
    SELECT je.id, je.entry_number, je.created_at, je.created_by_user_id, MAX(jl.memo) AS memo,
      SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END) AS cash_delta
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    INNER JOIN accounts a ON a.id = jl.account_id
    WHERE je.tenant_id = ? AND je.store_id = ? AND je.source_type = 'SESSION_CLOSING' AND a.account_code = '1010'
  `;
  const shiftCloseParams = [ctx.tenantId, storeId];
  if (bounds) { shiftCloseSql += ` AND je.created_at >= ? AND je.created_at < ?`; shiftCloseParams.push(bounds.startIso, bounds.endExclusiveIso); }
  shiftCloseSql += ` GROUP BY je.id ORDER BY je.created_at ASC`;
  const shiftCloseRows = rawDb.prepare(shiftCloseSql).all(...shiftCloseParams);

  // 9. Internal Treasury Transfers (source_type='TRANSFER')
  let transferSql = `
    SELECT je.id, je.entry_number, je.created_at, je.created_by_user_id, MAX(jl.memo) AS memo, MAX(jl.amount) AS amount
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.tenant_id = ? AND je.store_id = ? AND je.source_type = 'TRANSFER'
  `;
  const transferParams = [ctx.tenantId, storeId];
  if (bounds) { transferSql += ` AND je.created_at >= ? AND je.created_at < ?`; transferParams.push(bounds.startIso, bounds.endExclusiveIso); }
  transferSql += ` GROUP BY je.id ORDER BY je.created_at ASC`;
  const transferRows = rawDb.prepare(transferSql).all(...transferParams);

  // 10. Cash/Bank Refunds Collected From Suppliers (supplier_refunds)
  let supRefundSql = `
    SELECT sr.id, sr.amount, sr.payment_method, sr.reference_number, sr.notes, sr.refunded_at, sr.created_at, sr.created_by_user_id,
      s.name AS supplier_name
    FROM supplier_refunds sr
    INNER JOIN suppliers s ON s.id = sr.supplier_id AND s.tenant_id = sr.tenant_id
    WHERE sr.tenant_id = ? AND sr.store_id = ?
  `;
  const supRefundParams = [ctx.tenantId, storeId];
  if (bounds) {
    supRefundSql += ` AND replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') >= ? AND replace(COALESCE(sr.refunded_at, sr.created_at), ' ', 'T') < ?`;
    supRefundParams.push(bounds.startIso, bounds.endExclusiveIso);
  }
  supRefundSql += ` ORDER BY COALESCE(sr.refunded_at, sr.created_at) ASC`;
  const supRefundRows = rawDb.prepare(supRefundSql).all(...supRefundParams);

  // 11. Opening Balances Cash/Bank Injection (opening-balance:*)
  let openingSql = `
    SELECT je.id, je.entry_number, je.entry_date, je.created_at, je.created_by_user_id, MAX(jl.memo) AS memo,
      COALESCE(SUM(CASE WHEN a.account_code IN ('1010', '1015', '1020') THEN (CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END) ELSE 0 END), 0) AS cash_in
    FROM journal_entries je
    INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
    INNER JOIN accounts a ON a.id = jl.account_id
    WHERE je.tenant_id = ? AND je.store_id = ? AND je.idempotency_key LIKE 'opening-balance:%'
  `;
  const openingParams = [ctx.tenantId, storeId];
  if (from && to) { openingSql += ` AND je.entry_date >= ? AND je.entry_date <= ?`; openingParams.push(from, to); }
  openingSql += ` GROUP BY je.id ORDER BY je.entry_date ASC, je.created_at ASC`;
  const openingRows = rawDb.prepare(openingSql).all(...openingParams);

  const timeline = [];

  for (const s of salesRows) {
    const rev = BigInt(s.revenue ?? 0);
    const cogs = BigInt(s.cogs ?? 0);
    const profit = BigInt(s.gross_profit ?? 0);
    timeline.push({
      id: s.id,
      timestamp: toIsoTimestamp(s.created_at),
      sortOrder: 1,
      type: 'SALE',
      category: 'بيع',
      title: `فاتورة بيع #${s.sale_number}`,
      reference: s.sale_number,
      party: s.customer_name || 'عميل نقدي',
      actor: userMap.get(s.cashier_user_id) || 'الكاشير',
      amountIn: rev.toString(),
      amountOut: '0',
      cogsAmount: cogs.toString(),
      profitImpact: profit.toString(),
      details: `قيمة البيع: ${Money.fromMinor(rev, currency).toDecimalString()} ${currency} · تكلفة البضاعة الأصلي: ${Money.fromMinor(cogs, currency).toDecimalString()} ${currency}`,
    });
  }

  for (const b of supBillsRows) {
    const billAmt = BigInt(b.total_amount ?? 0);
    const invRef = b.invoice_number || b.id.slice(0, 8);
    const formattedBill = `${Money.fromMinor(billAmt, currency).toDecimalString()} ${currency}`;
    timeline.push({
      id: `${b.id}-bill`,
      timestamp: toIsoTimestamp(b.created_at),
      sortOrder: 2,
      type: 'SUPPLIER_PURCHASE',
      category: 'فاتورة شراء',
      title: `فاتورة بضاعة #${invRef} بقيمة ${formattedBill}`,
      reference: b.invoice_number,
      party: `التاجر: ${b.supplier_name}`,
      actor: userMap.get(b.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: '0',
      billAmount: billAmt.toString(),
      profitImpact: '0',
      details: `استلام بضاعة للمخزون بقيمة ${formattedBill} من ${b.supplier_name} (السداد النقدي يُخصم في بند سداد التاجر)${b.notes ? ` · ${b.notes}` : ''}`,
    });
  }

  for (const p of supInitRows) {
    const amt = BigInt(p.amount ?? 0);
    const formattedAmt = `${Money.fromMinor(amt, currency).toDecimalString()} ${currency}`;
    const invRef = p.invoice_number || p.id.slice(0, 8);
    timeline.push({
      id: `${p.id}-init`,
      timestamp: toIsoTimestamp(p.created_at),
      sortOrder: 3,
      type: 'SUPPLIER_PAYMENT',
      category: 'سداد تاجر',
      title: `سددت ${formattedAmt} للتاجر ${p.supplier_name}`,
      reference: p.invoice_number,
      party: `التاجر: ${p.supplier_name}`,
      actor: userMap.get(p.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: amt.toString(),
      profitImpact: '0',
      details: `سددت ${formattedAmt} للتاجر ${p.supplier_name} — دفعة مقدمة عند استلام فاتورة #${invRef}${p.notes ? ` · ${p.notes}` : ''}`,
    });
  }

  for (const p of supPayRows) {
    const amt = BigInt(p.amount ?? 0);
    const formattedAmt = `${Money.fromMinor(amt, currency).toDecimalString()} ${currency}`;
    const methodLabel = paymentMethodArabicLabel(p.payment_method || 'CASH');
    const invRef = p.invoice_number || p.id.slice(0, 8);
    const isInitial = String(p.idempotency_key || '').endsWith(':initial') || String(p.id || '').endsWith(':payment:initial');
    timeline.push({
      id: p.id,
      timestamp: toIsoTimestamp(p.created_at),
      sortOrder: 3,
      type: 'SUPPLIER_PAYMENT',
      category: 'سداد تاجر',
      title: `سددت ${formattedAmt} للتاجر ${p.supplier_name}`,
      reference: p.invoice_number,
      party: `التاجر: ${p.supplier_name}`,
      actor: userMap.get(p.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: amt.toString(),
      profitImpact: '0',
      details: `سددت ${formattedAmt} للتاجر ${p.supplier_name} — ${isInitial ? 'دفعة مقدمة عند استلام' : 'سداد دفعة من حساب'} فاتورة #${invRef} (${methodLabel})${p.reference_number ? ` · مرجع: ${p.reference_number}` : ''}`,
    });
  }

  for (const sr of supRetRows) {
    const creditAmt = BigInt(sr.credit_amount ?? 0);
    const formattedCredit = `${Money.fromMinor(creditAmt, currency).toDecimalString()} ${currency}`;
    const invRef = sr.invoice_number || '';
    timeline.push({
      id: sr.id,
      timestamp: toIsoTimestamp(sr.created_at),
      sortOrder: 4,
      type: 'SUPPLIER_RETURN',
      category: 'مرتجع لمورد',
      title: `مرتجع بضاعة للتاجر ${sr.supplier_name} (#${sr.return_number})`,
      reference: sr.return_number,
      party: `التاجر: ${sr.supplier_name}`,
      actor: userMap.get(sr.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: '0',
      profitImpact: '0',
      details: `تخفيض حساب التاجر عن فاتورة #${invRef} بقيمة ${formattedCredit} (إشعار خصم حساب غير نقدي)`,
    });
  }

  const fmTz = resolveValidTimeZone(tenant.timezone);
  for (const e of expRows) {
    const amt = BigInt(e.amount ?? 0);
    const isMonthly = e.expense_type === 'MONTHLY_RECURRING_PAYMENT';
    const label = isMonthly ? `سداد ${e.obligation_name}` : `مصروف: ${e.category_name}`;
    const createdIso = toIsoTimestamp(e.created_at, e.expense_date);
    const createdLocalDay = e.created_at ? businessDateInTimeZone(new Date(createdIso), fmTz) : e.expense_date;
    let expTimestamp = createdIso;
    if (e.expense_date && createdLocalDay && e.expense_date !== createdLocalDay && /^\d{4}-\d{2}-\d{2}$/.test(e.expense_date)) {
      const dayStartMs = timeZoneStartOfDayUtcMs(e.expense_date, fmTz);
      const nextDay = businessDateInTimeZone(new Date(dayStartMs + 30 * 3600 * 1000), fmTz);
      expTimestamp = new Date(timeZoneStartOfDayUtcMs(nextDay, fmTz) - 1).toISOString();
    }
    timeline.push({
      id: e.id,
      timestamp: expTimestamp,
      sortOrder: 5,
      type: 'EXPENSE',
      category: isMonthly ? 'التزام شهري' : 'مصروف يومي',
      title: label,
      reference: e.notes || label,
      party: isMonthly ? e.obligation_name : e.category_name,
      actor: userMap.get(e.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: amt.toString(),
      profitImpact: (-amt).toString(),
      details: e.notes || (isMonthly ? 'سداد التزام شهري (إيجار / مرافق)' : 'مصروف تشغيل يومي'),
    });
  }

  for (const r of retRows) {
    const refundAmt = BigInt(r.refund_amount ?? 0);
    const costAmt = BigInt(r.returned_cost ?? 0);
    const lostMargin = refundAmt - costAmt;
    timeline.push({
      id: r.id,
      timestamp: toIsoTimestamp(r.created_at),
      sortOrder: 6,
      type: 'CUSTOMER_RETURN',
      category: 'مرتجع للعميل',
      title: `مرتجع بيع #${r.return_number}`,
      reference: r.return_number,
      party: 'عميل مرتجع',
      actor: userMap.get(r.created_by_user_id) || 'الكاشير',
      amountIn: '0',
      amountOut: refundAmt.toString(),
      returnedCostAmount: costAmt.toString(),
      profitImpact: (-lostMargin).toString(),
      details: `رد مبلغ للعميل: ${Money.fromMinor(refundAmt, currency).toDecimalString()} ${currency} (استعادة بضاعة للمخزن بتكلفة ${Money.fromMinor(costAmt, currency).toDecimalString()} ${currency})`,
    });
  }

  for (const adj of invAdjRows) {
    const netLoss = BigInt(adj.net_loss ?? 0);
    const absAmt = netLoss >= 0n ? netLoss : -netLoss;
    const label = String(adj.memo ?? '').split(' — ')[0] || 'تسوية مخزنية';
    timeline.push({
      id: adj.id,
      timestamp: toIsoTimestamp(adj.created_at),
      sortOrder: 7,
      type: 'INVENTORY_EVENT',
      category: 'تالف / جرد مخزون',
      title: label,
      reference: adj.entry_number,
      party: 'المخزون',
      actor: userMap.get(adj.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: '0',
      nonCashCostImpact: netLoss.toString(),
      profitImpact: (-netLoss).toString(),
      details: `${netLoss >= 0n ? 'خصم قيمة عجز/تالف' : 'فائض جرد مخزون'} بالتكلفة: ${Money.fromMinor(absAmt, currency).toDecimalString()} ${currency} (أثر مخزني لا يخصم كاش)`,
    });
  }

  for (const sc of shiftCloseRows) {
    const delta = BigInt(sc.cash_delta ?? 0);
    if (delta === 0n) continue;
    const isSurplus = delta > 0n;
    const absAmt = isSurplus ? delta : -delta;
    const label = String(sc.memo ?? '').split(' — ')[0] || (isSurplus ? 'فائض درج النقدية' : 'عجز درج النقدية');
    timeline.push({
      id: sc.id,
      timestamp: toIsoTimestamp(sc.created_at),
      sortOrder: 8,
      type: 'SHIFT_CASH_ADJUSTMENT',
      category: isSurplus ? 'فائض درج' : 'عجز درج',
      title: label,
      reference: sc.entry_number,
      party: 'درج النقدية',
      actor: userMap.get(sc.created_by_user_id) || 'المسؤول',
      amountIn: isSurplus ? absAmt.toString() : '0',
      amountOut: isSurplus ? '0' : absAmt.toString(),
      profitImpact: delta.toString(),
      details: `تسوية درج النقدية عند التقفيل (${isSurplus ? 'فائض نقدي +' : 'عجز نقدي -'} ${Money.fromMinor(absAmt, currency).toDecimalString()} ${currency})`,
    });
  }

  for (const sr of supRefundRows) {
    const amt = BigInt(sr.amount ?? 0);
    const methodAr = sr.payment_method === 'CASH' ? 'نقدي للدرج' : sr.payment_method === 'CASH_SAFE' ? 'للخزينة الرئيسية' : 'تحويل بنكي';
    timeline.push({
      id: sr.id,
      timestamp: toIsoTimestamp(sr.refunded_at ?? sr.created_at),
      sortOrder: 4,
      type: 'SUPPLIER_REFUND',
      category: 'استرداد من تاجر',
      title: `استرداد نقدي من التاجر ${sr.supplier_name}`,
      reference: sr.reference_number || sr.supplier_name,
      party: `التاجر: ${sr.supplier_name}`,
      actor: userMap.get(sr.created_by_user_id) || 'المسؤول',
      amountIn: amt.toString(),
      amountOut: '0',
      profitImpact: '0',
      details: `تحصيل رصيد مرتجع مستحق عند التاجر (${methodAr})${sr.notes ? ` · ${sr.notes}` : ''}`,
    });
  }

  for (const ob of openingRows) {
    const cashIn = BigInt(ob.cash_in ?? 0);
    if (cashIn === 0n) continue;
    timeline.push({
      id: ob.id,
      timestamp: `${ob.entry_date}T00:00:00.000Z`,
      sortOrder: 0,
      type: 'OPENING_BALANCE',
      category: 'رصيد افتتاحي',
      title: 'أرصدة نقدية افتتاحية',
      reference: ob.entry_number,
      party: 'رأس المال الافتتاحي',
      actor: userMap.get(ob.created_by_user_id) || 'المالك',
      amountIn: cashIn > 0n ? cashIn.toString() : '0',
      amountOut: cashIn < 0n ? (-cashIn).toString() : '0',
      profitImpact: '0',
      details: `إثبات رصيد نقدي وبنكي افتتاحي بالمتجر (${Money.fromMinor(cashIn, currency).toDecimalString()} ${currency})`,
    });
  }

  for (const tr of transferRows) {
    const amt = BigInt(tr.amount ?? 0);
    const label = String(tr.memo ?? '').split(' — ')[0] || 'تحويل نقدية داخلي';
    timeline.push({
      id: tr.id,
      timestamp: toIsoTimestamp(tr.created_at),
      sortOrder: 9,
      type: 'TREASURY_TRANSFER',
      category: 'تحويل داخلي',
      title: label,
      reference: tr.entry_number,
      party: 'الخزينة / الدرج / البنك',
      actor: userMap.get(tr.created_by_user_id) || 'المسؤول',
      amountIn: '0',
      amountOut: '0',
      profitImpact: '0',
      details: `تحويل مالي داخلي بقيمة ${Money.fromMinor(amt, currency).toDecimalString()} ${currency} بين حسابات المتجر (لا يغير إجمالي السيولة)`,
    });
  }

  timeline.sort((a, b) => {
    if (a.timestamp < b.timestamp) return -1;
    if (a.timestamp > b.timestamp) return 1;
    return (a.sortOrder ?? 99) - (b.sortOrder ?? 99);
  });

  let runningCashMinor = 0n;
  let runningProfitMinor = 0n;
  let totalSalesMinor = 0n;
  let grossCogsOfSalesMinor = 0n;
  let totalGrossProfitMinor = 0n;
  let totalPurchasesBilledMinor = 0n;
  let totalSupplierPaidMinor = 0n;
  let totalSupplierRefundedMinor = 0n;
  let totalOpeningCashMinor = 0n;
  let totalExpensesMinor = 0n;
  let totalRefundsMinor = 0n;
  let totalReturnedCostMinor = 0n;
  let totalInvAdjustmentLossMinor = 0n;
  let totalShiftCashVarianceMinor = 0n;

  for (const item of timeline) {
    const inAmt = BigInt(item.amountIn);
    const outAmt = BigInt(item.amountOut);
    const pImpact = BigInt(item.profitImpact);

    runningCashMinor += inAmt - outAmt;
    runningProfitMinor += pImpact;

    if (item.type === 'SALE') {
      totalSalesMinor += inAmt;
      grossCogsOfSalesMinor += BigInt(item.cogsAmount ?? 0);
      totalGrossProfitMinor += BigInt(item.profitImpact);
    } else if (item.type === 'SUPPLIER_PURCHASE') {
      totalPurchasesBilledMinor += BigInt(item.billAmount ?? 0);
    } else if (item.type === 'SUPPLIER_PAYMENT') {
      totalSupplierPaidMinor += outAmt;
    } else if (item.type === 'SUPPLIER_REFUND') {
      totalSupplierRefundedMinor += inAmt;
    } else if (item.type === 'OPENING_BALANCE') {
      totalOpeningCashMinor += inAmt - outAmt;
    } else if (item.type === 'EXPENSE') {
      totalExpensesMinor += outAmt;
    } else if (item.type === 'CUSTOMER_RETURN') {
      totalRefundsMinor += outAmt;
      totalReturnedCostMinor += BigInt(item.returnedCostAmount ?? 0);
    } else if (item.type === 'INVENTORY_EVENT') {
      totalInvAdjustmentLossMinor += BigInt(item.nonCashCostImpact ?? 0);
    } else if (item.type === 'SHIFT_CASH_ADJUSTMENT') {
      totalShiftCashVarianceMinor += inAmt - outAmt;
    }

    item.runningCash = runningCashMinor.toString();
    item.runningProfit = runningProfitMinor.toString();
  }

  timeline.forEach((item, idx) => {
    item.stepNumber = idx + 1;
  });
  timeline.reverse();

  const netSalesMinor = totalSalesMinor - totalRefundsMinor;
  const totalCogsMinor = grossCogsOfSalesMinor - totalReturnedCostMinor + supplierReturnVarianceMinor;
  const netCashFlowMinor = netSalesMinor - totalSupplierPaidMinor + totalSupplierRefundedMinor + totalOpeningCashMinor - totalExpensesMinor + totalShiftCashVarianceMinor;
  const netReturnLossMinor = totalRefundsMinor - totalReturnedCostMinor;
  const operatingProfitMinor = totalGrossProfitMinor - totalExpensesMinor - netReturnLossMinor - supplierReturnVarianceMinor - totalInvAdjustmentLossMinor + totalShiftCashVarianceMinor;

  return {
    currency,
    range: { from, to },
    summary: {
      totalSales: totalSalesMinor.toString(),
      netSales: netSalesMinor.toString(),
      totalCogs: totalCogsMinor.toString(),
      totalGrossProfit: totalGrossProfitMinor.toString(),
      totalPurchasesBilled: totalPurchasesBilledMinor.toString(),
      totalSupplierPaid: totalSupplierPaidMinor.toString(),
      totalSupplierRefunded: totalSupplierRefundedMinor.toString(),
      openingCashIn: totalOpeningCashMinor.toString(),
      totalExpensesPaid: totalExpensesMinor.toString(),
      totalRefunds: totalRefundsMinor.toString(),
      supplierReturnVariance: supplierReturnVarianceMinor.toString(),
      inventoryAdjustmentsLoss: totalInvAdjustmentLossMinor.toString(),
      shiftCashVariance: totalShiftCashVarianceMinor.toString(),
      operatingProfit: operatingProfitMinor.toString(),
      netCashFlow: netCashFlowMinor.toString(),
      realizedCashProfit: netCashFlowMinor.toString(),
      runningFinalCash: runningCashMinor.toString(),
      eventsCount: timeline.length,
    },
    timeline: timeline, // Reversed chronological: newest event first, keeping cumulative runningCash per step
  };
}

async function trialBalanceReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const scopeAll = !ctx.storeId && requestedStore === 'ALL';
  const storeId = ctx.storeId ?? (scopeAll ? null : (requestedStore ?? stores[0]?.id ?? null));
  if (!scopeAll && (!storeId || !stores.some((s) => s.id === storeId))) {
    throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
  }
  const { from, to } = parseHistoryRange(url);
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('الشركة غير موجودة'), { status: 404 });
  const currency = tenant.currency;
  const rawDb = database.getRawDatabase();

  const existingAccounts = await db.selectFrom('accounts').select(['account_code', 'account_name', 'account_type', 'normal_balance'])
    .where('tenant_id', '=', ctx.tenantId).orderBy('account_code', 'asc').execute();
  const accountMeta = new Map();
  for (const [code, name, type, normal] of accountDefaults) {
    accountMeta.set(code, { accountCode: code, accountName: name, accountType: type, normalBalance: normal });
  }
  for (const acc of existingAccounts) {
    accountMeta.set(acc.account_code, {
      accountCode: acc.account_code,
      accountName: acc.account_name,
      accountType: acc.account_type,
      normalBalance: acc.normal_balance,
    });
  }

  const conds = ['je.tenant_id = ?'];
  const args = [ctx.tenantId];
  if (storeId) { conds.push('je.store_id = ?'); args.push(storeId); }
  const queryAccountSums = (extraConds = [], extraArgs = []) => {
    const rows = rawDb.prepare(`
      SELECT a.account_code AS accountCode,
        COALESCE(SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE 0 END), 0) AS debitTotal,
        COALESCE(SUM(CASE WHEN jl.entry_type = 'CREDIT' THEN jl.amount ELSE 0 END), 0) AS creditTotal
      FROM accounts a
      INNER JOIN journal_lines jl ON jl.account_id = a.id
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE ${[...conds, ...extraConds].join(' AND ')}
      GROUP BY a.account_code
    `).all(...args, ...extraArgs);
    return new Map(rows.map((r) => [r.accountCode, { debit: BigInt(r.debitTotal ?? 0), credit: BigInt(r.creditTotal ?? 0) }]));
  };

  const periodByCode = (from && to)
    ? queryAccountSums(['je.entry_date >= ?', 'je.entry_date <= ?'], [from, to])
    : queryAccountSums();
  const openingByCode = (from && to) ? queryAccountSums(['je.entry_date < ?'], [from]) : new Map();

  const sortedCodes = [...accountMeta.keys()].sort((a, b) => a.localeCompare(b));
  let totalOpeningDebit = 0n;
  let totalOpeningCredit = 0n;
  let totalOpeningDebitBalance = 0n;
  let totalOpeningCreditBalance = 0n;
  let totalDebit = 0n;
  let totalCredit = 0n;
  let totalClosingDebit = 0n;
  let totalClosingCredit = 0n;
  let totalDebitBalance = 0n;
  let totalCreditBalance = 0n;

  const accounts = sortedCodes.map((code) => {
    const meta = accountMeta.get(code);
    const open = openingByCode.get(code) ?? { debit: 0n, credit: 0n };
    const period = periodByCode.get(code) ?? { debit: 0n, credit: 0n };
    const closingDebit = open.debit + period.debit;
    const closingCredit = open.credit + period.credit;

    totalOpeningDebit += open.debit;
    totalOpeningCredit += open.credit;
    const openSigned = open.debit - open.credit;
    const openingDebitBalance = openSigned > 0n ? openSigned : 0n;
    const openingCreditBalance = openSigned < 0n ? -openSigned : 0n;
    totalOpeningDebitBalance += openingDebitBalance;
    totalOpeningCreditBalance += openingCreditBalance;

    totalDebit += period.debit;
    totalCredit += period.credit;
    totalClosingDebit += closingDebit;
    totalClosingCredit += closingCredit;

    const netSigned = closingDebit - closingCredit;
    const debitBalance = netSigned > 0n ? netSigned : 0n;
    const creditBalance = netSigned < 0n ? -netSigned : 0n;
    totalDebitBalance += debitBalance;
    totalCreditBalance += creditBalance;

    return {
      ...meta,
      openingDebit: moneyJson(Money.fromMinor(open.debit, currency)),
      openingCredit: moneyJson(Money.fromMinor(open.credit, currency)),
      openingDebitBalance: moneyJson(Money.fromMinor(openingDebitBalance, currency)),
      openingCreditBalance: moneyJson(Money.fromMinor(openingCreditBalance, currency)),
      periodDebit: moneyJson(Money.fromMinor(period.debit, currency)),
      periodCredit: moneyJson(Money.fromMinor(period.credit, currency)),
      closingDebit: moneyJson(Money.fromMinor(closingDebit, currency)),
      closingCredit: moneyJson(Money.fromMinor(closingCredit, currency)),
      debitTotal: moneyJson(Money.fromMinor(period.debit, currency)),
      creditTotal: moneyJson(Money.fromMinor(period.credit, currency)),
      debitBalance: moneyJson(Money.fromMinor(debitBalance, currency)),
      creditBalance: moneyJson(Money.fromMinor(creditBalance, currency)),
    };
  });

  return {
    storeId: storeId ?? 'ALL',
    currency,
    from,
    to,
    accounts,
    totals: {
      openingDebitTotal: moneyJson(Money.fromMinor(totalOpeningDebit, currency)),
      openingCreditTotal: moneyJson(Money.fromMinor(totalOpeningCredit, currency)),
      openingDebitBalanceTotal: moneyJson(Money.fromMinor(totalOpeningDebitBalance, currency)),
      openingCreditBalanceTotal: moneyJson(Money.fromMinor(totalOpeningCreditBalance, currency)),
      debitTotal: moneyJson(Money.fromMinor(totalDebit, currency)),
      creditTotal: moneyJson(Money.fromMinor(totalCredit, currency)),
      closingDebitTotal: moneyJson(Money.fromMinor(totalClosingDebit, currency)),
      closingCreditTotal: moneyJson(Money.fromMinor(totalClosingCredit, currency)),
      debitBalanceTotal: moneyJson(Money.fromMinor(totalDebitBalance, currency)),
      creditBalanceTotal: moneyJson(Money.fromMinor(totalCreditBalance, currency)),
      isBalanced:
        totalOpeningDebit === totalOpeningCredit
        && totalDebit === totalCredit
        && totalClosingDebit === totalClosingCredit
        && totalDebitBalance === totalCreditBalance,
    },
  };
}

async function growthForecastReport(ctx, url) {
  if (!ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW) && !ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) && ctx.roleId !== 'OWNER' && ctx.roleId !== 'STORE_MANAGER') {
    throw Object.assign(new Error('غير مصرح بعرض تقارير النمو'), { status: 403 });
  }
  const requestedStore = url.searchParams.get('storeId');
  const stores = await storeRepo.listByTenant(ctx);
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((s) => s.id === storeId)) throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('الشركة غير موجودة'), { status: 404 });
  const currency = tenant.currency;

  const rawDb = database.getRawDatabase();
  const now = new Date();
  const realCurrentYear = now.getUTCFullYear();
  const realCurrentMonth = now.getUTCMonth() + 1;

  const paramYear = Number.parseInt(url.searchParams.get('year') ?? '', 10);
  const paramMonth = Number.parseInt(url.searchParams.get('month') ?? '', 10);
  const currentYear = (!Number.isNaN(paramYear) && paramYear >= 2020 && paramYear <= 2099) ? paramYear : realCurrentYear;
  const currentMonth = (!Number.isNaN(paramMonth) && paramMonth >= 1 && paramMonth <= 12) ? paramMonth : realCurrentMonth;

  const isRealCurrentMonth = (currentYear === realCurrentYear && currentMonth === realCurrentMonth);
  const currentDay = isRealCurrentMonth ? now.getUTCDate() : new Date(currentYear, currentMonth, 0).getDate();
  const daysInCurrentMonth = new Date(currentYear, currentMonth, 0).getDate();

  const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
  const prevYear = prevMonthDate.getUTCFullYear();
  const prevMonth = prevMonthDate.getUTCMonth() + 1;
  const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();

  const curPrefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const prevPrefix = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

  const curSalesRow = rawDb.prepare(`
    SELECT COUNT(s.id) as salesCount,
      COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as revenue,
      COALESCE(SUM((SELECT SUM(si.net_revenue - si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as profit
    FROM sales s
    WHERE s.tenant_id = ? AND s.store_id = ? AND s.status = 'COMPLETED' AND substr(s.created_at, 1, 7) = ?
  `).get(ctx.tenantId, storeId, curPrefix);

  const prevSalesRow = rawDb.prepare(`
    SELECT COUNT(s.id) as salesCount,
      COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as revenue,
      COALESCE(SUM((SELECT SUM(si.net_revenue - si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as profit
    FROM sales s
    WHERE s.tenant_id = ? AND s.store_id = ? AND s.status = 'COMPLETED' AND substr(s.created_at, 1, 7) = ?
  `).get(ctx.tenantId, storeId, prevPrefix);

  const returnsMonthsRows = rawDb.prepare(`
    SELECT substr(cr.created_at, 1, 7) AS yearMonth,
      COALESCE(SUM(cr.refund_amount), 0) AS refunds,
      COALESCE(SUM((SELECT SUM(cri.cost_amount) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS returnedCost
    FROM customer_returns cr
    WHERE cr.tenant_id = ? AND cr.store_id = ?
    GROUP BY substr(cr.created_at, 1, 7)
  `).all(ctx.tenantId, storeId);
  const returnsByYm = new Map();
  for (const r of returnsMonthsRows) {
    if (!r.yearMonth) continue;
    returnsByYm.set(r.yearMonth, {
      refunds: BigInt(r.refunds ?? 0),
      returnedCost: BigInt(r.returnedCost ?? 0),
    });
  }
  const curRet = returnsByYm.get(curPrefix) ?? { refunds: 0n, returnedCost: 0n };
  const prevRet = returnsByYm.get(prevPrefix) ?? { refunds: 0n, returnedCost: 0n };

  const curRevenue = BigInt(curSalesRow?.revenue ?? 0) - curRet.refunds;
  const curProfit = BigInt(curSalesRow?.profit ?? 0) - curRet.refunds + curRet.returnedCost;
  const curCount = Number(curSalesRow?.salesCount ?? 0);

  const prevRevenue = BigInt(prevSalesRow?.revenue ?? 0) - prevRet.refunds;
  const prevProfit = BigInt(prevSalesRow?.profit ?? 0) - prevRet.refunds + prevRet.returnedCost;
  const prevCount = Number(prevSalesRow?.salesCount ?? 0);

  const daysElapsed = isRealCurrentMonth ? Math.max(1, currentDay) : daysInCurrentMonth;
  const dailyRunRateMinor = daysElapsed > 0 ? (curRevenue / BigInt(daysElapsed)) : 0n;
  const projectedMonthEndRevenueMinor = isRealCurrentMonth
    ? dailyRunRateMinor * BigInt(daysInCurrentMonth)
    : curRevenue;

  let growthBps = 0n;
  if (prevRevenue > 0n) {
    growthBps = ((projectedMonthEndRevenueMinor - prevRevenue) * 10000n) / prevRevenue;
  } else if (curRevenue > 0n) {
    growthBps = 10000n;
  }
  const growthPercent = Number(growthBps) / 100;

  const rawTrendBps = growthBps / 2n;
  const clampedTrendBps = rawTrendBps < -2000n ? -2000n : rawTrendBps > 4000n ? 4000n : rawTrendBps;
  const numerator = projectedMonthEndRevenueMinor * (10000n + clampedTrendBps);
  const projectedNextMonthMinor = numerator >= 0n
    ? (numerator + 5000n) / 10000n
    : (numerator - 5000n) / 10000n;
  const roundedTenths = clampedTrendBps >= 0n
    ? (clampedTrendBps + 5n) / 10n
    : (clampedTrendBps - 5n) / 10n;
  const nextMonthGrowthPercent = Number(roundedTenths) / 10;

  const arMonths = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const curMonthName = `${arMonths[currentMonth - 1]} ${currentYear}`;
  const prevMonthName = `${arMonths[prevMonth - 1]} ${prevYear}`;
  const nextMonthIdx = currentMonth % 12;
  const nextMonthYear = currentMonth === 12 ? currentYear + 1 : currentYear;
  const nextMonthName = `${arMonths[nextMonthIdx]} ${nextMonthYear}`;

  // Monthly archive query: all months with sales recorded in the tenant
  const salesMonthsRows = rawDb.prepare(`
    SELECT substr(s.created_at, 1, 7) as yearMonth,
      COUNT(s.id) as salesCount,
      COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as revenue,
      COALESCE(SUM((SELECT SUM(si.net_revenue - si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) as profit
    FROM sales s
    WHERE s.tenant_id = ? AND s.store_id = ? AND s.status = 'COMPLETED'
    GROUP BY substr(s.created_at, 1, 7)
    ORDER BY yearMonth DESC
  `).all(ctx.tenantId, storeId);

  const monthMap = new Map();
  // Ensure recent 6 months are always represented
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(realCurrentYear, realCurrentMonth - 1 - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthMap.set(ym, {
      yearMonth: ym,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      salesCount: 0,
      revenue: '0',
      profit: '0',
    });
  }

  for (const row of salesMonthsRows) {
    if (!row.yearMonth) continue;
    const [yStr, mStr] = row.yearMonth.split('-');
    const ret = returnsByYm.get(row.yearMonth) ?? { refunds: 0n, returnedCost: 0n };
    const netRev = BigInt(row.revenue || 0) - ret.refunds;
    const netProf = BigInt(row.profit || 0) - ret.refunds + ret.returnedCost;
    monthMap.set(row.yearMonth, {
      yearMonth: row.yearMonth,
      year: Number(yStr),
      month: Number(mStr),
      salesCount: Number(row.salesCount || 0),
      revenue: netRev.toString(),
      profit: netProf.toString(),
    });
  }
  for (const [ym, ret] of returnsByYm.entries()) {
    if (salesMonthsRows.some((r) => r.yearMonth === ym)) continue;
    const [yStr, mStr] = ym.split('-');
    const existing = monthMap.get(ym);
    const baseRev = existing ? BigInt(existing.revenue || 0) : 0n;
    const baseProf = existing ? BigInt(existing.profit || 0) : 0n;
    monthMap.set(ym, {
      yearMonth: ym,
      year: existing ? existing.year : Number(yStr),
      month: existing ? existing.month : Number(mStr),
      salesCount: existing ? existing.salesCount : 0,
      revenue: (baseRev - ret.refunds).toString(),
      profit: (baseProf - ret.refunds + ret.returnedCost).toString(),
    });
  }

  if (!monthMap.has(curPrefix)) {
    monthMap.set(curPrefix, {
      yearMonth: curPrefix,
      year: currentYear,
      month: currentMonth,
      salesCount: curCount,
      revenue: curRevenue.toString(),
      profit: curProfit.toString(),
    });
  }

  const sortedMonthsKeys = Array.from(monthMap.keys()).sort(); // chronological ascending
  const monthlyHistory = [];

  for (let idx = 0; idx < sortedMonthsKeys.length; idx++) {
    const ym = sortedMonthsKeys[idx];
    const data = monthMap.get(ym);
    const mRev = BigInt(data.revenue);
    const mDays = new Date(data.year, data.month, 0).getDate();
    let mGrowth = 0;
    if (idx > 0) {
      const prevYm = sortedMonthsKeys[idx - 1];
      const prevData = monthMap.get(prevYm);
      const prevRev = BigInt(prevData.revenue);
      if (prevRev > 0n) {
        mGrowth = Number((mRev - prevRev) * 10000n / prevRev) / 100;
      } else if (mRev > 0n) {
        mGrowth = 100;
      }
    }
    const isCur = (data.year === realCurrentYear && data.month === realCurrentMonth);
    const elapsed = isCur ? Math.max(1, now.getUTCDate()) : mDays;
    const dailyAvg = elapsed > 0 ? (mRev / BigInt(elapsed)).toString() : '0';

    monthlyHistory.push({
      yearMonth: data.yearMonth,
      year: data.year,
      month: data.month,
      name: `${arMonths[data.month - 1]} ${data.year}`,
      salesCount: data.salesCount,
      revenue: data.revenue,
      profit: data.profit,
      dailyAverage: dailyAvg,
      growthPercent: mGrowth,
      isGrowth: mGrowth >= 0,
      isCurrent: isCur,
      isSelected: (data.year === currentYear && data.month === currentMonth),
    });
  }

  monthlyHistory.reverse();

  return {
    currency,
    selectedPeriod: {
      year: currentYear,
      month: currentMonth,
      isCurrent: isRealCurrentMonth,
    },
    currentMonth: {
      year: currentYear,
      month: currentMonth,
      name: curMonthName,
      daysInMonth: daysInCurrentMonth,
      daysElapsed,
      revenue: curRevenue.toString(),
      profit: curProfit.toString(),
      salesCount: curCount,
      dailyAverage: dailyRunRateMinor.toString(),
      projectedMonthEnd: projectedMonthEndRevenueMinor.toString(),
      isCompleted: !isRealCurrentMonth,
    },
    previousMonth: {
      year: prevYear,
      month: prevMonth,
      name: prevMonthName,
      daysInMonth: daysInPrevMonth,
      revenue: prevRevenue.toString(),
      profit: prevProfit.toString(),
      salesCount: prevCount,
    },
    comparison: {
      growthPercent,
      isGrowth: growthPercent >= 0,
      diffRevenue: (projectedMonthEndRevenueMinor - prevRevenue).toString(),
    },
    forecast: {
      nextMonthName,
      projectedRevenue: projectedNextMonthMinor.toString(),
      forecastGrowthPercent: nextMonthGrowthPercent,
      dailyExpectedPace: (projectedNextMonthMinor / 30n).toString(),
      statusText: growthPercent >= 15 ? 'أداء نمو تصاعدي قوي' : growthPercent >= 0 ? 'أداء مستقر وإيجابي' : 'يحتاج إلى تنشيط للمبيعات',
    },
    monthlyHistory,
  };
}

function requireSameOrigin(req) {
  const reqOrigin = req.headers.origin;
  const host = req.headers.host;
  const secFetchSite = req.headers['sec-fetch-site'];

  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site' && secFetchSite !== 'none') {
    throw Object.assign(new Error('الطلب غير مسموح'), { status: 403 });
  }

  if (reqOrigin) {
    const isMatchingOrigin =
      reqOrigin === origin ||
      reqOrigin === `http://localhost:${port}` ||
      (host && (reqOrigin === `http://${host}` || reqOrigin === `https://${host}`));
    if (!isMatchingOrigin) {
      throw Object.assign(new Error('الطلب غير مسموح'), { status: 403 });
    }
    return;
  }

  const referer = req.headers.referer;
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const isMatchingRef =
        refUrl.origin === origin ||
        refUrl.origin === `http://localhost:${port}` ||
        (host && (refUrl.origin === `http://${host}` || refUrl.origin === `https://${host}`));
      if (!isMatchingRef) {
        throw Object.assign(new Error('الطلب غير مسموح'), { status: 403 });
      }
    } catch {
      throw Object.assign(new Error('الطلب غير مسموح'), { status: 403 });
    }
  }
}

async function setupState() {
  const tenants = await tenantRepo.listAll();
  if (tenants.length === 0) return { configured: false };
  if (tenants.length !== 1) throw new Error('هذه القاعدة تحتوي على أكثر من شركة. يلزم فحص ملف البيانات قبل المتابعة.');
  if (betaAutoLoginEnabled && evaluateBetaTrialStatus().status === 'ACTIVE') {
    await ensureBetaOwnerContext();
  }
  const owner = await db.selectFrom('users').select('id').where('tenant_id', '=', tenants[0].id).where('role', '=', 'OWNER').executeTakeFirst();
  return { configured: true, setupRequired: !owner, companyName: tenants[0].name, currency: tenants[0].currency, companyCode: tenants[0].code };
}

async function currentData(ctx, url) {
  ctx.assertPermission(Permissions.INVENTORY_VIEW);
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
  const signedInUser = await userRepo.findById(ctx, ctx.userId);
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) {
    throw Object.assign(new Error('الفرع المحدد غير متاح لهذا المستخدم'), { status: 403 });
  }
  const products = await catalog.listProducts(ctx);
  const variants = await variantRepo.listByTenant(ctx);
  const positions = await inventory.listByStore(ctx, storeId);
  const positionByVariant = new Map(positions.map((position) => [position.variantId, position]));
  const productData = products.map((product) => ({
    id: product.id,
    name: product.name,
    itemKind: product.itemKind,
    sku: product.sku,
    categoryId: product.categoryId ?? null,
    description: product.description ?? null,
    brand: product.brand ?? null,
    imagePath: product.imagePath ?? null,
    options: product.options,
    isActive: product.isActive,
    variants: variants.filter((variant) => variant.productId === product.id).map((variant) => {
      const position = positionByVariant.get(variant.id);
      return {
        id: variant.id,
        sku: variant.sku,
        attributes: variant.attributes,
      isActive: variant.isActive,
        barcode: variant.barcode ?? null,
        price: moneyJson(variant.retailPrice),
        reorderPoint: variant.reorderPoint.toString(),
        quantity: (position?.quantityOnHand ?? 0n).toString(),
        totalQuantity: (position?.quantityOnHand ?? 0n).toString(),
        wac: ctx.hasPermission(Permissions.REPORTS_COGS_VIEW) ? moneyJson(position?.wacCost ?? Money.zero(tenant.currency)) : null,
      };
    }),
  }));
  const lowStock = productData.filter((product) => product.itemKind === 'PRODUCT' && product.isActive).map((product) => {
    const activeVariants = product.variants.filter((variant) => variant.isActive);
    const lowVariants = activeVariants.filter((variant) => BigInt(variant.quantity) <= BigInt(variant.reorderPoint));
    return lowVariants.length ? {
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      quantity: activeVariants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n).toString(),
      lowVariantCount: lowVariants.length,
    } : null;
  }).filter(Boolean);
  const canViewSales = ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) || ctx.roleId === 'CASHIER';
  const canViewAccounting = ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const canViewCogs = ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
  const allTenantUsers = await db.selectFrom('users')
    .select(['id', 'username', 'full_name as fullName', 'role'])
    .where('tenant_id', '=', ctx.tenantId)
    .execute();
  const userMap = new Map(allTenantUsers.map((u) => [u.id, u.fullName || u.username]));
  const rawSalesList = canViewSales ? await saleRepo.listByStore(ctx, storeId, 100) : [];
  const rawDbData = database.getRawDatabase();
  const dataSaleMetrics = canViewSales ? loadSaleReturnsAndCogs(rawDbData, ctx.tenantId, storeId, rawSalesList.map((s) => s.id)) : new Map();
  const sales = canViewSales ? rawSalesList.map((s) => ({
    ...enrichSerializedSale(saleJson(s), dataSaleMetrics, tenant.currency, canViewCogs),
    cashierName: userMap.get(s.cashierUserId) || 'كاشير',
  })) : [];
  const customerReturnRows = canViewSales ? await db.selectFrom('customer_returns').innerJoin('sales', 'sales.id', 'customer_returns.original_sale_id')
    .select(['customer_returns.id as id', 'customer_returns.return_number as returnNumber', 'customer_returns.created_at as createdAt', 'customer_returns.refund_amount as refundAmount', 'customer_returns.currency as currency', 'customer_returns.payment_method as paymentMethod', 'sales.sale_number as saleNumber'])
    .where('customer_returns.tenant_id', '=', ctx.tenantId).where('customer_returns.store_id', '=', storeId)
    .orderBy('customer_returns.created_at', 'desc').limit(100).execute() : [];
  const journalHeaders = canViewAccounting ? await db.selectFrom('journal_entries').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .orderBy('entry_date', 'desc').orderBy('created_at', 'desc').limit(200).execute() : [];
  const accountingEntriesTotal = canViewAccounting
    ? Number(rawDbData.prepare('SELECT COUNT(*) AS total FROM journal_entries WHERE tenant_id = ? AND store_id = ?').get(ctx.tenantId, storeId)?.total ?? 0)
    : 0;
  const customerReturnsTotal = canViewSales
    ? Number(rawDbData.prepare('SELECT COUNT(*) AS total FROM customer_returns WHERE tenant_id = ? AND store_id = ?').get(ctx.tenantId, storeId)?.total ?? 0)
    : 0;
  const accountingEntries = await serializeJournalEntries(journalHeaders);
  const monthlyNow = new Date();
  const reqYear = Number(url.searchParams.get('year'));
  const reqMonth = Number(url.searchParams.get('month'));
  const hasExplicitMonth = (reqYear >= 2020 && reqYear <= 2040) && (reqMonth >= 1 && reqMonth <= 12);
  const monthlyYear = hasExplicitMonth ? reqYear : monthlyNow.getUTCFullYear();
  const monthlyMonth = hasExplicitMonth ? reqMonth : (monthlyNow.getUTCMonth() + 1);
  const monthPrefix = `${monthlyYear}-${String(monthlyMonth).padStart(2, '0')}`;
  const canViewExpenses = ctx.hasPermission(Permissions.EXPENSES_DIRECT_CREATE) || canViewAccounting;
  let expenseQuery = canViewExpenses ? db.selectFrom('operating_expense_records').innerJoin('expense_categories', 'expense_categories.id', 'operating_expense_records.category_id')
    .select(['operating_expense_records.id as id', 'operating_expense_records.expense_date as date', 'operating_expense_records.amount as amount', 'operating_expense_records.currency as currency', 'operating_expense_records.payment_method as paymentMethod', 'operating_expense_records.notes as notes', 'operating_expense_records.reference_number as referenceNumber', 'expense_categories.name as category'])
    .where('operating_expense_records.tenant_id', '=', ctx.tenantId).where('operating_expense_records.store_id', '=', storeId).where('operating_expense_records.expense_type', '=', 'DIRECT_DAILY').where('operating_expense_records.deleted_at', 'is', null) : null;
  if (expenseQuery && hasExplicitMonth) {
    expenseQuery = expenseQuery.where('operating_expense_records.expense_date', 'like', `${monthPrefix}-%`);
  }
  const expenseRows = expenseQuery ? await expenseQuery.orderBy('operating_expense_records.expense_date', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const canManageCatalog = ctx.hasPermission(Permissions.CATALOG_MANAGE);
  const includeArchivedSuppliers = url.searchParams.get('includeArchivedSuppliers') === '1';
  const suppliersQuery = canManageCatalog
    ? db.selectFrom('suppliers').selectAll().where('tenant_id', '=', ctx.tenantId)
    : null;
  const suppliers = suppliersQuery
    ? await (includeArchivedSuppliers ? suppliersQuery : suppliersQuery.where('is_active', '=', 1)).orderBy('name').execute()
    : [];
  // Recent window only; full history is served by GET /api/purchases. Supplier totals below cover all history.
  const purchases = canManageCatalog ? await db.selectFrom('supplier_purchases').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('purchased_at', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const purchaseEntries = canManageCatalog ? await loadPurchaseEntries(ctx.tenantId, purchases, userMap) : [];
  const supplierTotals = canManageCatalog ? supplierPurchaseAggregates({ tenantId: ctx.tenantId, storeId }) : new Map();
  const supplierReturnRows = canManageCatalog ? await db.selectFrom('supplier_returns').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('created_at', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const supplierRefundRows = canManageCatalog ? await db.selectFrom('supplier_refunds').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('refunded_at', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const refundsBySupplier = new Map();
  for (const r of supplierRefundRows) {
    const bucket = refundsBySupplier.get(r.supplier_id) ?? [];
    bucket.push({
      id: r.id,
      amount: moneyJson(Money.fromMinor(BigInt(r.amount), r.currency)),
      paymentMethod: r.payment_method,
      referenceNumber: r.reference_number,
      notes: r.notes,
      refundedAt: r.refunded_at,
      createdByName: userMap.get(r.created_by_user_id) || 'المسؤول',
    });
    refundsBySupplier.set(r.supplier_id, bucket);
  }
  const supplierData = suppliers.map((supplier) => serializeSupplierSummary(supplier, supplierTotals.get(supplier.id), tenant.currency, purchaseEntries.filter((entry) => entry.supplierId === supplier.id), refundsBySupplier.get(supplier.id) ?? []));
  const canViewMonthlyExpenses = ctx.hasPermission(Permissions.EXPENSES_MONTHLY_CONFIRM) || ctx.hasPermission(Permissions.EXPENSES_MONTHLY_PAY) || ctx.hasPermission(Permissions.REPORTS_MONTHLY_VIEW);
  const monthlyObligations = canViewMonthlyExpenses ? await db.selectFrom('recurring_expense_obligations')
    .innerJoin('expense_categories', 'expense_categories.id', 'recurring_expense_obligations.category_id')
    .select(['recurring_expense_obligations.id as id', 'recurring_expense_obligations.name as name', 'recurring_expense_obligations.due_day_of_month as dueDay', 'recurring_expense_obligations.currency as currency', 'expense_categories.name as category'])
    .where('recurring_expense_obligations.tenant_id', '=', ctx.tenantId).where('recurring_expense_obligations.store_id', '=', storeId)
    .where('recurring_expense_obligations.is_active', '=', 1).orderBy('recurring_expense_obligations.due_day_of_month').execute() : [];
  const monthlyActualRows = canViewMonthlyExpenses && monthlyObligations.length ? await db.selectFrom('monthly_expense_actuals').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('year', '=', monthlyYear).where('month', '=', monthlyMonth).execute() : [];
  const monthlyPaymentRows = canViewMonthlyExpenses && monthlyActualRows.length ? await db.selectFrom('operating_expense_records').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'MONTHLY_RECURRING_PAYMENT').where('deleted_at', 'is', null)
    .where('monthly_actual_id', 'in', monthlyActualRows.map((actual) => actual.id)).orderBy('expense_date', 'desc').execute() : [];
  const availableMonthsRows = canViewMonthlyExpenses ? await db.selectFrom('monthly_expense_actuals')
    .select(['year', 'month'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .groupBy(['year', 'month'])
    .orderBy('year', 'desc').orderBy('month', 'desc')
    .execute() : [];
  const allActualsForObligations = canViewMonthlyExpenses && monthlyObligations.length ? await db.selectFrom('monthly_expense_actuals')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .where('obligation_id', 'in', monthlyObligations.map((o) => o.id))
    .orderBy('year', 'desc').orderBy('month', 'desc')
    .execute() : [];
  const monthlyExpenses = monthlyObligations.map((obligation) => {
    const actual = monthlyActualRows.find((item) => item.obligation_id === obligation.id);
    const payments = actual ? monthlyPaymentRows.filter((item) => item.monthly_actual_id === actual.id) : [];
    const amount = actual ? BigInt(actual.amount) : 0n, paid = actual ? BigInt(actual.paid_amount) : 0n;
    const latestPastActual = allActualsForObligations.find((item) => item.obligation_id === obligation.id);
    const suggestedPastAmount = latestPastActual ? latestPastActual.amount : null;
    return { ...obligation,
      suggestedPastAmount: suggestedPastAmount ? moneyJson(Money.fromMinor(BigInt(suggestedPastAmount), tenant.currency)) : null,
      actual: actual ? { id: actual.id, year: actual.year, month: actual.month,
        amount: moneyJson(Money.fromMinor(amount, actual.currency)), paidAmount: moneyJson(Money.fromMinor(paid, actual.currency)),
        remainingAmount: moneyJson(Money.fromMinor(amount - paid, actual.currency)), status: actual.status,
        payments: payments.map((item) => ({ id: item.id, amount: moneyJson(Money.fromMinor(BigInt(item.amount), item.currency)), method: item.payment_method, referenceNumber: item.reference_number, paidAt: item.expense_date })) } : null };
  });
  const tzOffsetMinutes = normalizeTzOffsetMinutes(url.searchParams.get('tzOffset'));
  const todayBounds = localDayUtcBounds(Date.now(), tzOffsetMinutes);
  const todaySalesRow = canViewSales ? rawDbData.prepare(`
    SELECT COUNT(id) AS cnt,
      COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.sale_id = sales.id)), 0) AS gross
    FROM sales
    WHERE tenant_id = ? AND store_id = ? AND status = 'COMPLETED' AND created_at >= ? AND created_at < ?
  `).get(ctx.tenantId, storeId, todayBounds.startIso, todayBounds.endIso) : { cnt: 0, gross: 0 };
  const todayReturnsRow = canViewSales ? rawDbData.prepare(`
    SELECT COALESCE(SUM(refund_amount), 0) AS refunds
    FROM customer_returns
    WHERE tenant_id = ? AND store_id = ? AND created_at >= ? AND created_at < ?
  `).get(ctx.tenantId, storeId, todayBounds.startIso, todayBounds.endIso) : { refunds: 0 };
  const todaySalesCount = Number(todaySalesRow?.cnt ?? 0);
  const revenueMinor = (BigInt(todaySalesRow?.gross ?? 0) - BigInt(todayReturnsRow?.refunds ?? 0)).toString();
  const canManageUsers = ctx.hasPermission(Permissions.USERS_MANAGE);
  const managedUsers = canManageUsers ? await userRepo.listByTenant(ctx) : [];
  const canCloseShift = ctx.hasPermission(Permissions.POS_DRAWER_OPEN);
  const canClosePeriod = ctx.hasPermission(Permissions.SETTINGS_MANAGE);
  const treasuryMinor = (canViewAccounting || canCloseShift)
    ? await computeTreasuryBalancesMinor(db, ctx.tenantId, storeId)
    : null;
  const drawerBookBalanceMinor = treasuryMinor ? treasuryMinor.drawer : null;
  const accountingPeriods = canViewAccounting
    ? await db.selectFrom('accounting_periods').selectAll().where('tenant_id', '=', ctx.tenantId).orderBy('start_date', 'desc').execute()
    : [];

  const rawDatabase = database.getRawDatabase();
  const activeShiftRow = rawDatabase.prepare(
    "SELECT id, shift_number as shiftNumber, started_at as startedAt, opening_cash as openingCash, notes FROM cashier_shifts WHERE tenant_id = ? AND user_id = ? AND status = 'OPEN' ORDER BY started_at DESC LIMIT 1"
  ).get(ctx.tenantId, ctx.userId);
  const rawTodayAttendanceRows = rawDatabase.prepare(
    "SELECT actor_user_id AS userId, actor_username AS username, actor_role AS actorRole, created_at AS createdAt, summary FROM audit_logs WHERE tenant_id = ? AND action = 'ATTENDANCE_CHECK_IN' AND created_at >= ? AND created_at < ? ORDER BY sequence_no ASC"
  ).all(ctx.tenantId, todayBounds.startIso, todayBounds.endIso);

  const managedUserById = new Map(managedUsers.map((u) => [u.id, u]));
  const todayAttendanceMap = new Map();
  let userCheckedInRecord = null;
  for (const r of rawTodayAttendanceRows) {
    if (!r.userId) continue;
    if (r.userId === ctx.userId && !userCheckedInRecord) {
      userCheckedInRecord = r;
    }
    const targetUser = managedUserById.get(r.userId);
    const effectiveRole = targetUser?.role ?? r.actorRole;
    if (effectiveRole === 'OWNER') continue;
    if (managedUsers.length > 0 && !targetUser) continue;
    const existing = todayAttendanceMap.get(r.userId);
    if (existing) {
      existing.checkInCount += 1;
      continue;
    }
    const evalResult = evaluateAttendanceTimestamp(
      r.createdAt,
      targetUser?.shiftStartTime ?? null,
      targetUser?.lateGraceMinutes ?? 0,
      tzOffsetMinutes,
    );
    todayAttendanceMap.set(r.userId, {
      userId: r.userId,
      username: r.username,
      createdAt: r.createdAt,
      summary: r.summary,
      checkInCount: 1,
      arrivalTime: evalResult?.arrivalTime ?? null,
      isLate: evalResult?.isLate ?? false,
      lateMinutes: evalResult?.lateMinutes ?? 0,
      status: evalResult?.status ?? 'UNSCHEDULED',
    });
  }
  const todayAttendance = [...todayAttendanceMap.values()];
  const userCheckedInToday = Boolean(userCheckedInRecord || activeShiftRow);
  const userCheckInTime = userCheckedInRecord?.createdAt ?? activeShiftRow?.startedAt ?? null;
  const existingOpeningEntry = canViewAccounting
    ? await db.selectFrom('journal_entries')
        .select(['id', 'entry_number as entryNumber', 'entry_date as entryDate'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', storeId)
        .where('idempotency_key', 'like', 'opening-balance:%')
        .where('reversed_by_entry_id', 'is', null)
        .where('status', '=', 'POSTED')
        .executeTakeFirst()
    : null;

  return {
    tenantId: ctx.tenantId,
    company: { name: tenant.name, currency: tenant.currency, timezone: resolveValidTimeZone(tenant.timezone) },
    user: { id: ctx.userId, fullName: signedInUser?.fullName ?? '', role: ctx.roleId, storeId: ctx.storeId ?? null, shiftStartTime: signedInUser?.shiftStartTime ?? null, lateGraceMinutes: signedInUser?.lateGraceMinutes ?? 0 },
    betaPreviewMode: developmentResetEnabled,
    betaAutoLogin: betaAutoLoginEnabled,
    developmentResetAvailable: developmentResetEnabled && ctx.roleId === 'OWNER',
    activeShift: activeShiftRow ? {
      id: activeShiftRow.id,
      shiftNumber: activeShiftRow.shiftNumber,
      startedAt: activeShiftRow.startedAt,
      openingCash: String(activeShiftRow.openingCash ?? 0),
      notes: activeShiftRow.notes ?? '',
    } : null,
    todayAttendance,
    userCheckedInToday,
    userCheckInTime,
    openingBalanceEntry: existingOpeningEntry ? { id: existingOpeningEntry.id, entryNumber: existingOpeningEntry.entryNumber, entryDate: existingOpeningEntry.entryDate } : null,
    stores: stores.map((store) => ({ id: store.id, name: store.name, code: store.code, address: store.address ?? null, phone: store.phone ?? null })),
    users: managedUsers.map((user) => ({ id: user.id, username: user.username, fullName: user.fullName, phone: user.phone ?? null, employmentStartDate: user.employmentStartDate, shiftStartTime: user.shiftStartTime ?? null, lateGraceMinutes: user.lateGraceMinutes ?? 0, role: user.role, storeId: user.storeId ?? null, isActive: user.isActive, createdAt: user.createdAt.toISOString() })),
    selectedStoreId: storeId,
    categories: (await categoryRepo.listByTenant(ctx)).map((category) => ({ id: category.id, name: category.name, code: category.code })),
    products: productData,
    suppliers: canManageCatalog ? supplierData : [],
    supplierReturns: canManageCatalog ? supplierReturnRows.map((item) => ({ id: item.id, returnNumber: item.return_number, purchaseId: item.purchase_id, creditAmount: moneyJson(Money.fromMinor(BigInt(item.credit_amount), item.currency)), createdAt: item.created_at })) : [],
    accountingEntries,
    accountingEntriesTotal,
    customerReturnsTotal,
    accountingPeriods: accountingPeriods.map((period) => ({ id: period.id, name: period.name, startDate: period.start_date, endDate: period.end_date, status: period.status, closedAt: period.closed_at })),
    drawerBookBalance: drawerBookBalanceMinor !== null ? moneyJson(Money.fromMinor(drawerBookBalanceMinor, tenant.currency)) : null,
    treasuryBalances: treasuryMinor ? {
      drawer: moneyJson(Money.fromMinor(treasuryMinor.drawer, tenant.currency)),
      safe: moneyJson(Money.fromMinor(treasuryMinor.safe, tenant.currency)),
      bank: moneyJson(Money.fromMinor(treasuryMinor.bank, tenant.currency)),
    } : null,
    expenses: expenseRows.map((expense) => ({ ...expense, amount: moneyJson(Money.fromMinor(BigInt(expense.amount), expense.currency)) })),
    capabilities: {
      canViewAccounting,
      canViewCogs,
      canViewExpenses,
      canDiscount: ctx.hasPermission(Permissions.POS_DISCOUNT),
      canDeleteExpenses: ctx.roleId === 'OWNER' || ctx.roleId === 'STORE_MANAGER',
      canCreateExpenses: ctx.hasPermission(Permissions.EXPENSES_DIRECT_CREATE),
      canConfirmMonthlyExpenses: ctx.hasPermission(Permissions.EXPENSES_MONTHLY_CONFIRM) || ctx.roleId === 'OWNER' || ctx.roleId === 'STORE_MANAGER',
      canPayMonthlyExpenses: ctx.hasPermission(Permissions.EXPENSES_MONTHLY_PAY) || ctx.roleId === 'OWNER' || ctx.roleId === 'STORE_MANAGER',
      canViewMonthlyExpenses: ctx.hasPermission(Permissions.EXPENSES_MONTHLY_CONFIRM) || ctx.hasPermission(Permissions.EXPENSES_MONTHLY_PAY) || ctx.roleId === 'OWNER' || ctx.roleId === 'STORE_MANAGER',
      canRefund: ctx.hasPermission(Permissions.POS_REFUND),
      canReturnSale: ctx.hasPermission(Permissions.POS_REFUND),
      canViewSales,
      canViewInventory: ctx.hasPermission(Permissions.INVENTORY_VIEW),
      canTransferInventory: ctx.hasPermission(Permissions.INVENTORY_TRANSFER),
      canAdjustInventory: ctx.hasPermission(Permissions.INVENTORY_ADJUST),
      canManageCatalog,
      canManageStores: ctx.hasPermission(Permissions.STORES_MANAGE),
      canCloseShift,
      canClosePeriod,
      canManageBackups: ctx.hasPermission(Permissions.SYSTEM_BACKUP_MANAGE),
      canManageUsers,
      canViewAuditLogs: ctx.hasPermission(Permissions.AUDIT_LOG_VIEW),
      cashierMode: ctx.roleId === 'CASHIER',
    },
    lowStock,
    sales,
    customerReturns: customerReturnRows.map((item) => ({ ...item, refundAmount: moneyJson(Money.fromMinor(BigInt(item.refundAmount), item.currency)) })),
    monthlyExpenses,
    monthlyPeriod: { year: monthlyYear, month: monthlyMonth },
    availableMonthlyPeriods: availableMonthsRows,
    summary: {
      todaySalesCount: canViewSales ? todaySalesCount : null,
      todayRevenue: canViewSales ? moneyJson(Money.fromMinor(BigInt(revenueMinor), tenant.currency)) : null,
      productCount: products.length,
      lowStockCount: lowStock.length,
    },
    backupSafety: ctx.hasPermission(Permissions.SYSTEM_BACKUP_MANAGE) ? await (async () => {
      const settings = await readBackupSettings();
      const mirrorRoot = settings.mirrorPath ? parse(settings.mirrorPath).root : '';
      const mirrorConnected = Boolean(settings.mirrorPath && (!mirrorRoot || existsSync(mirrorRoot)));
      const backups = await listDailyBackups();
      return {
        integrityOk: initialIntegrityStatus.ok,
        restoredAfterCrash,
        startupRecoveryInfo,
        latestDailyBackup: backups[0] ?? null,
        dailyCount: backups.length,
        mirrorPath: settings.mirrorPath,
        autoMirror: settings.autoMirror,
        mirrorConnected,
        lastMirrorAt: settings.lastMirrorAt,
        lastMirrorStatus: settings.mirrorPath ? (mirrorConnected ? settings.lastMirrorStatus : 'DISCONNECTED') : 'UNCONFIGURED',
      };
    })() : null,
  };
}

const LicenseActivateSchema = z.object({
  token: z.string().trim().min(20, 'كود التفعيل غير صالح').max(4096, 'كود التفعيل أطول من المسموح'),
});

const VendorPasswordResetSchema = z.object({
  resetToken: z.string().trim().min(20, 'كود الطوارئ غير صالح').max(4096, 'كود الطوارئ أطول من المسموح'),
  username: z.string().trim().max(30).optional(),
  newPassword: z.string().min(8, 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل').max(128, 'كلمة المرور أطول من المسموح'),
});

function isLicenseExemptMutationPath(path) {
  if (path.startsWith('/api/license/')) return true;
  if (path.startsWith('/api/backups/')) return true;
  return (
    path === '/api/login' ||
    path === '/api/logout' ||
    path === '/api/setup' ||
    path === '/api/auth/vendor-password-reset' ||
    path === '/api/account/password' ||
    path === '/api/internal/shutdown'
  );
}

async function handleApi(req, res, url) {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) requireSameOrigin(req);

  if (method === 'GET' && path === '/api/bootstrap') return json(res, 200, await setupState());

  if (method === 'GET' && path === '/api/license/status') {
    if (betaAutoLoginEnabled) return json(res, 200, evaluateBetaTrialStatus());
    return json(res, 200, await licenseService.getStatus());
  }

  if (method === 'POST' && path === '/api/license/activate') {
    const body = validate(LicenseActivateSchema, await readJson(req));
    const activated = await licenseService.activate(body.token);
    const sessionToken = readCookie(req, 'retailos_session');
    if (sessionToken) {
      try {
        const actorCtx = await auth.validateSession(sessionToken);
        await recordAudit(actorCtx, {
          action: 'LICENSE_ACTIVATED',
          entityType: 'LICENSE',
          entityId: activated.licenseId ?? 'system',
          summary: `تفعيل اشتراك النظام (${activated.customerName ?? ''} · حتى ${String(activated.expiresAt ?? '').slice(0, 10)})`,
          metadata: {
            customerName: activated.customerName,
            planName: activated.planName,
            expiresAt: activated.expiresAt,
            machineId: activated.machineId,
          },
        });
      } catch { /* activation allowed before login */ }
    }
    return json(res, 200, activated);
  }

  if (method === 'POST' && path === '/api/internal/shutdown') {
    const remoteAddress = req.socket?.remoteAddress ?? '';
    const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
    if (!isLoopback) {
      throw Object.assign(new Error('الطلب متاح محليًا فقط'), { status: 403 });
    }
    const providedToken = String(req.headers['x-retailos-shutdown-token'] ?? '');
    const expectedBuf = Buffer.from(internalShutdownToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw Object.assign(new Error('رمز الإيقاف الداخلي غير صالح'), { status: 401 });
    }
    json(res, 202, { shuttingDown: true, pid: process.pid });
    res.once('finish', () => {
      void shutdown().finally(() => process.exit(0));
    });
    return;
  }

  if (method === 'GET' && path === '/api/sales') {
    const ctx = await requireContext(req);
    if (!ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) && ctx.roleId !== 'CASHIER') throw Object.assign(new Error('غير مصرح بعرض سجل المبيعات'), { status: 403 });
    const stores = await storeRepo.listByTenant(ctx);
    const requestedStore = url.searchParams.get('storeId');
    const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
    if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('الفرع المحدد غير متاح لهذا المستخدم'), { status: 403 });
    const offset = Math.max(0, Math.min(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 100000000));
    const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 100));
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from === null) !== (to === null)) throw Object.assign(new Error('يجب تحديد تاريخ البداية والنهاية معًا'), { status: 400 });
    let bounds = null;
    if (from && to) {
      reportDay(from); reportDay(to);
      if (from > to) throw Object.assign(new Error('تاريخ البداية يجب أن يسبق تاريخ النهاية'), { status: 400 });
      bounds = queryRangeBounds(from, to, url);
    }
    const conditions = ["tenant_id = ?", "store_id = ?"];
    const args = [ctx.tenantId, storeId];
    if (bounds) { conditions.push("created_at >= ?", "created_at < ?"); args.push(bounds.startIso, bounds.endExclusiveIso); }
    if (search) {
      conditions.push("(instr(lower(sale_number), lower(?)) > 0 OR instr(lower(coalesce(customer_name, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.store_id = sales.store_id AND si.sale_id = sales.id AND (instr(lower(si.product_name), lower(?)) > 0 OR instr(lower(si.sku), lower(?)) > 0)))");
      args.push(search, search, search, search);
    }
    const rawDatabase = database.getRawDatabase();
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const canViewCogs = ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
    const canViewAccounting = ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW);
    const where = conditions.join(' AND ');
    const count = rawDatabase.prepare(`SELECT COUNT(*) AS total FROM sales WHERE ${where}`).get(...args);
    const matches = rawDatabase.prepare(`SELECT id FROM sales WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const sales = (await Promise.all(matches.map((row) => saleRepo.findById(ctx, row.id)))).filter(Boolean);
    const total = Number(count?.total ?? 0);
    const ids = sales.map((sale) => sale.id);
    const saleMetricsMap = loadSaleReturnsAndCogs(rawDatabase, ctx.tenantId, storeId, ids);
    const cashierIds = [...new Set(sales.map((s) => s.cashierUserId))];
    const cashierRows = cashierIds.length ? await db.selectFrom('users').select(['id', 'full_name as fullName', 'username']).where('tenant_id', '=', ctx.tenantId).where('id', 'in', cashierIds).execute() : [];
    const cashierNameMap = new Map(cashierRows.map((u) => [u.id, u.fullName || u.username]));
    const rows = sales.map((sale) => ({
      ...enrichSerializedSale(saleJson(sale), saleMetricsMap, currency, canViewCogs),
      cashierName: cashierNameMap.get(sale.cashierUserId) || 'كاشير',
    }));

    const aggSales = rawDatabase.prepare(`
      SELECT
        COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.sale_id = sales.id)), 0) AS gross_sales,
        COALESCE(SUM((SELECT SUM(si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.sale_id = sales.id)), 0) AS gross_cogs,
        COALESCE(SUM((SELECT SUM(si.quantity) FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.sale_id = sales.id)), 0) AS gross_units
      FROM sales
      WHERE ${where}
    `).get(...args);

    let summaryReturns;
    let summaryReturnedCost;
    let summaryReturnedUnits;
    let summaryReturnsCount;
    if (search) {
      const retAgg = rawDatabase.prepare(`
        SELECT COUNT(cr.id) AS ret_count,
          COALESCE(SUM(cr.refund_amount), 0) AS refunds,
          COALESCE(SUM((SELECT SUM(cri.cost_amount) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS ret_cost,
          COALESCE(SUM((SELECT SUM(cri.quantity) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS ret_units
        FROM customer_returns cr
        WHERE cr.tenant_id = ? AND cr.store_id = ? AND cr.original_sale_id IN (SELECT id FROM sales WHERE ${where})
      `).get(ctx.tenantId, storeId, ...args);
      summaryReturnsCount = Number(retAgg?.ret_count ?? 0);
      summaryReturns = BigInt(retAgg?.refunds ?? 0);
      summaryReturnedCost = BigInt(retAgg?.ret_cost ?? 0);
      summaryReturnedUnits = BigInt(retAgg?.ret_units ?? 0);
    } else {
      const retConds = ['cr.tenant_id = ?', 'cr.store_id = ?'];
      const retArgs = [ctx.tenantId, storeId];
      if (bounds) {
        retConds.push('cr.created_at >= ?', 'cr.created_at < ?');
        retArgs.push(bounds.startIso, bounds.endExclusiveIso);
      }
      const retAgg = rawDatabase.prepare(`
        SELECT COUNT(cr.id) AS ret_count,
          COALESCE(SUM(cr.refund_amount), 0) AS refunds,
          COALESCE(SUM((SELECT SUM(cri.cost_amount) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS ret_cost,
          COALESCE(SUM((SELECT SUM(cri.quantity) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS ret_units
        FROM customer_returns cr
        WHERE ${retConds.join(' AND ')}
      `).get(...retArgs);
      summaryReturnsCount = Number(retAgg?.ret_count ?? 0);
      summaryReturns = BigInt(retAgg?.refunds ?? 0);
      summaryReturnedCost = BigInt(retAgg?.ret_cost ?? 0);
      summaryReturnedUnits = BigInt(retAgg?.ret_units ?? 0);
    }

    const grossSalesMinor = BigInt(aggSales?.gross_sales ?? 0);
    const netSalesMinor = grossSalesMinor - summaryReturns;
    const grossUnitsMinor = BigInt(aggSales?.gross_units ?? 0);
    const netUnitsMinor = grossUnitsMinor - summaryReturnedUnits;
    const cogsMinor = BigInt(aggSales?.gross_cogs ?? 0) - summaryReturnedCost;
    const grossProfitMinor = netSalesMinor - cogsMinor;

    let directExpMinor = 0n;
    let monthlyExpMinor = 0n;
    if (!search && canViewAccounting) {
      const expConds = ['tenant_id = ?', 'store_id = ?'];
      const expArgs = [ctx.tenantId, storeId];
      if (from && to) {
        expConds.push('expense_date >= ?', 'expense_date <= ?');
        expArgs.push(from, to);
      }
      const expRows = rawDatabase.prepare(`
        SELECT expense_type, COALESCE(SUM(amount), 0) AS total
        FROM operating_expense_records
        WHERE ${expConds.join(' AND ')}
        GROUP BY expense_type
      `).all(...expArgs);
      for (const er of expRows) {
        if (er.expense_type === 'DIRECT_DAILY') directExpMinor = BigInt(er.total ?? 0);
        else if (er.expense_type === 'MONTHLY_RECURRING_PAYMENT') monthlyExpMinor = BigInt(er.total ?? 0);
      }
    }
    const totalExpensesMinor = directExpMinor + monthlyExpMinor;
    const operatingProfitMinor = grossProfitMinor - totalExpensesMinor;
    const toMoneySummary = (minor) => moneyJson(Money.fromMinor(minor, currency));

    return json(res, 200, {
      payload: {
        sales: rows,
        total,
        offset,
        limit,
        summary: {
          invoiceCount: total,
          returnsCount: summaryReturnsCount,
          grossUnits: grossUnitsMinor.toString(),
          returnedUnits: summaryReturnedUnits.toString(),
          netUnits: netUnitsMinor.toString(),
          grossSales: toMoneySummary(grossSalesMinor),
          returnsTotal: toMoneySummary(summaryReturns),
          netSales: toMoneySummary(netSalesMinor),
          cogs: canViewCogs ? toMoneySummary(cogsMinor) : null,
          grossProfit: canViewCogs ? toMoneySummary(grossProfitMinor) : null,
          directExpenses: (!search && canViewAccounting) ? toMoneySummary(directExpMinor) : null,
          monthlyExpenses: (!search && canViewAccounting) ? toMoneySummary(monthlyExpMinor) : null,
          totalExpenses: (!search && canViewAccounting) ? toMoneySummary(totalExpensesMinor) : null,
          operatingProfit: (!search && canViewAccounting) ? toMoneySummary(operatingProfitMinor) : null,
          hasSearch: Boolean(search),
          from: from || null,
          to: to || null,
        },
      },
    });
  }

  if (method === 'GET' && path === '/api/purchases') {
    const ctx = await requireContext(req);
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const storeId = await resolveHistoryStore(ctx, url);
    const { offset, limit } = parsePaging(url, 50);
    const { from, to, bounds } = parseHistoryRange(url);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
    const supplierIdParam = (url.searchParams.get('supplierId') ?? '').trim();
    if (supplierIdParam.length > 64) throw Object.assign(new Error('معرّف التاجر غير صالح'), { status: 400 });
    const filter = { tenantId: ctx.tenantId, storeId, bounds, supplierId: supplierIdParam || null, search };
    const { where, args } = purchaseFilterSql(filter);
    const rawDatabase = database.getRawDatabase();
    const total = Number(rawDatabase.prepare(`SELECT COUNT(*) AS total FROM supplier_purchases p WHERE ${where}`).get(...args)?.total ?? 0);
    const rows = rawDatabase.prepare(`SELECT p.* FROM supplier_purchases p WHERE ${where} ORDER BY p.purchased_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const currency = await tenantCurrencyCode(ctx.tenantId);
    const userMap = await tenantUserNameMap(ctx.tenantId);
    const entries = await loadPurchaseEntries(ctx.tenantId, rows, userMap);
    const totals = supplierPurchaseAggregates(filter);
    const matchedSupplierIds = findMatchingSupplierIds(filter);
    const supplierRows = await db.selectFrom('suppliers').selectAll().where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1).orderBy('name').execute();
    const visibleSuppliers = filter.supplierId
      ? supplierRows.filter((s) => s.id === filter.supplierId && (!matchedSupplierIds || matchedSupplierIds.has(s.id)))
      : matchedSupplierIds
        ? supplierRows.filter((s) => matchedSupplierIds.has(s.id))
        : supplierRows;
    const refundRows = visibleSuppliers.length
      ? await db.selectFrom('supplier_refunds').selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', storeId)
        .where('supplier_id', 'in', visibleSuppliers.map((s) => s.id))
        .orderBy('refunded_at', 'desc')
        .execute()
      : [];
    const refundsBySupplier = new Map();
    for (const r of refundRows) {
      if (bounds) {
        const ts = String(r.refunded_at || r.created_at || '').replace(' ', 'T');
        if (ts < bounds.startIso || ts >= bounds.endExclusiveIso) continue;
      }
      const bucket = refundsBySupplier.get(r.supplier_id) ?? [];
      bucket.push({
        id: r.id,
        amount: moneyJson(Money.fromMinor(BigInt(r.amount), r.currency)),
        paymentMethod: r.payment_method,
        referenceNumber: r.reference_number,
        notes: r.notes,
        refundedAt: r.refunded_at,
        createdByName: userMap.get(r.created_by_user_id) || 'المسؤول',
      });
      refundsBySupplier.set(r.supplier_id, bucket);
    }
    let sumTotal = 0n; let sumPaid = 0n; let sumReturned = 0n; let sumRefunded = 0n; let sumDue = 0n;
    for (const s of visibleSuppliers) {
      const t = totals.get(s.id);
      if (!t) continue;
      sumTotal += t.total; sumPaid += t.paid; sumReturned += t.returned; sumRefunded += t.refundedToStore ?? 0n; sumDue += t.due;
    }
    const asMoney = (minor) => moneyJson(Money.fromMinor(minor, currency));
    return json(res, 200, {
      payload: {
        purchases: entries,
        suppliers: visibleSuppliers.map((supplier) => serializeSupplierSummary(supplier, totals.get(supplier.id), currency, [], refundsBySupplier.get(supplier.id) ?? [])),
        total,
        offset,
        limit,
        summary: {
          purchaseCount: total,
          supplierCount: visibleSuppliers.length,
          totalPurchased: asMoney(sumTotal),
          totalPaid: asMoney(sumPaid),
          returnedCredit: asMoney(sumReturned),
          refundedToStore: asMoney(sumRefunded),
          balanceDue: asMoney(sumDue),
          from, to, hasSearch: Boolean(search),
        },
      },
    });
  }

  if (method === 'GET' && path === '/api/journal-entries') {
    const ctx = await requireContext(req);
    ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
    const storeId = await resolveHistoryStore(ctx, url);
    const { offset, limit } = parsePaging(url, 50);
    const { from, to } = parseHistoryRange(url);
    const sourceType = (url.searchParams.get('sourceType') ?? '').trim();
    if (sourceType && !/^[A-Z_]{1,40}$/.test(sourceType)) throw Object.assign(new Error('نوع القيد غير صالح'), { status: 400 });
    const conds = ['tenant_id = ?', 'store_id = ?'];
    const args = [ctx.tenantId, storeId];
    if (from && to) { conds.push('substr(entry_date, 1, 10) >= ?', 'substr(entry_date, 1, 10) <= ?'); args.push(from, to); }
    if (sourceType) { conds.push('source_type = ?'); args.push(sourceType); }
    const where = conds.join(' AND ');
    const rawDatabase = database.getRawDatabase();
    const total = Number(rawDatabase.prepare(`SELECT COUNT(*) AS total FROM journal_entries WHERE ${where}`).get(...args)?.total ?? 0);
    const headers = rawDatabase.prepare(`SELECT * FROM journal_entries WHERE ${where} ORDER BY entry_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const entries = await serializeJournalEntries(headers);
    return json(res, 200, { payload: { entries, total, offset, limit, from, to, sourceType: sourceType || null } });
  }

  if (method === 'GET' && path === '/api/customer-returns') {
    const ctx = await requireContext(req);
    if (!ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) && ctx.roleId !== 'CASHIER') throw Object.assign(new Error('غير مصرح بعرض سجل المرتجعات'), { status: 403 });
    const storeId = await resolveHistoryStore(ctx, url);
    const { offset, limit } = parsePaging(url, 100);
    const { bounds } = parseHistoryRange(url);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
    const { where, args } = customerReturnFilterSql({ tenantId: ctx.tenantId, storeId, bounds, search });
    const rawDatabase = database.getRawDatabase();
    const agg = rawDatabase.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(cr.refund_amount), 0) AS refunds FROM customer_returns cr INNER JOIN sales s ON s.id = cr.original_sale_id AND s.tenant_id = cr.tenant_id WHERE ${where}`).get(...args);
    const rows = rawDatabase.prepare(`SELECT cr.id AS id, cr.return_number AS returnNumber, cr.created_at AS createdAt, cr.refund_amount AS refundAmount, cr.currency AS currency, cr.payment_method AS paymentMethod, s.sale_number AS saleNumber FROM customer_returns cr INNER JOIN sales s ON s.id = cr.original_sale_id AND s.tenant_id = cr.tenant_id WHERE ${where} ORDER BY cr.created_at DESC, cr.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const currency = await tenantCurrencyCode(ctx.tenantId);
    return json(res, 200, {
      payload: {
        returns: rows.map((item) => ({ ...item, refundAmount: moneyJson(Money.fromMinor(BigInt(item.refundAmount), item.currency)) })),
        total: Number(agg?.total ?? 0),
        totalRefunds: moneyJson(Money.fromMinor(BigInt(agg?.refunds ?? 0), currency)),
        offset,
        limit,
      },
    });
  }

  if (method === 'GET' && path === '/api/expenses') {
    const ctx = await requireContext(req);
    const canViewExpenses = ctx.hasPermission(Permissions.EXPENSES_DIRECT_CREATE) || ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW);
    if (!canViewExpenses) throw Object.assign(new Error('غير مصرح بعرض المصروفات'), { status: 403 });
    const storeId = await resolveHistoryStore(ctx, url);
    const { offset, limit } = parsePaging(url, 100);
    const { from, to } = parseHistoryRange(url);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
    const conds = ['e.tenant_id = ?', 'e.store_id = ?', "e.expense_type = 'DIRECT_DAILY'", 'e.deleted_at IS NULL'];
    const args = [ctx.tenantId, storeId];
    if (from && to) { conds.push('e.expense_date >= ?', 'e.expense_date <= ?'); args.push(from, to); }
    if (search) {
      conds.push("(instr(lower(c.name), lower(?)) > 0 OR instr(lower(coalesce(e.notes, '')), lower(?)) > 0 OR instr(lower(coalesce(e.reference_number, '')), lower(?)) > 0)");
      args.push(search, search, search);
    }
    const where = conds.join(' AND ');
    const rawDatabase = database.getRawDatabase();
    const agg = rawDatabase.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(e.amount), 0) AS totalAmount FROM operating_expense_records e INNER JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id WHERE ${where}`).get(...args);
    const rows = rawDatabase.prepare(`SELECT e.id AS id, e.expense_date AS date, e.amount AS amount, e.currency AS currency, e.payment_method AS paymentMethod, e.notes AS notes, e.reference_number AS referenceNumber, c.name AS category FROM operating_expense_records e INNER JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id WHERE ${where} ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const currency = await tenantCurrencyCode(ctx.tenantId);
    return json(res, 200, {
      payload: {
        expenses: rows.map((expense) => ({ ...expense, amount: moneyJson(Money.fromMinor(BigInt(expense.amount), expense.currency)) })),
        total: Number(agg?.total ?? 0),
        totalAmount: moneyJson(Money.fromMinor(BigInt(agg?.totalAmount ?? 0), currency)),
        offset,
        limit,
      },
    });
  }

  const saleDetailMatch = method === 'GET' ? path.match(/^\/api\/sales\/([0-9a-f-]+)$/i) : null;
  if (saleDetailMatch) {
    const ctx = await requireContext(req);
    if (!ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW) && ctx.roleId !== 'CASHIER') throw Object.assign(new Error('غير مصرح بعرض تفاصيل الفاتورة'), { status: 403 });
    const sale = await saleRepo.findById(ctx, saleDetailMatch[1]);
    if (!sale) throw Object.assign(new Error('الفاتورة غير موجودة'), { status: 404 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const canViewCogs = ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
    const cashier = await userRepo.findById(ctx, sale.cashierUserId);
    const returned = await db.selectFrom('customer_returns').select(['id', 'return_number as returnNumber', 'refund_amount as refundAmount', 'currency', 'payment_method as paymentMethod', 'created_at as createdAt']).where('tenant_id', '=', ctx.tenantId).where('store_id', '=', sale.storeId).where('original_sale_id', '=', sale.id).orderBy('created_at', 'asc').execute();
    const rawDbDetail = database.getRawDatabase();
    const detailMetrics = loadSaleReturnsAndCogs(rawDbDetail, ctx.tenantId, sale.storeId, [sale.id]);
    const saleData = enrichSerializedSale(saleJson(sale), detailMetrics, currency, canViewCogs);
    return json(res, 200, { payload: { ...saleData, cashierName: cashier?.fullName ?? 'غير معروف', returns: returned.map((item) => ({ ...item, refundAmount: moneyJson(Money.fromMinor(BigInt(item.refundAmount), item.currency)) })) } });
  }

  const saleReceiptMatch = method === 'GET' ? path.match(/^\/api\/sales\/([0-9a-f-]+)\/receipt$/i) : null;
  if (saleReceiptMatch) {
    const ctx = await requireContext(req);
    if (!ctx.hasPermission(Permissions.POS_CHECKOUT) && !ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW)) {
      throw Object.assign(new Error('غير مصرح بطباعة الفاتورة'), { status: 403 });
    }
    const sale = await saleRepo.findById(ctx, saleReceiptMatch[1]);
    if (!sale) throw Object.assign(new Error('الفاتورة غير موجودة'), { status: 404 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const store = await storeRepo.findById(ctx, sale.storeId);
    const cashier = await userRepo.findById(ctx, sale.cashierUserId);
    const widthParam = url.searchParams.get('width') === '58mm' ? '58mm' : '80mm';
    const printer = new EscPosReceiptPrinter({
      width: widthParam,
      storeName: store?.name ?? tenant?.name ?? 'متجري',
      encodeText: (text) => new TextEncoder().encode(text),
    });
    const escPosBytes = printer.format(sale);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const rawDbReceipt = database.getRawDatabase();
    const receiptMetrics = loadSaleReturnsAndCogs(rawDbReceipt, ctx.tenantId, sale.storeId, [sale.id]);
    const enrichedReceiptSale = enrichSerializedSale(saleJson(sale), receiptMetrics, currency, false);
    return json(res, 200, {
      receipt: {
        companyName: tenant?.name ?? 'متجري',
        storeName: store?.name ?? '',
        saleNumber: sale.saleNumber,
        createdAt: sale.createdAt.toISOString(),
        cashierName: cashier?.fullName ?? 'كاشير',
        customerName: sale.customerName ?? null,
        width: widthParam,
        paperWidth: widthParam,
        items: enrichedReceiptSale.items.map((item) => ({
          productName: item.name,
          sku: item.sku,
          quantity: item.quantity,
          returnedQuantity: item.returnedQuantity,
          netQuantity: item.netQuantity,
          unitPrice: item.unitPrice,
          lineTotal: item.netRevenue,
        })),
        total: moneyJson(sale.total),
        returnedAmount: enrichedReceiptSale.returnedAmount,
        netTotal: enrichedReceiptSale.netTotal,
        returnStatus: enrichedReceiptSale.returnStatus,
        paidTotal: moneyJson(sale.paidTotal),
        changeGiven: moneyJson(sale.changeGiven),
        payments: sale.payments.map((p) => ({ method: p.method, amount: moneyJson(p.amount) })),
        escPosBase64: Buffer.from(escPosBytes).toString('base64'),
      },
    });
  }

  if (method === 'POST' && path === '/api/setup') {
    const input = validate(OwnerSchema, await readJson(req));
    const tenants = await tenantRepo.listAll();
    if (tenants.length !== 1) throw Object.assign(new Error('إعداد الشركة غير متاح'), { status: 409 });
    const systemContext = new ScopedExecutionContext({ tenantId: tenants[0].id, userId: 'system', roleId: 'OWNER', permissions: new Set(['*']), correlationId: randomUUID() });
    const id = tenants[0].id;
    const stores = await storeRepo.listByTenant(systemContext);
    const storeId = stores[0]?.id;
    if (!storeId) throw Object.assign(new Error('الفرع الرئيسي غير متاح'), { status: 409 });
    const userId = randomUUID();
    const passwordHash = await passwordHasher.hash(input.password);
    const user = User.create({ id: userId, tenantId: id, username: input.ownerUsername, passwordHash, fullName: input.ownerName, role: 'OWNER' });
    if (input.dailyBackupPassphrase) {
      await persistDailyBackupMasterPassphrase(input.dailyBackupPassphrase);
    }
    await db.transaction().execute(async (trx) => {
      const existingOwner = await trx.selectFrom('users').select('id').where('tenant_id', '=', id).where('role', '=', 'OWNER').executeTakeFirst();
      if (existingOwner) throw Object.assign(new Error('تم إنشاء حساب المدير بالفعل'), { status: 409 });
      await trx.insertInto('users').values({ id: user.id, tenant_id: user.tenantId, store_id: null, username: user.username, password_hash: user.passwordHash, full_name: user.fullName, role: user.role }).execute();
    });
    await recordAudit(systemContext, { storeId, actorUserId: user.id, actorUsername: user.username, actorRole: 'OWNER', action: 'OWNER_SETUP', entityType: 'USER', entityId: user.id, summary: `إنشاء حساب مدير النظام (${user.username})` });
    if (input.dailyBackupPassphrase) {
      await ensureDailyBackup({ force: true, syncMirror: true }).catch(() => undefined);
      await recordAudit(systemContext, {
        storeId,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: 'OWNER',
        action: 'DAILY_BACKUP_MASTER_KEY_SET',
        entityType: 'BACKUP',
        entityId: user.id,
        summary: 'تعيين عبارة الاستعادة الرئيسية للنسخ الاحتياطي عند تجهيز المتجر',
        metadata: { historicalKeysPreserved: historicalDailyBackupKeys.length },
      });
    } else {
      await ensureDailyBackup({ force: false }).catch(() => undefined);
    }
    const activeDailyKey = resolveDailyBackupPassphraseSync();
    return json(
      res,
      201,
      {
        configured: true,
        dailyBackupKey: activeDailyKey,
        historicalKeysCount: historicalDailyBackupKeys.length,
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (method === 'POST' && path === '/api/login') {
    const body = await readJson(req);
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username.length > 30 || body.password.length > 128) {
      throw Object.assign(new Error('اسم المستخدم أو كلمة المرور غير صحيحة'), { status: 400 });
    }
    const state = await setupState();
    if (!state.configured) throw Object.assign(new Error('أكمل إعداد النظام أولاً'), { status: 409 });
    pruneFailedLogins();
    const normalizedUsername = body.username.trim().toLowerCase();
    const key = normalizedUsername;
    const failures = getAuthFailures('login', key);
    const loginCooldownMs = computeLoginBackoffMs(failures.count);
    const elapsedMs = Date.now() - failures.startedAt;
    if (loginCooldownMs > 0 && elapsedMs < loginCooldownMs) {
      const waitSeconds = Math.max(1, Math.ceil((loginCooldownMs - elapsedMs) / 1000));
      throw Object.assign(new Error(`محاولات كثيرة. انتظر ${waitSeconds} ثانية ثم حاول مرة أخرى.`), { status: 429 });
    }
    try {
      const session = await auth.login({ tenantCode: state.companyCode, username: body.username, password: body.password });
      clearAuthFailures('login', key);
      const loginCtx = await auth.validateSession(session.token);
      await recordAudit(loginCtx, { storeId: session.user.storeId ?? null, actorUserId: session.user.id, actorUsername: session.user.username, actorRole: session.user.role, action: 'AUTH_LOGIN_SUCCESS', entityType: 'SESSION', entityId: session.user.id, summary: `تسجيل دخول ناجح للمستخدم (${session.user.username})` });
      const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
      const isHttps = Boolean(req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https');
      return json(res, 200, { user: session.user }, { 'Set-Cookie': `retailos_session=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}` });
    } catch {
      const updatedFailure = recordAuthFailure('login', key);
      const tenants = await tenantRepo.listAll();
      if (tenants[0]) {
        const matchedUser = await userRepo.findByUsername(tenants[0].id, normalizedUsername);
        const sysCtx = new ScopedExecutionContext({ tenantId: tenants[0].id, userId: 'system', roleId: 'OWNER', permissions: new Set(['*']), correlationId: randomUUID() });
        await recordAudit(sysCtx, {
          storeId: matchedUser?.storeId ?? null,
          actorUserId: matchedUser?.id ?? null,
          actorUsername: matchedUser?.username ?? normalizedUsername,
          actorRole: matchedUser?.role ?? 'UNKNOWN',
          action: 'AUTH_LOGIN_FAILED',
          entityType: 'SESSION',
          entityId: matchedUser?.id ?? null,
          summary: `محاولة تسجيل دخول فاشلة للحساب (${normalizedUsername})`,
          metadata: { attemptCount: updatedFailure.count },
        });
      }
      throw Object.assign(new Error('اسم المستخدم أو كلمة المرور غير صحيحة'), { status: 401 });
    }
  }

  if (method === 'POST' && path === '/api/auth/vendor-password-reset') {
    const body = validate(VendorPasswordResetSchema, await readJson(req));
    const state = await setupState();
    if (!state.configured) throw Object.assign(new Error('أكمل إعداد النظام أولًا'), { status: 409 });

    pruneFailedLogins();
    const rateKey = 'vendor-owner-reset';
    const failures = getAuthFailures('vendor_reset', rateKey);
    const cooldownMs = computeLoginBackoffMs(failures.count);
    const elapsedMs = Date.now() - failures.startedAt;
    if (cooldownMs > 0 && elapsedMs < cooldownMs) {
      const waitSeconds = Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000));
      throw Object.assign(new Error(`محاولات كثيرة. انتظر ${waitSeconds} ثانية ثم حاول مرة أخرى.`), { status: 429 });
    }

    const verification = licenseService.verifyPasswordResetToken(body.resetToken);
    if (!verification.valid || !verification.payload) {
      recordAuthFailure('vendor_reset', rateKey);
      throw Object.assign(new Error(verification.reason ?? 'كود الطوارئ غير صالح'), { status: 400 });
    }

    const tenants = await tenantRepo.listAll();
    const tenant = tenants[0];
    if (!tenant) throw Object.assign(new Error('لم يتم العثور على بيانات الشركة'), { status: 404 });

    const requestedUsername = (body.username ?? '').trim().toLowerCase();
    const rawDb = database.getRawDatabase();
    let ownerRow;
    if (requestedUsername) {
      ownerRow = rawDb
        .prepare("SELECT id, username, full_name, role, is_active FROM users WHERE tenant_id = ? AND lower(username) = ? AND role = 'OWNER' AND is_active = 1 LIMIT 1")
        .get(tenant.id, requestedUsername);
      if (!ownerRow) {
        recordAuthFailure('vendor_reset', rateKey);
        throw Object.assign(new Error('لم يتم العثور على حساب مدير نشط بهذا الاسم'), { status: 404 });
      }
    } else {
      ownerRow = rawDb
        .prepare("SELECT id, username, full_name, role, is_active FROM users WHERE tenant_id = ? AND role = 'OWNER' AND is_active = 1 ORDER BY created_at ASC LIMIT 1")
        .get(tenant.id);
      if (!ownerRow) {
        throw Object.assign(new Error('لم يتم العثور على حساب مدير نشط في النظام'), { status: 404 });
      }
    }

    const newPasswordHash = await passwordHasher.hash(body.newPassword);
    const usedAt = new Date().toISOString();
    const resetPayload = verification.payload;

    try {
      rawDb.transaction(() => {
        rawDb
          .prepare('INSERT INTO used_password_reset_tokens (reset_id, machine_id, user_id, used_at) VALUES (?, ?, ?, ?)')
          .run(resetPayload.resetId, resetPayload.machineId, ownerRow.id, usedAt);
        rawDb
          .prepare('UPDATE users SET password_hash = ? WHERE tenant_id = ? AND id = ?')
          .run(newPasswordHash, tenant.id, ownerRow.id);
        rawDb
          .prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?')
          .run(tenant.id, ownerRow.id);
      })();
    } catch (err) {
      if (String(err?.message ?? '').includes('UNIQUE constraint failed')) {
        recordAuthFailure('vendor_reset', rateKey);
        throw Object.assign(new Error('تم استخدام كود الطوارئ هذا من قبل — اطلب كودًا جديدًا من الدعم الفني'), { status: 409 });
      }
      throw err;
    }

    clearAuthFailures('vendor_reset', rateKey);
    clearAuthFailures('login', String(ownerRow.username).trim().toLowerCase());

    const sysCtx = new ScopedExecutionContext({
      tenantId: tenant.id,
      userId: ownerRow.id,
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: randomUUID(),
    });
    await recordAudit(sysCtx, {
      actorUserId: ownerRow.id,
      actorUsername: ownerRow.username,
      actorRole: 'OWNER',
      action: 'OWNER_PASSWORD_RESET_BY_VENDOR_TOKEN',
      entityType: 'USER',
      entityId: ownerRow.id,
      summary: `إعادة تعيين كلمة مرور المدير (${ownerRow.username}) باستخدام كود طوارئ مؤقت`,
      metadata: { resetId: resetPayload.resetId, machineId: resetPayload.machineId },
    });

    return json(res, 200, { ok: true, username: ownerRow.username, fullName: ownerRow.full_name });
  }

  if (method === 'POST' && path === '/api/logout') {
    const token = readCookie(req, 'retailos_session');
    if (token) {
      try {
        const logoutCtx = await auth.validateSession(token);
        await recordAudit(logoutCtx, { action: 'AUTH_LOGOUT', entityType: 'SESSION', entityId: logoutCtx.userId, summary: 'تسجيل خروج من الجلسة' });
      } catch { /* Session already expired or invalid */ }
      await auth.logout(token);
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'retailos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const ctx = await requireContext(req);
  if (mutating && !isLicenseExemptMutationPath(path)) {
    if (betaAutoLoginEnabled) {
      const betaStatus = evaluateBetaTrialStatus();
      if (betaStatus.status !== 'ACTIVE') {
        throw Object.assign(new Error(betaStatus.message || 'انتهت صلاحية النسخة التجريبية Beta'), { status: 402 });
      }
    } else {
      await licenseService.assertOperationalAccess();
    }
  }

  if (method === 'GET' && path === '/api/reports/profit-loss') return json(res, 200, await profitLossReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/top-products') return json(res, 200, await topProductsReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/purchases') return json(res, 200, await purchaseSupplierReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/financial-map') return json(res, 200, await financialMapReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/trial-balance') return json(res, 200, await trialBalanceReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/growth-forecast') return json(res, 200, await growthForecastReport(ctx, url));

  if (method === 'GET' && path === '/api/reports/export.csv') {
    const exportType = url.searchParams.get('type') ?? 'sales';
    const stores = await storeRepo.listByTenant(ctx);
    const requestedStore = url.searchParams.get('storeId');
    const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
    if (!storeId || !stores.some((s) => s.id === storeId)) throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
    const rows = [];
    if (exportType === 'sales') {
      ctx.assertPermission(Permissions.REPORTS_DAILY_VIEW);
      const salesList = await saleRepo.listByStore(ctx, storeId, 500);
      rows.push(['رقم الفاتورة', 'التاريخ', 'العميل', 'الإجمالي', 'المدفوع', 'الحالة']);
      for (const s of salesList) {
        rows.push([s.saleNumber, s.createdAt.toISOString(), s.customerName ?? 'عميل نقدي', s.total.toDecimalString(), s.paidTotal.toDecimalString(), s.status]);
      }
    } else if (exportType === 'inventory') {
      ctx.assertPermission(Permissions.INVENTORY_VIEW);
      const products = await catalog.listProducts(ctx);
      const variants = await variantRepo.listByTenant(ctx);
      const positions = await inventory.listByStore(ctx, storeId);
      const posByVar = new Map(positions.map((p) => [p.variantId, p]));
      const productById = new Map(products.map((p) => [p.id, p]));
      const canSeeWac = ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
      rows.push(['المنتج', 'كود النسخة (SKU)', 'الباركود', 'الكمية المتاحة', 'حد إعادة الطلب', 'سعر البيع', ...(canSeeWac ? ['متوسط التكلفة (WAC)'] : [])]);
      for (const v of variants) {
        const prod = productById.get(v.productId);
        const pos = posByVar.get(v.id);
        rows.push([
          prod?.name ?? '',
          v.sku,
          v.barcode ?? '',
          (pos?.quantityOnHand ?? 0n).toString(),
          v.reorderPoint.toString(),
          v.retailPrice.toDecimalString(),
          ...(canSeeWac ? [(pos?.wacCost ?? Money.zero(v.retailPrice.currency.code)).toDecimalString()] : []),
        ]);
      }
    } else if (exportType === 'accounting') {
      ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
      const headers = await db.selectFrom('journal_entries').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('entry_date', 'desc').limit(500).execute();
      rows.push(['رقم القيد', 'التاريخ', 'المصدر', 'الحالة']);
      for (const h of headers) {
        rows.push([h.entry_number, h.entry_date, h.source_type, h.status]);
      }
    } else if (exportType === 'audit') {
      ctx.assertPermission(Permissions.AUDIT_LOG_VIEW);
      const entries = await auditLogs.list(ctx, { storeId, limit: 500 });
      rows.push(['التسلسل', 'التاريخ', 'المستخدم', 'الدور', 'الإجراء', 'الملخص', 'البصمة (SHA-256)']);
      for (const e of entries) {
        rows.push([String(e.sequenceNo), e.createdAt, e.actorUsername, e.actorRole, e.action, e.summary, e.entryHash]);
      }
    } else {
      throw Object.assign(new Error('نوع التقرير غير مدعوم'), { status: 400 });
    }
    const csvContent = '\uFEFF' + rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="retailos-${exportType}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
      ...securityHeaders(),
    });
    res.end(csvContent);
    return;
  }

  if (method === 'GET' && path === '/api/audit-logs') {
    if (!ctx.hasPermission(Permissions.AUDIT_LOG_VIEW)) throw Object.assign(new Error('غير مصرح بعرض سجل المراجعة والأمان'), { status: 403 });
    const storeId = url.searchParams.get('storeId') || undefined;
    const action = url.searchParams.get('action') || undefined;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100;
    const [entries, chainVerification] = await Promise.all([
      auditLogs.list(ctx, { storeId, action, limit }),
      auditLogs.verifyChain(ctx),
    ]);
    return json(res, 200, { entries, chainVerification });
  }

  if (method === 'POST' && path === '/api/attendance/check-in') {
    if (ctx.roleId === 'OWNER') {
      throw Object.assign(new Error('تسجيل الحضور مخصص للموظفين (الكاشير) فقط، ولا ينطبق على مالك المتجر.'), { status: 403 });
    }
    const body = await readJson(req);
    const tzOffsetMinutes = normalizeTzOffsetMinutes(body?.tzOffset);
    const todayBounds = localDayUtcBounds(Date.now(), tzOffsetMinutes);
    const rawDatabase = database.getRawDatabase();
    const existing = rawDatabase.prepare(
      "SELECT id, created_at AS createdAt FROM audit_logs WHERE tenant_id = ? AND actor_user_id = ? AND action = 'ATTENDANCE_CHECK_IN' AND created_at >= ? AND created_at < ? ORDER BY sequence_no ASC LIMIT 1"
    ).get(ctx.tenantId, ctx.userId, todayBounds.startIso, todayBounds.endIso);
    if (existing) {
      return json(res, 200, { ok: true, alreadyCheckedIn: true, checkInAt: existing.createdAt });
    }
    const user = await userRepo.findById(ctx, ctx.userId);
    const checkInTime = new Date().toISOString();
    await recordAudit(ctx, {
      storeId: ctx.storeId ?? null,
      actorUserId: ctx.userId,
      actorUsername: user?.username ?? 'user',
      actorRole: ctx.roleId,
      action: 'ATTENDANCE_CHECK_IN',
      entityType: 'USER',
      entityId: ctx.userId,
      summary: `تسجيل حضور: ${user?.fullName ?? user?.username ?? ''} (${user?.username ?? ''})`,
      metadata: { checkInAt: checkInTime },
    });
    return json(res, 201, { ok: true, alreadyCheckedIn: false, checkInAt: checkInTime });
  }

  if (method === 'GET' && path === '/api/attendance/history') {
    if (!ctx.hasPermission(Permissions.USERS_MANAGE)) {
      throw Object.assign(new Error('غير مصرح بعرض سجل الحضور'), { status: 403 });
    }
    const targetUserId = url.searchParams.get('userId');
    if (!targetUserId) throw Object.assign(new Error('معرف المستخدم مطلوب'), { status: 400 });
    const targetUser = await userRepo.findById(ctx, targetUserId);
    if (!targetUser || (ctx.storeId && targetUser.storeId !== ctx.storeId)) {
      throw Object.assign(new Error('الموظف غير موجود'), { status: 404 });
    }
    const tzOffsetMinutes = normalizeTzOffsetMinutes(url.searchParams.get('tzOffset'));
    const requestedMonth = url.searchParams.get('month')?.trim() || '';
    const isMonthFilter = /^\d{4}-\d{2}$/.test(requestedMonth);

    const rawDatabase = database.getRawDatabase();
    const rows = rawDatabase.prepare(
      "SELECT id, actor_user_id AS userId, actor_username AS username, created_at AS createdAt, summary FROM audit_logs WHERE tenant_id = ? AND actor_user_id = ? AND action = 'ATTENDANCE_CHECK_IN' ORDER BY sequence_no ASC LIMIT 2000"
    ).all(ctx.tenantId, targetUserId);

    const shiftStartTime = targetUser.shiftStartTime ?? null;
    const lateGraceMinutes = targetUser.lateGraceMinutes ?? 0;

    // Deduplicate to 1 daily record (earliest check-in per local calendar day).
    const dailyMap = new Map();
    for (const r of rows) {
      const evaluated = evaluateAttendanceTimestamp(r.createdAt, shiftStartTime, lateGraceMinutes, tzOffsetMinutes);
      if (!evaluated) continue;
      const existing = dailyMap.get(evaluated.dateStr);
      if (existing) {
        existing.checkInCount += 1;
        continue;
      }
      dailyMap.set(evaluated.dateStr, {
        id: r.id,
        date: evaluated.dateStr,
        month: evaluated.monthStr,
        createdAt: r.createdAt,
        arrivalTime: evaluated.arrivalTime,
        shiftStartTime,
        lateGraceMinutes,
        isLate: evaluated.isLate,
        lateMinutes: evaluated.lateMinutes,
        status: evaluated.status,
        checkInCount: 1,
        summary: r.summary,
      });
    }

    const allDailyDesc = [...dailyMap.values()].sort((a, b) => b.date.localeCompare(a.date));
    const availableMonths = [...new Set(allDailyDesc.map((d) => d.month))];
    const filteredDaily = isMonthFilter
      ? allDailyDesc.filter((d) => d.month === requestedMonth)
      : allDailyDesc;

    let onTimeDays = 0;
    let lateDays = 0;
    let unscheduledDays = 0;
    let totalLateMinutes = 0;
    for (const entry of filteredDaily) {
      if (entry.status === 'LATE') {
        lateDays += 1;
        totalLateMinutes += entry.lateMinutes;
      } else if (entry.status === 'ON_TIME') {
        onTimeDays += 1;
      } else {
        unscheduledDays += 1;
      }
    }

    return json(res, 200, {
      userId: targetUserId,
      shiftStartTime,
      lateGraceMinutes,
      selectedMonth: isMonthFilter ? requestedMonth : 'all',
      availableMonths,
      summary: {
        totalDays: filteredDaily.length,
        onTimeDays,
        lateDays,
        unscheduledDays,
        totalLateMinutes,
      },
      history: filteredDaily,
    });
  }

  if (method === 'GET' && path === '/api/backups/daily') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    await ensureDailyBackup({ force: false }).catch(() => undefined);
    return json(res, 200, await getBackupSafetyPayload());
  }

  if (method === 'POST' && path === '/api/backups/daily/key-export') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    if (ctx.roleId !== 'OWNER') {
      throw Object.assign(new Error('متاح لمالك النظام فقط'), { status: 403 });
    }
    const body = validate(DailyKeyExportSchema, await readJson(req));
    try {
      await verifyCurrentUserPasswordOrThrow(ctx, body.currentPassword);
    } catch (authError) {
      await recordAudit(ctx, {
        action: 'DAILY_BACKUP_KEY_EXPORT_FAILED',
        entityType: 'BACKUP',
        entityId: ctx.userId,
        summary: 'محاولة فاشلة لعرض مفتاح فك تشفير النسخ اليومية',
      });
      throw authError;
    }
    const dailyBackupKey = resolveDailyBackupPassphraseSync();
    await recordAudit(ctx, {
      action: 'DAILY_BACKUP_KEY_EXPORTED',
      entityType: 'BACKUP',
      entityId: ctx.userId,
      summary: 'عرض/نسخ مفتاح فك تشفير النسخ اليومية التلقائية للاسترداد على جهاز بديل',
      metadata: {
        source: (process.env.RETAILOS_DAILY_BACKUP_KEY ?? '').trim().length >= 12 ? 'ENV' : 'DESKTOP_DPAPI',
        historicalKeysCount: historicalDailyBackupKeys.length,
      },
    });
    return json(
      res,
      200,
      {
        dailyBackupKey,
        historicalKeysCount: historicalDailyBackupKeys.length,
        previousDailyBackupKeys: [...historicalDailyBackupKeys],
        keySource: (process.env.RETAILOS_DAILY_BACKUP_KEY ?? '').trim().length >= 12 ? 'ENV' : 'DESKTOP_DPAPI',
        restoreInstructions: 'احتفظ بهذا المفتاح في مكان آمن خارج الجهاز (وكذلك أي مفاتيح سابقة إن وُجدت لملفات أقدم). عند استعادة ملف retailos-daily-*.rfbackup على جهاز جديد، ضعه في خانة «كلمة مرور النسخة» بنموذج الاستعادة.',
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (method === 'POST' && path === '/api/backups/daily/master-key') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    if (ctx.roleId !== 'OWNER') {
      throw Object.assign(new Error('متاح لمالك النظام فقط'), { status: 403 });
    }
    const body = validate(DailyMasterKeySchema, await readJson(req));
    try {
      await verifyCurrentUserPasswordOrThrow(ctx, body.currentPassword);
    } catch (authError) {
      await recordAudit(ctx, {
        action: 'DAILY_BACKUP_MASTER_KEY_FAILED',
        entityType: 'BACKUP',
        entityId: ctx.userId,
        summary: 'محاولة فاشلة لتغيير عبارة الاستعادة الرئيسية للنسخ اليومية',
      });
      throw authError;
    }
    const rotation = await persistDailyBackupMasterPassphrase(body.masterPassphrase);
    const backup = await ensureDailyBackup({ force: true, syncMirror: true });
    await recordAudit(ctx, {
      action: 'DAILY_BACKUP_MASTER_KEY_UPDATED',
      entityType: 'BACKUP',
      entityId: backup.filename,
      summary: 'تحديث عبارة الاستعادة الرئيسية للنسخ الاحتياطي وتحديث نسخة اليوم مع حفظ المفاتيح السابقة بأمان',
      metadata: {
        changed: rotation.changed,
        historicalKeysPreserved: rotation.historicalKeysCount,
        backupFilename: backup.filename,
      },
    });
    return json(
      res,
      200,
      {
        updated: true,
        changed: rotation.changed,
        historicalKeysCount: rotation.historicalKeysCount,
        backup,
        ...(await getBackupSafetyPayload()),
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  if (method === 'POST' && path === '/api/backups/daily/run-now') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    const backup = await ensureDailyBackup({ force: true, syncMirror: true });
    await recordAudit(ctx, { action: 'DAILY_BACKUP_CREATED', entityType: 'BACKUP', entityId: backup.filename, summary: `إنشاء وتحديث النسخة الاحتياطية اليومية (${backup.date})`, metadata: { filename: backup.filename, size: backup.size } });
    return json(res, 201, { created: true, backup, ...(await getBackupSafetyPayload()) });
  }

  if (method === 'POST' && path === '/api/backups/settings') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    const body = validate(BackupSettingsSchema, await readJson(req));
    const validatedMirrorPath = validateMirrorPath(body.mirrorPath);
    const current = await readBackupSettings();
    const mirrorStatus = validatedMirrorPath ? 'PENDING' : 'UNCONFIGURED';
    const mirrorError = null;
    if (validatedMirrorPath) {
      const mirrorRoot = parse(validatedMirrorPath).root;
      if (mirrorRoot && !existsSync(mirrorRoot)) {
        throw Object.assign(new Error(`محرك الأقراص (${mirrorRoot}) غير موجود أو غير متصل حاليًا`), { status: 400 });
      }
      await mkdir(validatedMirrorPath, { recursive: true });
      const probePath = join(validatedMirrorPath, `.raf-write-test-${randomUUID().slice(0, 8)}`);
      await writeFile(probePath, 'ok', 'utf8');
      await rm(probePath, { force: true }).catch(() => undefined);
    }
    await writeBackupSettings({
      mirrorPath: validatedMirrorPath,
      autoMirror: body.autoMirror,
      lastMirrorAt: validatedMirrorPath ? current.lastMirrorAt : null,
      lastMirrorStatus: mirrorStatus,
      lastMirrorError: mirrorError,
    });
    if (validatedMirrorPath && body.autoMirror) {
      await ensureDailyBackup({ force: false, minAgeMs: 0, syncMirror: true }).catch(() => undefined);
    }
    await recordAudit(ctx, {
      action: 'BACKUP_SETTINGS_UPDATED',
      entityType: 'BACKUP',
      entityId: validatedMirrorPath || 'disabled',
      summary: validatedMirrorPath ? `تفعيل النسخ الاحتياطي الخارجي التلقائي إلى: ${validatedMirrorPath}` : 'إيقاف مسار النسخ الاحتياطي الخارجي التلقائي',
      metadata: { mirrorPath: validatedMirrorPath, autoMirror: body.autoMirror },
    });
    return json(res, 200, { saved: true, ...(await getBackupSafetyPayload()) });
  }

  if (method === 'POST' && path === '/api/backups/mirror/sync-now') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    const settings = await readBackupSettings();
    if (!settings.mirrorPath) {
      throw Object.assign(new Error('قم بتحديد مسار النسخ الخارجي (فلاشة أو بارتشن آخر أو OneDrive) أولاً'), { status: 400 });
    }
    const backup = await ensureDailyBackup({ force: true, syncMirror: false });
    const syncResult = await syncDailyBackupToMirror(join(dailyBackupDir, backup.filename), backup.filename, settings);
    if (syncResult.status !== 'OK') {
      throw Object.assign(new Error(syncResult.lastMirrorError || 'فشلت المزامنة مع المجلد الخارجي'), { status: 400 });
    }
    await recordAudit(ctx, {
      action: 'BACKUP_MIRROR_SYNCED',
      entityType: 'BACKUP',
      entityId: backup.filename,
      summary: `مزامنة النسخة اليومية (${backup.date}) إلى المسار الخارجي: ${settings.mirrorPath}`,
      metadata: { filename: backup.filename, mirrorPath: settings.mirrorPath },
    });
    return json(res, 200, { synced: true, backup, ...(await getBackupSafetyPayload()) });
  }

  if (method === 'POST' && path === '/api/backups/daily/restore') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    if (req.headers['x-retailos-restore-confirm'] !== 'replace') throw Object.assign(new Error('Restore confirmation is required'), { status: 400 });
    const body = validate(DailyRestoreSchema, await readJson(req));
    const targetPath = join(dailyBackupDir, body.filename);
    if (!existsSync(targetPath)) throw Object.assign(new Error('ملف النسخة اليومية غير موجود'), { status: 404 });
    const deviceLicenseState = await readDeviceLicenseStateForRestore();

    let preparedRestore;
    try {
      if (body.filename.endsWith('.rfbackup')) {
        let lastRestoreError = null;
        for (const passphrase of resolveDailyBackupCandidatePassphrases()) {
          try {
            preparedRestore = await prepareEncryptedSqliteRestore(targetPath, dataDir, passphrase, { deviceLicenseState });
            break;
          } catch (candidateErr) {
            lastRestoreError = candidateErr;
          }
        }
        if (!preparedRestore) throw lastRestoreError ?? new Error('Unable to decrypt daily backup');
      } else {
        preparedRestore = await preparePlainSqliteRestore(targetPath, dataDir, { deviceLicenseState });
      }
    } catch {
      throw Object.assign(new Error('ملف النسخة اليومية تالف أو غير متوافق مع إصدار قاعدة البيانات'), { status: 400 });
    }
    let restartRequired = false;
    let restoreInstallStarted = false;
    try {
      await enterRestoreMaintenanceMode();
      database.beginMaintenanceMode();
      restartRequired = true;
      await waitAtRestoreTestBarrier();
      await createPreRestoreSafetySnapshot();
      restoreInstallStarted = true;
      await installPreparedSqliteRestore(database.getRawDatabase(), () => database.closeForRestore(), databasePath, dataDir, preparedRestore, restoreFileOperationsForTest());
      schedulePostRestoreRestart(res);
      return json(res, 202, { restored: true, restarting: true, restoredFrom: body.filename });
    } catch (error) {
      if (restartRequired) schedulePostRestoreRestart(res);
      throw error;
    } finally {
      if (preparedRestore && !restoreInstallStarted) await rm(preparedRestore.workspace, { recursive: true, force: true });
    }
  }

  const dailyDownloadMatch = method === 'GET' ? path.match(/^\/api\/backups\/daily\/(retailos-daily-\d{4}-\d{2}-\d{2}\.(rfbackup|sqlite))$/) : null;
  if (dailyDownloadMatch) {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    const filename = dailyDownloadMatch[1];
    const targetPath = join(dailyBackupDir, filename);
    if (!existsSync(targetPath)) throw Object.assign(new Error('النسخة الاحتياطية غير موجودة'), { status: 404 });
    const fileStat = await stat(targetPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store',
      ...securityHeaders(),
    });
    await new Promise((resolve, reject) => {
      const stream = createReadStream(targetPath);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      stream.pipe(res);
    });
    return;
  }

  if (method === 'POST' && path === '/api/backups/export') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    const body = validate(BackupSchema, await readJson(req));
    const backup = await createEncryptedSqliteBackup(database.getRawDatabase(), dataDir, body.passphrase);
    await recordAudit(ctx, { action: 'BACKUP_EXPORTED', entityType: 'BACKUP', entityId: backupDownloadName(backup.path), summary: 'تصدير نسخة احتياطية مشفرة من قاعدة البيانات', metadata: { size: backup.size } });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${backupDownloadName(backup.path)}"`, 'Content-Length': backup.size, 'Cache-Control': 'no-store', ...securityHeaders() });
    try {
      await new Promise((resolve, reject) => {
        const stream = createReadStream(backup.path);
        stream.on('error', reject);
        res.on('finish', resolve);
        res.on('close', resolve);
        stream.pipe(res);
      });
    } finally {
      await removeBackupArtifact(backup.path);
    }
    return;
  }

  if (method === 'POST' && path === '/api/backups/restore') {
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    if (req.headers['x-retailos-restore-confirm'] !== 'replace') throw Object.assign(new Error('Restore confirmation is required'), { status: 400 });
    const encodedPassphrase = req.headers['x-backup-passphrase'];
    if (typeof encodedPassphrase !== 'string' || encodedPassphrase.length > 1400) throw Object.assign(new Error('Backup passphrase is required'), { status: 400 });
    const passphrase = Buffer.from(encodedPassphrase, 'base64url').toString('utf8');
    if (Buffer.from(passphrase, 'utf8').toString('base64url') !== encodedPassphrase || passphrase.length < 12 || passphrase.length > 256) throw Object.assign(new Error('Backup passphrase is invalid'), { status: 400 });
    const maxUploadBytes = 2 * 1024 * 1024 * 1024 + 64;
    const declaredLength = req.headers['content-length'];
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxUploadBytes)) throw Object.assign(new Error('Backup file exceeds the upload limit'), { status: 413 });
    const uploadWorkspace = await mkdtemp(join(dataDir, '.retailos-upload-'));
    const archivePath = join(uploadWorkspace, 'upload.rfbackup');
    let preparedRestore;
    let restartRequired = false;
    let restoreInstallStarted = false;
    try {
      let uploadSize = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        uploadSize += chunk.length;
        if (uploadSize > maxUploadBytes) callback(Object.assign(new Error('Backup file exceeds the upload limit'), { status: 413 }));
        else callback(null, chunk);
      } });
      await pipeline(req, limit, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
      const deviceLicenseState = await readDeviceLicenseStateForRestore();
      try {
        preparedRestore = await prepareEncryptedSqliteRestore(archivePath, dataDir, passphrase, { deviceLicenseState });
      } catch {
        throw Object.assign(new Error('Backup file or passphrase is invalid, or the backup database is invalid'), { status: 400 });
      }
      await enterRestoreMaintenanceMode();
      database.beginMaintenanceMode();
      restartRequired = true;
      await waitAtRestoreTestBarrier();
      await createPreRestoreSafetySnapshot();
      restoreInstallStarted = true;
      await installPreparedSqliteRestore(database.getRawDatabase(), () => database.closeForRestore(), databasePath, dataDir, preparedRestore, restoreFileOperationsForTest());
      schedulePostRestoreRestart(res);
      return json(res, 202, { restored: true, restarting: true });
    } catch (error) {
      if (restartRequired) schedulePostRestoreRestart(res);
      throw error;
    } finally {
      await rm(uploadWorkspace, { recursive: true, force: true });
      if (preparedRestore && !restoreInstallStarted) await rm(preparedRestore.workspace, { recursive: true, force: true });
    }
  }

  if (method === 'GET' && path === '/api/data') return json(res, 200, await currentData(ctx, url));

  if (method === 'GET' && path === '/api/shifts/current') {
    const rawDb = database.getRawDatabase();
    const openShift = rawDb.prepare(
      "SELECT * FROM cashier_shifts WHERE tenant_id = ? AND user_id = ? AND status = 'OPEN' ORDER BY started_at DESC LIMIT 1"
    ).get(ctx.tenantId, ctx.userId);

    if (!openShift) return json(res, 200, { currentShift: null });

    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const storeId = openShift.store_id;

    const salesDuringShift = rawDb.prepare(`
      SELECT s.id, s.sale_number, s.created_at,
        COALESCE((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS total_amount,
        COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method = 'CASH'), 0) AS cash_paid,
        s.change_given,
        COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method != 'CASH'), 0) AS electronic_paid
      FROM sales s
      WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED' AND s.created_at >= ?
    `).all(ctx.tenantId, storeId, ctx.userId, openShift.started_at);

    const returnsDuringShift = rawDb.prepare(`
      SELECT cr.id, cr.refund_amount, cr.payment_method, cr.idempotency_key
      FROM customer_returns cr
      WHERE cr.tenant_id = ? AND cr.store_id = ? AND cr.created_at >= ?
        AND (cr.created_by_user_id = ? OR cr.original_sale_id IN (
          SELECT s.id FROM sales s
          WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED' AND s.created_at >= ?
        ))
    `).all(ctx.tenantId, storeId, openShift.started_at, ctx.userId, ctx.tenantId, storeId, ctx.userId, openShift.started_at);

    let grossSalesMinor = 0n;
    let cashSalesMinor = 0n;
    let electronicSalesMinor = 0n;
    for (const s of salesDuringShift) {
      grossSalesMinor += BigInt(s.total_amount ?? 0);
      cashSalesMinor += BigInt(s.cash_paid ?? 0) - BigInt(s.change_given ?? 0);
      electronicSalesMinor += BigInt(s.electronic_paid ?? 0);
    }
    const returnsLinkedMinor = returnsDuringShift.reduce((sum, r) => sum + BigInt(r.refund_amount ?? 0), 0n);
    const totalSalesMinor = grossSalesMinor - returnsLinkedMinor;

    let cashReturnsMinor = 0n;
    for (const r of returnsDuringShift) {
      if (r.payment_method === 'CASH') cashReturnsMinor += BigInt(r.refund_amount ?? 0);
      else if (String(r.idempotency_key ?? '').startsWith('exchange-ret:')) electronicSalesMinor -= BigInt(r.refund_amount ?? 0);
    }

    const openingCashMinor = BigInt(openShift.opening_cash ?? 0);
    const expectedCashMinor = openingCashMinor + cashSalesMinor - cashReturnsMinor;

    return json(res, 200, {
      currentShift: {
        id: openShift.id,
        shiftNumber: openShift.shift_number,
        storeId: openShift.store_id,
        startedAt: openShift.started_at,
        openingCash: openingCashMinor.toString(),
        cashSales: cashSalesMinor.toString(),
        electronicSales: electronicSalesMinor.toString(),
        cashReturns: cashReturnsMinor.toString(),
        returnsTotal: returnsLinkedMinor.toString(),
        grossSales: grossSalesMinor.toString(),
        salesCount: salesDuringShift.length,
        totalSales: totalSalesMinor.toString(),
        expectedCash: expectedCashMinor.toString(),
        notes: openShift.notes ?? '',
        currency,
      }
    });
  }

  if (method === 'POST' && path === '/api/shifts/start') {
    const body = await readJson(req);
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    const stores = await storeRepo.listByTenant(ctx);
    const storeId = ctx.storeId ?? body.storeId ?? stores[0]?.id;
    if (!storeId || !stores.some((s) => s.id === storeId)) {
      throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
    }
    const startIdempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 100)
      : null;
    const openingCash = parseNonNegativeMinorInput(body.openingCash ?? '0', 'الرصيد الافتتاحي');
    const notes = body.notes?.trim() || null;
    const nowIso = new Date().toISOString();

    const txResult = await db.transaction().execute(async (trx) => {
      if (startIdempotencyKey) {
        const replayed = await trx
          .selectFrom('cashier_shifts')
          .selectAll()
          .where('tenant_id', '=', ctx.tenantId)
          .where('start_idempotency_key', '=', startIdempotencyKey)
          .executeTakeFirst();
        if (replayed) {
          return {
            replay: true,
            shift: {
              id: replayed.id,
              shiftNumber: replayed.shift_number,
              startedAt: replayed.started_at,
              openingCash: String(replayed.opening_cash ?? 0),
              status: replayed.status,
            },
          };
        }
      }

      const existing = await trx
        .selectFrom('cashier_shifts')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('user_id', '=', ctx.userId)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();
      if (existing) {
        throw Object.assign(new Error('يوجد شيفت مفتوح بالفعل لك. يجب إنهاؤه أولاً.'), { status: 409 });
      }

      const shiftId = randomUUID();
      const shiftNumber = await generateNextShiftNumber(ctx.tenantId, trx);
      await trx
        .insertInto('cashier_shifts')
        .values({
          id: shiftId,
          shift_number: shiftNumber,
          tenant_id: ctx.tenantId,
          store_id: storeId,
          user_id: ctx.userId,
          started_at: nowIso,
          opening_cash: openingCash,
          status: 'OPEN',
          notes,
          start_idempotency_key: startIdempotencyKey,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .execute();

      return {
        replay: false,
        shift: { id: shiftId, shiftNumber, startedAt: nowIso, openingCash: openingCash.toString(), status: 'OPEN' },
      };
    });

    if (!txResult.replay) {
      const tzOffsetMinutes = normalizeTzOffsetMinutes(body?.tzOffset);
      const todayBounds = localDayUtcBounds(Date.now(), tzOffsetMinutes);
      const rawDb = database.getRawDatabase();
      const alreadyCheckedInToday = ctx.roleId === 'OWNER'
        ? true
        : Boolean(rawDb.prepare(
            "SELECT id FROM audit_logs WHERE tenant_id = ? AND actor_user_id = ? AND action = 'ATTENDANCE_CHECK_IN' AND created_at >= ? AND created_at < ? LIMIT 1"
          ).get(ctx.tenantId, ctx.userId, todayBounds.startIso, todayBounds.endIso));

      await recordAudit(ctx, {
        storeId,
        action: alreadyCheckedInToday ? 'SHIFT_STARTED' : 'ATTENDANCE_CHECK_IN',
        entityType: 'SHIFT',
        entityId: txResult.shift.id,
        summary: `بدء الشيفت (${txResult.shift.shiftNumber}) برصيد افتتاحي ${openingCash.toString()}`,
        metadata: { shiftNumber: txResult.shift.shiftNumber, openingCash: openingCash.toString(), occurredAt: nowIso },
      });
    }

    return json(res, txResult.replay ? 200 : 201, { shift: txResult.shift });
  }

  if (method === 'POST' && path === '/api/shifts/end') {
    const body = await readJson(req);
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    const shiftId = body.shiftId;
    if (!shiftId) throw Object.assign(new Error('معرف الشفت مطلوب'), { status: 400 });
    const closeIdempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 100)
      : null;
    const actualCash = parseNonNegativeMinorInput(body.actualCash ?? '0', 'النقدية الفعلية');
    const handoverCash = parseNonNegativeMinorInput(body.handoverCash ?? '0', 'مبلغ التسليم');
    const nowIso = new Date().toISOString();

    const txResult = await db.transaction().execute(async (trx) => {
      if (closeIdempotencyKey) {
        const replayed = await trx
          .selectFrom('cashier_shifts')
          .selectAll()
          .where('tenant_id', '=', ctx.tenantId)
          .where('close_idempotency_key', '=', closeIdempotencyKey)
          .executeTakeFirst();
        if (replayed) {
          if (replayed.id !== shiftId) {
            throw Object.assign(new Error('مفتاح العملية مستخدم لإغلاق شيفت مختلف'), { status: 409 });
          }
          return {
            replay: true,
            storeId: replayed.store_id,
            shift: {
              id: replayed.id,
              shiftNumber: replayed.shift_number,
              startedAt: replayed.started_at,
              endedAt: replayed.ended_at,
              openingCash: String(replayed.opening_cash ?? 0),
              expectedCash: String(replayed.expected_cash ?? 0),
              actualCash: String(replayed.actual_cash ?? 0),
              variance: String(replayed.variance ?? 0),
              handoverCash: String(replayed.handover_cash ?? 0),
              salesCount: 0,
              status: replayed.status,
            },
          };
        }
      }

      const shift = await trx
        .selectFrom('cashier_shifts')
        .selectAll()
        .where('id', '=', shiftId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!shift) throw Object.assign(new Error('الشفت غير موجود'), { status: 404 });
      if (ctx.storeId && shift.store_id !== ctx.storeId) throw Object.assign(new Error('غير مصرح بالوصول لشيفت فرع آخر'), { status: 403 });
      if (shift.status !== 'OPEN') throw Object.assign(new Error('هذا الشفت مغلق بالفعل'), { status: 409 });
      if (shift.user_id !== ctx.userId && ctx.roleId !== 'OWNER' && ctx.roleId !== 'STORE_MANAGER') {
        throw Object.assign(new Error('غير مصرح بإغلاق شفت موظف آخر'), { status: 403 });
      }

      const notes = body.notes?.trim() || shift.notes || null;
      const rawDb = database.getRawDatabase();
      const salesDuringShift = rawDb.prepare(`
        SELECT s.id,
          COALESCE((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS total_amount,
          COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method = 'CASH'), 0) AS cash_paid,
          s.change_given
        FROM sales s
        WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
          AND s.created_at >= ? AND s.created_at <= ?
      `).all(ctx.tenantId, shift.store_id, shift.user_id, shift.started_at, nowIso);

      const returnsDuringShift = rawDb.prepare(`
        SELECT cr.id, cr.refund_amount, cr.payment_method
        FROM customer_returns cr
        WHERE cr.tenant_id = ? AND cr.store_id = ?
          AND cr.created_at >= ? AND cr.created_at <= ?
          AND (cr.created_by_user_id = ? OR cr.original_sale_id IN (
            SELECT s.id FROM sales s
            WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
              AND s.created_at >= ? AND s.created_at <= ?
          ))
      `).all(ctx.tenantId, shift.store_id, shift.started_at, nowIso, shift.user_id, ctx.tenantId, shift.store_id, shift.user_id, shift.started_at, nowIso);

      let cashSalesMinor = 0n;
      for (const s of salesDuringShift) {
        cashSalesMinor += BigInt(s.cash_paid ?? 0) - BigInt(s.change_given ?? 0);
      }
      let cashReturnsMinor = 0n;
      for (const r of returnsDuringShift) {
        if (r.payment_method === 'CASH') cashReturnsMinor += BigInt(r.refund_amount ?? 0);
      }

      const openingCashMinor = BigInt(shift.opening_cash ?? 0);
      const expectedCashMinor = openingCashMinor + cashSalesMinor - cashReturnsMinor;
      const varianceMinor = actualCash - expectedCashMinor;

      const updateRes = await trx
        .updateTable('cashier_shifts')
        .set({
          ended_at: nowIso,
          expected_cash: expectedCashMinor,
          actual_cash: actualCash,
          variance: varianceMinor,
          handover_cash: handoverCash,
          status: 'CLOSED',
          notes,
          close_idempotency_key: closeIdempotencyKey,
          updated_at: nowIso,
        })
        .where('id', '=', shift.id)
        .where('tenant_id', '=', ctx.tenantId)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();

      if (updateRes.numUpdatedRows !== 1n) {
        throw Object.assign(new Error('هذا الشفت مغلق بالفعل'), { status: 409 });
      }

      return {
        replay: false,
        storeId: shift.store_id,
        shift: {
          id: shift.id,
          shiftNumber: shift.shift_number,
          startedAt: shift.started_at,
          endedAt: nowIso,
          openingCash: openingCashMinor.toString(),
          expectedCash: expectedCashMinor.toString(),
          actualCash: actualCash.toString(),
          variance: varianceMinor.toString(),
          handoverCash: handoverCash.toString(),
          salesCount: salesDuringShift.length,
          status: 'CLOSED',
        },
      };
    });

    if (!txResult.replay) {
      await recordAudit(ctx, {
        storeId: txResult.storeId,
        action: 'SHIFT_CLOSED',
        entityType: 'SHIFT',
        entityId: txResult.shift.id,
        summary: `إنهاء الشيفت (${txResult.shift.shiftNumber}): متوقع ${txResult.shift.expectedCash}، فعلي ${txResult.shift.actualCash}، الفارق ${txResult.shift.variance}`,
        metadata: { shiftNumber: txResult.shift.shiftNumber, expectedCash: txResult.shift.expectedCash, actualCash: txResult.shift.actualCash, variance: txResult.shift.variance, handoverCash: txResult.shift.handoverCash },
      });
      void ensureDailyBackup({ force: false, minAgeMs: 60_000, syncMirror: true }).catch(() => undefined);
    }

    return json(res, 200, { shift: txResult.shift });
  }

  if (method === 'GET' && path === '/api/shifts') {
    const isCashier = ctx.roleId === 'CASHIER' || !ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
    if (ctx.roleId === 'CASHIER') {
      throw Object.assign(new Error('غير مصرح للكاشير بعرض سجل الشيفتات العام'), { status: 403 });
    }
    const stores = await storeRepo.listByTenant(ctx);
    const requestedStore = url.searchParams.get('storeId');
    const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
    if (!storeId || !stores.some((s) => s.id === storeId)) {
      throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
    }
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const rawDb = database.getRawDatabase();

    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const filterUser = url.searchParams.get('userId') || '';

    let sql = `SELECT cs.*, u.full_name, u.username, u.role FROM cashier_shifts cs
      LEFT JOIN users u ON u.id = cs.user_id AND u.tenant_id = cs.tenant_id
      WHERE cs.tenant_id = ? AND cs.store_id = ?`;
    const params = [ctx.tenantId, storeId];

    if (filterUser) {
      sql += ` AND cs.user_id = ?`;
      params.push(filterUser);
    }
    if (from && to) {
      reportDay(from); reportDay(to);
      if (from > to) throw Object.assign(new Error('تاريخ البداية يجب أن يسبق تاريخ النهاية'), { status: 400 });
      const bounds = queryRangeBounds(from, to, url);
      sql += ` AND cs.started_at >= ? AND cs.started_at < ?`;
      params.push(bounds.startIso, bounds.endExclusiveIso);
    } else if (from) {
      reportDay(from);
      sql += ` AND cs.started_at >= ?`;
      params.push(queryRangeBounds(from, from, url).startIso);
    } else if (to) {
      reportDay(to);
      sql += ` AND cs.started_at < ?`;
      params.push(queryRangeBounds(to, to, url).endExclusiveIso);
    }

    sql += ` ORDER BY cs.started_at DESC LIMIT 200`;
    const shiftRows = rawDb.prepare(sql).all(...params);

    const shifts = [];
    let grandSalesMinor = 0n;
    let grandProfitMinor = 0n;
    let grandReturnsMinor = 0n;
    let grandVarianceMinor = 0n;

    for (const row of shiftRows) {
      const endTime = row.ended_at || new Date().toISOString();
      const salesQuery = rawDb.prepare(`
        SELECT COUNT(s.id) as salesCount,
          COALESCE(SUM((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) AS totalRevenue,
          COALESCE(SUM((SELECT SUM(si.net_revenue - si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id)), 0) AS grossProfit,
          COALESCE(SUM((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method = 'CASH')), 0) AS cashPaid,
          COALESCE(SUM(s.change_given), 0) AS changeGiven
        FROM sales s
        WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
          AND s.created_at >= ? AND s.created_at <= ?
      `).get(ctx.tenantId, row.store_id, row.user_id, row.started_at, endTime);

      const shiftReturnsQuery = rawDb.prepare(`
        SELECT COALESCE(SUM(cr.refund_amount), 0) AS returnedAmount,
          COALESCE(SUM(CASE WHEN cr.payment_method = 'CASH' THEN cr.refund_amount ELSE 0 END), 0) AS cashReturnsInShift,
          COALESCE(SUM((SELECT SUM(cri.cost_amount) FROM customer_return_items cri WHERE cri.tenant_id = cr.tenant_id AND cri.return_id = cr.id)), 0) AS returnedCost
        FROM customer_returns cr
        WHERE cr.tenant_id = ? AND cr.store_id = ?
          AND (
            (cr.created_at >= ? AND cr.created_at <= ? AND (cr.created_by_user_id = ? OR cr.original_sale_id IN (
              SELECT s.id FROM sales s
              WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
                AND s.created_at >= ? AND s.created_at <= ?
            )))
            OR (COALESCE(cr.is_exchange, 0) = 0 AND cr.created_at > ? AND cr.original_sale_id IN (
              SELECT s.id FROM sales s
              WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
                AND s.created_at >= ? AND s.created_at <= ?
            ))
          )
      `).get(
        ctx.tenantId, row.store_id,
        row.started_at, endTime, row.user_id, ctx.tenantId, row.store_id, row.user_id, row.started_at, endTime,
        endTime, ctx.tenantId, row.store_id, row.user_id, row.started_at, endTime,
      );

      const grossRev = BigInt(salesQuery?.totalRevenue ?? 0);
      const grossProf = BigInt(salesQuery?.grossProfit ?? 0);
      const returnedAmt = BigInt(shiftReturnsQuery?.returnedAmount ?? 0);
      const returnedCost = BigInt(shiftReturnsQuery?.returnedCost ?? 0);
      const salesRev = grossRev - returnedAmt;
      const salesProfit = grossProf - returnedAmt + returnedCost;
      const salesCount = Number(salesQuery?.salesCount ?? 0);

      let expectedCashMinor = BigInt(row.expected_cash ?? 0);
      if (row.status === 'OPEN') {
        const cashSalesMinor = BigInt(salesQuery?.cashPaid ?? 0) - BigInt(salesQuery?.changeGiven ?? 0);
        const cashReturnsDuringOpenRow = rawDb.prepare(`
          SELECT COALESCE(SUM(cr.refund_amount), 0) AS total
          FROM customer_returns cr
          WHERE cr.tenant_id = ? AND cr.store_id = ? AND cr.payment_method = 'CASH'
            AND cr.created_at >= ? AND cr.created_at <= ?
            AND (cr.created_by_user_id = ? OR cr.original_sale_id IN (
              SELECT s.id FROM sales s
              WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
                AND s.created_at >= ? AND s.created_at <= ?
            ))
        `).get(ctx.tenantId, row.store_id, row.started_at, endTime, row.user_id, ctx.tenantId, row.store_id, row.user_id, row.started_at, endTime);
        const cashReturnsMinor = BigInt(cashReturnsDuringOpenRow?.total ?? 0);
        expectedCashMinor = BigInt(row.opening_cash ?? 0) + cashSalesMinor - cashReturnsMinor;
      }

      grandSalesMinor += salesRev;
      grandReturnsMinor += returnedAmt;
      if (!isCashier) grandProfitMinor += salesProfit;
      grandVarianceMinor += BigInt(row.variance ?? 0);

      const startMs = new Date(row.started_at).getTime();
      const endMs = row.ended_at ? new Date(row.ended_at).getTime() : Date.now();
      const diffMins = Math.max(1, Math.round((endMs - startMs) / 60000));
      const hours = Math.floor(diffMins / 60);
      const mins = diffMins % 60;
      const durationStr = hours > 0 ? `${hours} س و ${mins} د` : `${mins} دقيقة`;

      shifts.push({
        id: row.id,
        shiftNumber: row.shift_number,
        storeId: row.store_id,
        userId: row.user_id,
        userName: row.full_name || row.username || 'موظف',
        userRole: row.role || 'CASHIER',
        startedAt: row.started_at,
        endedAt: row.ended_at,
        duration: durationStr,
        status: row.status,
        openingCash: String(row.opening_cash ?? 0),
        expectedCash: expectedCashMinor.toString(),
        actualCash: String(row.actual_cash ?? 0),
        variance: String(row.variance ?? 0),
        handoverCash: String(row.handover_cash ?? 0),
        salesCount,
        grossSales: grossRev.toString(),
        returnedTotal: returnedAmt.toString(),
        salesRevenue: salesRev.toString(),
        grossProfit: isCashier ? null : salesProfit.toString(),
        notes: row.notes ?? '',
      });
    }

    return json(res, 200, {
      currency,
      shifts,
      summary: {
        totalShifts: shifts.length,
        totalSales: grandSalesMinor.toString(),
        totalReturns: grandReturnsMinor.toString(),
        totalProfit: isCashier ? null : grandProfitMinor.toString(),
        totalVariance: grandVarianceMinor.toString(),
      }
    });
  }

  const shiftSalesMatch = method === 'GET' ? path.match(/^\/api\/shifts\/([0-9a-f-]+)\/sales$/i) : null;
  if (shiftSalesMatch) {
    const isCashier = ctx.roleId === 'CASHIER' || !ctx.hasPermission(Permissions.REPORTS_COGS_VIEW);
    if (ctx.roleId === 'CASHIER') {
      throw Object.assign(new Error('غير مصرح للكاشير بعرض فواتير الشيفت'), { status: 403 });
    }
    const shiftId = shiftSalesMatch[1];
    const rawDb = database.getRawDatabase();
    const shift = rawDb.prepare("SELECT * FROM cashier_shifts WHERE id = ? AND tenant_id = ?").get(shiftId, ctx.tenantId);
    if (!shift) throw Object.assign(new Error('الشيفت غير موجود'), { status: 404 });
    if (ctx.storeId && shift.store_id !== ctx.storeId) throw Object.assign(new Error('غير مصرح بالوصول لفواتير شيفت فرع آخر'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');
    const endTime = shift.ended_at || new Date().toISOString();

    const salesRows = rawDb.prepare(`
      SELECT s.id, s.sale_number, s.created_at, s.customer_name, s.status, s.change_given,
        CASE WHEN (SELECT COUNT(*) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id) > 1 THEN 'MIXED' ELSE COALESCE((SELECT sp.method FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id LIMIT 1), 'CASH') END as payment_method,
        COALESCE((SELECT SUM(si.net_revenue) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS total_amount,
        COALESCE((SELECT SUM(si.cost_of_goods_sold) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS total_cogs,
        COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id), 0) AS sold_qty,
        (SELECT COUNT(si.id) FROM sale_items si WHERE si.tenant_id = s.tenant_id AND si.sale_id = s.id) as items_count,
        COALESCE((SELECT SUM(cr.refund_amount) FROM customer_returns cr WHERE cr.tenant_id = s.tenant_id AND cr.store_id = s.store_id AND cr.original_sale_id = s.id AND cr.created_at >= ? AND (cr.created_at <= ? OR COALESCE(cr.is_exchange, 0) = 0)), 0) AS returned_amount,
        COALESCE((SELECT SUM(cri.cost_amount) FROM customer_return_items cri INNER JOIN customer_returns cr ON cr.id = cri.return_id AND cr.tenant_id = cri.tenant_id WHERE cr.tenant_id = s.tenant_id AND cr.store_id = s.store_id AND cr.original_sale_id = s.id AND cr.created_at >= ? AND (cr.created_at <= ? OR COALESCE(cr.is_exchange, 0) = 0)), 0) AS returned_cost,
        COALESCE((SELECT SUM(cri.quantity) FROM customer_return_items cri INNER JOIN customer_returns cr ON cr.id = cri.return_id AND cr.tenant_id = cri.tenant_id WHERE cr.tenant_id = s.tenant_id AND cr.store_id = s.store_id AND cr.original_sale_id = s.id AND cr.created_at >= ? AND (cr.created_at <= ? OR COALESCE(cr.is_exchange, 0) = 0)), 0) AS returned_qty
      FROM sales s
      WHERE s.tenant_id = ? AND s.store_id = ? AND s.cashier_user_id = ? AND s.status = 'COMPLETED'
        AND s.created_at >= ? AND s.created_at <= ?
      ORDER BY s.created_at DESC
    `).all(shift.started_at, endTime, shift.started_at, endTime, shift.started_at, endTime, ctx.tenantId, shift.store_id, shift.user_id, shift.started_at, endTime);

    return json(res, 200, {
      currency,
      shift: { id: shift.id, shiftNumber: shift.shift_number, startedAt: shift.started_at, endedAt: shift.ended_at },
      sales: salesRows.map((s) => {
        const origTotal = BigInt(s.total_amount ?? 0);
        const retAmt = BigInt(s.returned_amount ?? 0);
        const netTotal = origTotal > retAmt ? origTotal - retAmt : 0n;
        const origCogs = BigInt(s.total_cogs ?? 0);
        const retCost = BigInt(s.returned_cost ?? 0);
        const netProfit = netTotal - (origCogs - retCost);
        const soldQty = BigInt(s.sold_qty ?? 0);
        const retQty = BigInt(s.returned_qty ?? 0);
        const netQty = soldQty > retQty ? soldQty - retQty : 0n;
        const returnStatus = (retAmt === 0n && retQty === 0n) ? 'NONE' : (netQty <= 0n || netTotal <= 0n ? 'FULL' : 'PARTIAL');
        return {
          id: s.id,
          saleNumber: s.sale_number,
          createdAt: s.created_at,
          customerName: s.customer_name || 'عميل نقدي',
          paymentMethod: s.payment_method,
          itemsCount: s.items_count,
          soldQty: soldQty.toString(),
          returnedQty: retQty.toString(),
          netQty: netQty.toString(),
          originalTotal: origTotal.toString(),
          returnedAmount: retAmt.toString(),
          total: netTotal.toString(),
          returnStatus,
          grossProfit: isCashier ? null : netProfit.toString(),
        };
      })
    });
  }

  if (method === 'POST' && path === '/api/users') {
    ctx.assertPermission(Permissions.USERS_MANAGE);
    const body = validate(CreateUserSchema, await readJson(req));
    try {
      const created = await tenantService.createUser(ctx, {
        id: randomUUID(), username: body.username, passwordPlain: body.password,
        fullName: body.fullName, phone: body.phone || undefined, employmentStartDate: body.employmentStartDate,
        shiftStartTime: body.shiftStartTime ?? undefined, lateGraceMinutes: body.lateGraceMinutes ?? 0,
        role: body.role, storeId: body.storeId,
      });
      await recordAudit(ctx, { storeId: created.storeId ?? null, action: 'USER_CREATED', entityType: 'USER', entityId: created.id, summary: `إضافة حساب موظف جديد (${created.username} - ${created.role})`, metadata: { role: created.role, username: created.username, shiftStartTime: created.shiftStartTime ?? null, lateGraceMinutes: created.lateGraceMinutes } });
      return json(res, 201, { id: created.id, username: created.username });
    } catch (error) {
      if (error?.message?.startsWith('UserError:')) throw Object.assign(new Error('Username is already in use'), { status: 409 });
      if (error?.message?.startsWith('StoreError:')) throw Object.assign(new Error('Selected store is unavailable'), { status: 400 });
      throw error;
    }
  }

  if (method === 'PATCH' && path === '/api/users/shift-schedule') {
    ctx.assertPermission(Permissions.USERS_MANAGE);
    const body = validate(BulkShiftScheduleSchema, await readJson(req));
    const managed = await userRepo.listByTenant(ctx);
    const allowedUsers = managed.filter((u) => {
      if (ctx.roleId !== 'OWNER' && u.role !== 'CASHIER') return false;
      if (ctx.storeId && u.storeId !== ctx.storeId) return false;
      if (body.userIds?.length) return body.userIds.includes(u.id);
      return u.role !== 'OWNER' && u.isActive;
    });
    if (!allowedUsers.length) {
      throw Object.assign(new Error('لا يوجد موظفون مطابقون لتحديث موعد بدء الشيفت'), { status: 400 });
    }
    const nextShiftStart = body.shiftStartTime || null;
    const nextGrace = body.lateGraceMinutes;
    await db.transaction().execute(async (trx) => {
      for (const u of allowedUsers) {
        const updateSet = {
          shift_start_time: nextShiftStart,
          ...(nextGrace !== undefined ? { late_grace_minutes: nextGrace } : {}),
        };
        await trx.updateTable('users').set(updateSet).where('tenant_id', '=', ctx.tenantId).where('id', '=', u.id).execute();
      }
    });
    await recordAudit(ctx, {
      storeId: ctx.storeId ?? null,
      action: 'SHIFT_SCHEDULE_UPDATED',
      entityType: 'USER',
      entityId: allowedUsers.length === 1 ? allowedUsers[0].id : null,
      summary: nextShiftStart
        ? `تحديث موعد بدء الشيفت (${nextShiftStart}، سماح ${nextGrace ?? 0} د) لعدد ${allowedUsers.length} موظف`
        : `إلغاء تحديد موعد بدء الشيفت لعدد ${allowedUsers.length} موظف`,
      metadata: { updatedCount: allowedUsers.length, shiftStartTime: nextShiftStart, lateGraceMinutes: nextGrace ?? null },
    });
    return json(res, 200, { updatedCount: allowedUsers.length, shiftStartTime: nextShiftStart, lateGraceMinutes: nextGrace ?? 0 });
  }

  const userMatch = path.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
  if (method === 'PATCH' && userMatch) {
    ctx.assertPermission(Permissions.USERS_MANAGE);
    const body = validate(UpdateUserSchema, await readJson(req));
    const targetId = userMatch[1];
    const target = await db.selectFrom('users').selectAll().where('tenant_id', '=', ctx.tenantId).where('id', '=', targetId).executeTakeFirst();
    if (!target || (ctx.storeId && target.store_id !== ctx.storeId)) throw Object.assign(new Error('User not found'), { status: 404 });
    const nextRole = body.role ?? target.role;
    const nextStoreId = body.storeId === undefined ? target.store_id : body.storeId;
    const nextActive = body.isActive === undefined ? Boolean(target.is_active) : body.isActive;
    const nextShiftStartTime = body.shiftStartTime === undefined ? target.shift_start_time : (body.shiftStartTime || null);
    const nextLateGraceMinutes = body.lateGraceMinutes === undefined ? Number(target.late_grace_minutes ?? 0) : body.lateGraceMinutes;
    if (target.id === ctx.userId && (nextRole !== target.role || !nextActive)) throw Object.assign(new Error('You cannot change your own role or deactivate your own account'), { status: 400 });
    if (target.id === ctx.userId && body.newPassword) throw Object.assign(new Error('استخدم صفحة تغيير كلمة المرور لتحديث كلمة مرورك'), { status: 400 });
    if (ctx.roleId !== 'OWNER' && (target.role !== 'CASHIER' || nextRole !== 'CASHIER' || nextStoreId !== ctx.storeId)) throw Object.assign(new Error('Store managers can only manage cashiers in their assigned store'), { status: 403 });
    if (nextRole === 'CASHIER' && !nextStoreId) throw Object.assign(new Error('Cashiers must be assigned to a store'), { status: 400 });
    if (nextStoreId && !await db.selectFrom('stores').select('id').where('tenant_id', '=', ctx.tenantId).where('id', '=', nextStoreId).executeTakeFirst()) throw Object.assign(new Error('Selected store is unavailable'), { status: 400 });
    if (target.role === 'OWNER' && target.is_active && (nextRole !== 'OWNER' || !nextActive)) {
      const activeOwners = await db.selectFrom('users').select(db.fn.countAll().as('count')).where('tenant_id', '=', ctx.tenantId).where('role', '=', 'OWNER').where('is_active', '=', 1).executeTakeFirst();
      if (Number(activeOwners?.count ?? 0) <= 1) throw Object.assign(new Error('At least one active owner must remain'), { status: 409 });
    }
    const passwordHash = body.newPassword ? await passwordHasher.hash(body.newPassword) : null;
    const revokeSessions = nextRole !== target.role || nextStoreId !== target.store_id || Number(nextActive) !== target.is_active || Boolean(passwordHash);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ full_name: body.fullName ?? target.full_name, phone: body.phone === undefined ? target.phone : body.phone || null, employment_start_date: body.employmentStartDate ?? target.employment_start_date, shift_start_time: nextShiftStartTime, late_grace_minutes: nextLateGraceMinutes, role: nextRole, store_id: nextStoreId, is_active: nextActive ? 1 : 0, ...(passwordHash ? { password_hash: passwordHash } : {}) }).where('tenant_id', '=', ctx.tenantId).where('id', '=', targetId).execute();
      if (revokeSessions) await trx.updateTable('sessions').set({ is_revoked: 1 }).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', targetId).execute();
    });
    await recordAudit(ctx, { storeId: nextStoreId ?? null, action: 'USER_UPDATED', entityType: 'USER', entityId: targetId, summary: passwordHash ? `إعادة تعيين كلمة مرور الموظف وإلغاء جلساته (${target.username})` : `تحديث بيانات الموظف (${target.username})`, metadata: { role: nextRole, isActive: nextActive, shiftStartTime: nextShiftStartTime, lateGraceMinutes: nextLateGraceMinutes, passwordReset: Boolean(passwordHash), sessionsRevoked: revokeSessions } });
    if (passwordHash) clearAuthFailures('login', String(target.username).toLowerCase());
    return json(res, 200, { updated: true, passwordReset: Boolean(passwordHash), sessionsRevoked: revokeSessions });
  }

  if (method === 'POST' && path === '/api/account/password') {
    const body = validate(PasswordChangeSchema, await readJson(req));
    const currentUser = await verifyCurrentUserPasswordOrThrow(ctx, body.currentPassword);
    const passwordHash = await passwordHasher.hash(body.newPassword);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ password_hash: passwordHash }).where('tenant_id', '=', ctx.tenantId).where('id', '=', ctx.userId).execute();
      await trx.updateTable('sessions').set({ is_revoked: 1 }).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', ctx.userId).execute();
    });
    await recordAudit(ctx, { actorUsername: currentUser.username, action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: ctx.userId, summary: `تغيير كلمة المرور وإلغاء الجلسات السابقة (${currentUser.username})` });
    return json(res, 200, { passwordChanged: true, signedOut: true });
  }

  if (method === 'POST' && path === '/api/categories') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(z.object({ name: z.string().min(2).max(100).trim() }), await readJson(req));
    const created = await catalog.createCategory(ctx, {
      id: randomUUID(), name: body.name, code: `CAT-${randomUUID().slice(0, 8).toUpperCase()}`,
    });
    return json(res, 201, { id: created.id, name: created.name });
  }

  const categoryPatchMatch = method === 'PATCH' ? path.match(/^\/api\/categories\/([0-9a-f-]+)$/i) : null;
  if (categoryPatchMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const categoryId = categoryPatchMatch[1];
    const body = validate(z.object({ name: z.string().min(2, 'اسم الفئة يجب أن يكون حرفين على الأقل').max(100).trim() }), await readJson(req));
    const existing = await db.selectFrom('categories').select(['id', 'name']).where('tenant_id', '=', ctx.tenantId).where('id', '=', categoryId).executeTakeFirst();
    if (!existing) throw Object.assign(new Error('الفئة غير موجودة'), { status: 404 });
    await db.updateTable('categories').set({ name: body.name }).where('tenant_id', '=', ctx.tenantId).where('id', '=', categoryId).execute();
    await recordAudit(ctx, { action: 'CATEGORY_UPDATED', entityType: 'CATEGORY', entityId: categoryId, summary: `تعديل اسم الفئة (${existing.name} → ${body.name})`, metadata: { oldName: existing.name, newName: body.name } });
    return json(res, 200, { id: categoryId, name: body.name });
  }

  if (method === 'POST' && path === '/api/products') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(CreateProductSchema, await readJson(req));
    assertVariantOptions(body.options, body.variants);
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const created = await catalog.createProduct(ctx, {
      id: randomUUID(), name: body.name, sku: body.sku, barcode: body.barcode, itemKind: 'PRODUCT',
      categoryId: body.categoryId, hasVariants: body.hasVariants,
      description: body.description, brand: body.brand, imagePath: body.imagePath, options: body.options,
      variants: body.variants.map((variant) => ({
        id: randomUUID(), sku: variant.sku, barcode: variant.barcode, attributes: variant.attributes,
        retailPrice: Money.fromMinor(BigInt(variant.retailPrice), tenant.currency),
        reorderPoint: BigInt(variant.reorderPoint ?? '0'),
      })),
    });
    await recordAudit(ctx, { action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: created.product.id, summary: `إضافة منتج جديد (${created.product.name} - ${created.product.sku})`, metadata: { sku: created.product.sku, variantCount: body.variants.length } });
    return json(res, 201, { id: created.product.id, name: created.product.name });
  }

  const productMutation = path.match(/^\/api\/products\/([0-9a-f-]+)$/i);
  const variantMutation = path.match(/^\/api\/products\/([0-9a-f-]+)\/variants\/([0-9a-f-]+)$/i);
  if (variantMutation && method === 'DELETE') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const [, productId, variantId] = variantMutation;
    const product = await productRepo.findById(ctx, productId);
    const variant = await variantRepo.findById(ctx, variantId);
    if (!product || !variant || variant.productId !== productId) throw Object.assign(new Error('المنتج أو التركيبة غير موجودة'), { status: 404 });
    const balances = await db.selectFrom('inventory_items').select('quantity_on_hand').where('tenant_id', '=', ctx.tenantId).where('variant_id', '=', variantId).execute();
    if (balances.some((balance) => BigInt(balance.quantity_on_hand) !== 0n)) throw Object.assign(new Error('لا يمكن حذف التركيبة قبل تصريف رصيدها من كل الفروع'), { status: 409 });
    await db.updateTable('product_variants').set({ is_active: 0 }).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).where('id', '=', variantId).execute();
    return json(res, 200, { id: variantId, archived: true });
  }
  if (productMutation && method === 'PATCH') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const productId = productMutation[1];
    const body = validate(UpdateProductSchema, await readJson(req));
    assertVariantOptions(body.options, body.variants);
    const product = await productRepo.findById(ctx, productId);
    if (!product) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const category = body.categoryId ? await categoryRepo.findById(ctx, body.categoryId) : null;
    if (body.categoryId && !category) throw Object.assign(new Error('الفئة المحددة غير موجودة'), { status: 400 });
    const currentVariants = await variantRepo.listByProduct(ctx, productId);
    const currentIds = new Set(currentVariants.map((variant) => variant.id));
    const currentById = new Map(currentVariants.map((variant) => [variant.id, variant]));
    const retainedIds = new Set(body.variants.map((variant) => variant.id).filter(Boolean));
    if (retainedIds.size !== body.variants.filter((variant) => variant.id).length || [...retainedIds].some((id) => !currentIds.has(id))) throw Object.assign(new Error('قائمة نسخ المنتج غير متوافقة، حدّث الصفحة وحاول مرة أخرى'), { status: 409 });
    const duplicateProduct = await db.selectFrom('products').select('id').where('tenant_id', '=', ctx.tenantId).where('sku', '=', body.sku.toUpperCase()).where('id', '!=', productId).executeTakeFirst();
    if (duplicateProduct) throw Object.assign(new Error('كود المنتج مستخدم بالفعل'), { status: 409 });
    const skuSet = new Set();
    const barcodeSet = new Set();
    for (const variant of body.variants) {
      const normalizedSku = variant.sku.toUpperCase();
      if (skuSet.has(normalizedSku)) throw Object.assign(new Error('لا يمكن تكرار كود النسخة'), { status: 400 });
      skuSet.add(normalizedSku);
      const skuMatch = await variantRepo.findBySku(ctx, normalizedSku);
      if (skuMatch && skuMatch.id !== variant.id) throw Object.assign(new Error(`كود النسخة ${normalizedSku} مستخدم بالفعل`), { status: 409 });
      if (variant.id) {
        const current = currentById.get(variant.id);
        if (current && JSON.stringify(current.attributes) !== JSON.stringify(variant.attributes ?? {})) throw Object.assign(new Error('لا يمكن تغيير خصائص نسخة لها سجل سابق. أضف تركيبة جديدة وأوقف القديمة بعد تصريف مخزونها.'), { status: 409 });
      }
      const barcode = variant.barcode?.trim() || null;
      if (barcode) {
        if (barcodeSet.has(barcode)) throw Object.assign(new Error('لا يمكن تكرار الباركود'), { status: 400 });
        barcodeSet.add(barcode);
        const barcodeMatch = await variantRepo.findByBarcode(ctx, barcode);
        if (barcodeMatch && barcodeMatch.id !== variant.id) throw Object.assign(new Error(`الباركود ${barcode} مستخدم بالفعل`), { status: 409 });
      }
    }
    const omittedVariants = currentVariants.filter((variant) => variant.isActive && !retainedIds.has(variant.id));
    for (const variant of omittedVariants) {
      const balances = await db.selectFrom('inventory_items').select('quantity_on_hand').where('tenant_id', '=', ctx.tenantId).where('variant_id', '=', variant.id).execute();
      if (balances.some((balance) => BigInt(balance.quantity_on_hand) !== 0n)) throw Object.assign(new Error(`لا يمكن إيقاف النسخة ${variant.sku} قبل تصريف مخزونها في كل الفروع`), { status: 409 });
    }
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('products').set({ name: body.name, sku: body.sku.toUpperCase(), category_id: body.categoryId, description: body.description ?? null, brand: body.brand ?? null, image_path: body.imagePath ?? null, options_json: JSON.stringify(body.options), has_variants: body.options.length ? 1 : 0 }).where('tenant_id', '=', ctx.tenantId).where('id', '=', productId).execute();
      for (const variant of body.variants) {
        const existing = variant.id ? currentById.get(variant.id) : null;
        const nextBarcode = variant.barcode === undefined ? (existing?.barcode ?? null) : (variant.barcode?.trim() || null);
        const values = { sku: variant.sku.toUpperCase(), barcode: nextBarcode, attributes_json: JSON.stringify(variant.attributes ?? {}), retail_price: BigInt(variant.retailPrice), currency: tenant.currency, reorder_point: BigInt(variant.reorderPoint), is_active: 1 };
        if (variant.id) await trx.updateTable('product_variants').set(values).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).where('id', '=', variant.id).execute();
        else await trx.insertInto('product_variants').values({ id: randomUUID(), tenant_id: ctx.tenantId, product_id: productId, ...values }).execute();
      }
      for (const variant of omittedVariants) await trx.updateTable('product_variants').set({ is_active: 0 }).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).where('id', '=', variant.id).execute();
    });
    await recordAudit(ctx, { action: 'PRODUCT_UPDATED', entityType: 'PRODUCT', entityId: productId, summary: `تحديث بيانات الموديل (${body.name} - ${body.sku.toUpperCase()})`, metadata: { sku: body.sku.toUpperCase(), variantCount: body.variants.length, hasImage: Boolean(body.imagePath) } });
    return json(res, 200, { id: productId, updated: true });
  }
  if (productMutation && method === 'DELETE') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const productId = productMutation[1];
    const product = await productRepo.findById(ctx, productId);
    if (!product) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });
    const productVariants = await variantRepo.listByProduct(ctx, productId);
    const balances = productVariants.length ? await db.selectFrom('inventory_items').select('quantity_on_hand').where('tenant_id', '=', ctx.tenantId).where('variant_id', 'in', productVariants.map((variant) => variant.id)).execute() : [];
    if (balances.some((balance) => BigInt(balance.quantity_on_hand) !== 0n)) throw Object.assign(new Error('لا يمكن حذف المنتج قبل تصريف أرصدة كل تركيباته في جميع الفروع'), { status: 409 });
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('products').set({ is_active: 0 }).where('tenant_id', '=', ctx.tenantId).where('id', '=', productId).execute();
      await trx.updateTable('product_variants').set({ is_active: 0 }).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).execute();
    });
    return json(res, 200, { id: productId, archived: true });
  }

  if (method === 'POST' && path === '/api/suppliers') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(SupplierSchema, await readJson(req));
    const id = randomUUID();
    await db.insertInto('suppliers').values({ id, tenant_id: ctx.tenantId, name: body.name, phone: body.phone ?? null, notes: body.notes ?? null }).execute();
    return json(res, 201, { id });
  }

  if (method === 'POST' && path === '/api/dev/reset-operational-data') {
    if (!developmentResetEnabled) throw Object.assign(new Error('المسح متاح فقط لخادم تطوير معزول ومفعّل صراحةً'), { status: 404 });
    ctx.assertPermission(Permissions.SYSTEM_BACKUP_MANAGE);
    if (ctx.roleId !== 'OWNER') throw Object.assign(new Error('المسح متاح لمدير النظام فقط'), { status: 403 });
    const body = validate(z.object({
      confirmation: z.enum(['مسح بيانات التطوير', 'مسح جميع البيانات']),
      currentPassword: betaAutoLoginEnabled ? z.string().max(128).optional() : z.string().min(1).max(128),
    }), await readJson(req));
    if (!betaAutoLoginEnabled) {
      const owner = await userRepo.findById(ctx, ctx.userId);
      if (!owner || !(await passwordHasher.verify(owner.passwordHash, body.currentPassword ?? ''))) {
        throw Object.assign(new Error('كلمة المرور الحالية غير صحيحة'), { status: 403 });
      }
    }

    const resetResult = resetDevelopmentOperationalData(database.getRawDatabase());
    await recordAudit(ctx, {
      action: 'DEV_OPERATIONAL_DATA_RESET',
      entityType: 'DEVELOPMENT_DATA',
      summary: 'مسح بيانات التشغيل من بيئة التطوير مع الإبقاء على الهوية والترخيص وسجل التدقيق والنسخ الاحتياطية',
      metadata: resetResult,
    });
    return json(res, 200, resetResult);
  }

  const supplierPatchMatch = method === 'PATCH' ? path.match(/^\/api\/suppliers\/([0-9a-f-]+)$/i) : null;
  if (supplierPatchMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const supplierId = supplierPatchMatch[1];
    const body = validate(SupplierSchema, await readJson(req));
    const existing = await db.selectFrom('suppliers').select(['id', 'name', 'phone', 'notes']).where('tenant_id', '=', ctx.tenantId).where('id', '=', supplierId).executeTakeFirst();
    if (!existing) throw Object.assign(new Error('التاجر غير موجود'), { status: 404 });
    await db.updateTable('suppliers').set({ name: body.name, phone: body.phone || null, notes: body.notes || null }).where('tenant_id', '=', ctx.tenantId).where('id', '=', supplierId).execute();
    await recordAudit(ctx, { action: 'SUPPLIER_UPDATED', entityType: 'SUPPLIER', entityId: supplierId, summary: `تعديل بيانات التاجر (${existing.name} → ${body.name})`, metadata: { oldName: existing.name, newName: body.name, phone: body.phone ?? null } });
    return json(res, 200, { id: supplierId, name: body.name });
  }

  const supplierArchiveMatch = method === 'PATCH' ? path.match(/^\/api\/suppliers\/([0-9a-f-]+)\/archive$/i) : null;
  if (supplierArchiveMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(z.object({ archived: z.boolean() }), await readJson(req));
    const supplierId = supplierArchiveMatch[1];
    const supplier = await db.selectFrom('suppliers').select(['id', 'name', 'is_active']).where('tenant_id', '=', ctx.tenantId).where('id', '=', supplierId).executeTakeFirst();
    if (!supplier) throw Object.assign(new Error('التاجر غير موجود'), { status: 404 });
    const active = body.archived ? 0 : 1;
    if (supplier.is_active !== active) {
      await db.updateTable('suppliers').set({ is_active: active }).where('tenant_id', '=', ctx.tenantId).where('id', '=', supplierId).execute();
      await recordAudit(ctx, {
        action: body.archived ? 'SUPPLIER_ARCHIVED' : 'SUPPLIER_REACTIVATED',
        entityType: 'SUPPLIER',
        entityId: supplierId,
        summary: `${body.archived ? 'أرشفة' : 'إعادة تفعيل'} التاجر (${supplier.name}) مع الاحتفاظ بسجل معاملاته`,
        metadata: { archived: body.archived },
      });
    }
    return json(res, 200, { id: supplierId, archived: body.archived });
  }

  if (method === 'POST' && path === '/api/expenses') {
    ctx.assertPermission(Permissions.EXPENSES_DIRECT_CREATE);
    const body = validate(ExpenseSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const savedId = await expenses.record(ctx, { ...body, id, amount: BigInt(body.amount), currency: tenant.currency });
    return json(res, 201, { id: savedId });
  }

  const updateExpenseMatch = method === 'PATCH' ? path.match(/^\/api\/expenses\/([0-9a-f-]+)$/i) : null;
  if (updateExpenseMatch) {
    ctx.assertPermission(Permissions.EXPENSES_DIRECT_CREATE);
    if (!['OWNER', 'STORE_MANAGER'].includes(ctx.roleId)) {
      throw Object.assign(new Error('غير مصرح بتعديل المصروفات'), { status: 403 });
    }
    const body = validate(UpdateExpenseSchema, await readJson(req));
    const updated = await expenses.update(ctx, {
      idempotencyKey: body.idempotencyKey,
      expenseId: updateExpenseMatch[1],
      categoryCode: body.categoryCode,
      amount: BigInt(body.amount),
      paymentMethod: body.paymentMethod,
      expenseDate: body.expenseDate,
      notes: body.notes,
      referenceNumber: body.referenceNumber,
      updatedAt: new Date(),
    });
    await recordAudit(ctx, {
      storeId: updated.storeId,
      action: 'EXPENSE_UPDATED',
      entityType: 'EXPENSE',
      entityId: updated.id,
      summary: `تعديل مصروف (${updated.categoryName}) من ${updated.oldAmount.toString()} إلى ${updated.newAmount.toString()}`,
      metadata: {
        oldAmount: updated.oldAmount.toString(),
        newAmount: updated.newAmount.toString(),
        oldMethod: updated.oldMethod,
        newMethod: updated.newMethod,
        expenseDate: body.expenseDate,
      },
    });
    return json(res, 200, { id: updated.id, updated: true });
  }

  const deleteExpenseMatch = method === 'DELETE' ? path.match(/^\/api\/expenses\/([0-9a-f-]+)$/i) : null;
  if (deleteExpenseMatch) {
    if (!['OWNER', 'STORE_MANAGER'].includes(ctx.roleId)) {
      throw Object.assign(new Error('غير مصرح بحذف المصروفات'), { status: 403 });
    }
    const deleted = await expenses.softDelete(ctx, { expenseId: deleteExpenseMatch[1], deletedAt: new Date() });
    await recordAudit(ctx, {
      storeId: deleted.storeId,
      action: 'EXPENSE_DELETED',
      entityType: 'EXPENSE',
      entityId: deleted.id,
      summary: `حذف وعكس مصروف (${deleted.categoryName}) بقيمة ${deleted.amount.toString()}`,
      metadata: { expenseDate: deleted.expenseDate, amount: deleted.amount.toString(), paymentMethod: deleted.paymentMethod },
    });
    return json(res, 200, { id: deleted.id, deleted: true });
  }

  if (method === 'POST' && path === '/api/recurring-expenses') {
    ctx.assertPermission(Permissions.EXPENSES_MONTHLY_CONFIRM);
    const body = validate(RecurringObligationSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = await recurringExpenses.create(ctx, { ...body, id: randomUUID(), currency: tenant.currency });
    if (body.initialAmount && BigInt(body.initialAmount) > 0n) {
      const now = new Date();
      await recurringExpenses.confirmActual(ctx, {
        obligationId: id,
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        amount: BigInt(body.initialAmount),
        confirmedAt: now
      });
    }
    return json(res, 201, { id });
  }

  const monthlyConfirmMatch = method === 'POST' ? path.match(/^\/api\/recurring-expenses\/([0-9a-f-]+)\/actual$/i) : null;
  if (monthlyConfirmMatch) {
    ctx.assertPermission(Permissions.EXPENSES_MONTHLY_CONFIRM);
    const body = validate(MonthlyActualSchema, await readJson(req));
    const actual = await recurringExpenses.confirmActual(ctx, { obligationId: monthlyConfirmMatch[1], ...body, amount: BigInt(body.amount), confirmedAt: new Date() });
    return json(res, 201, { id: actual.id, amount: actual.amount.toString() });
  }

  const monthlyPaymentMatch = method === 'POST' ? path.match(/^\/api\/monthly-expenses\/([0-9a-f-]+)\/payments$/i) : null;
  if (monthlyPaymentMatch) {
    ctx.assertPermission(Permissions.EXPENSES_MONTHLY_PAY);
    const body = validate(MonthlyPaymentSchema, await readJson(req));
    const expenseDate = body.tzOffset !== undefined ? localDayUtcBounds(Date.now(), body.tzOffset).dateStr : undefined;
    const payment = await recurringExpenses.pay(ctx, { ...body, id: randomUUID(), actualId: monthlyPaymentMatch[1], amount: BigInt(body.amount), paidAt: new Date(), expenseDate });
    return json(res, 201, { id: payment.id, remaining: payment.remaining.toString() });
  }

  const returnMatch = method === 'POST' ? path.match(/^\/api\/sales\/([0-9a-f-]+)\/returns$/i) : null;
  if (returnMatch) {
    ctx.assertPermission(Permissions.POS_REFUND);
    const body = validate(CustomerReturnSchema, await readJson(req));
    const result = await returns.record(ctx, {
      id: randomUUID(),
      idempotencyKey: body.idempotencyKey,
      storeId: body.storeId,
      originalSaleId: returnMatch[1],
      paymentMethod: body.paymentMethod,
      occurredAt: new Date(),
      lines: body.items.map((item) => ({ originalSaleItemId: item.originalSaleItemId, quantity: BigInt(item.quantity) }))
    });
    return json(res, 201, { id: result.id, returnNumber: result.returnNumber, refundAmount: result.refundAmount.toString() });
  }

  const exchangeMatch = method === 'POST' ? path.match(/^\/api\/sales\/([0-9a-f-]+)\/exchange$/i) : null;
  if (exchangeMatch) {
    ctx.assertPermission(Permissions.POS_REFUND);
    const body = validate(SaleExchangeSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) {
      throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    }
    const rawDb = database.getRawDatabase();
    const openShift = rawDb.prepare(
      "SELECT id, store_id FROM cashier_shifts WHERE tenant_id = ? AND user_id = ? AND status = 'OPEN' LIMIT 1"
    ).get(ctx.tenantId, ctx.userId);
    if (!openShift) {
      throw Object.assign(new Error('يجب بدء الشيفت أولاً قبل إجراء الاستبدال'), { status: 403 });
    }
    if (openShift.store_id !== body.storeId) {
      throw Object.assign(new Error('الشيفت المفتوح مسجل على فرع آخر'), { status: 403 });
    }

    const originalSaleId = exchangeMatch[1];
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });

    const returnIdempotencyKey = `exchange-ret:${body.idempotencyKey}`;
    const saleIdempotencyKey = `exchange-sale:${body.idempotencyKey}`;
    const now = new Date();

    const exchangeResult = await db.transaction().execute(async (trx) => {
      const existingSale = await trx
        .selectFrom('sales')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', saleIdempotencyKey)
        .executeTakeFirst();
      const existingRet = await trx
        .selectFrom('customer_returns')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', returnIdempotencyKey)
        .executeTakeFirst();
      if (existingSale && existingRet) {
        const retAmt = BigInt(existingRet.refund_amount);
        const repTotal = BigInt(existingSale.total);
        const netDiff = repTotal - retAmt;
        return {
          replay: true,
          returnId: existingRet.id,
          returnNumber: existingRet.return_number,
          saleId: existingSale.id,
          saleNumber: existingSale.sale_number,
          returnedAmount: retAmt.toString(),
          replacementTotal: repTotal.toString(),
          netDifference: netDiff.toString(),
          direction: netDiff > 0n ? 'CUSTOMER_PAYS' : netDiff < 0n ? 'STORE_REFUNDS' : 'EVEN',
        };
      }
      if (existingSale || existingRet) {
        throw Object.assign(new Error('مفتاح الاستبدال مستخدم جزئيًا في عملية أخرى'), { status: 409 });
      }

      const originalSale = await trx
        .selectFrom('sales')
        .select(['id', 'sale_number', 'customer_name', 'total'])
        .where('id', '=', originalSaleId)
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', body.storeId)
        .executeTakeFirst();
      if (!originalSale || BigInt(originalSale.total) <= 0n) {
        throw Object.assign(new Error('الفاتورة الأصلية غير متاحة للاستبدال'), { status: 404 });
      }

      if (new Set(body.returnedItems.map((line) => line.originalSaleItemId)).size !== body.returnedItems.length) {
        throw Object.assign(new Error('لا تكرر نفس بند الفاتورة في الاستبدال'), { status: 400 });
      }

      let returnedCreditMinor = 0n;
      const returnLines = [];
      for (const reqLine of body.returnedItems) {
        const reqQty = BigInt(reqLine.quantity);
        const originalItem = await trx
          .selectFrom('sale_items')
          .select(['id', 'quantity', 'item_type', 'net_revenue'])
          .where('id', '=', reqLine.originalSaleItemId)
          .where('sale_id', '=', originalSaleId)
          .where('tenant_id', '=', ctx.tenantId)
          .executeTakeFirst();
        if (!originalItem || originalItem.item_type !== 'SALE') {
          throw Object.assign(new Error('الصنف المختار للاستبدال غير موجود في الفاتورة'), { status: 400 });
        }
        const previousReturns = await trx
          .selectFrom('customer_return_items')
          .innerJoin('customer_returns', 'customer_returns.id', 'customer_return_items.return_id')
          .select(['customer_return_items.quantity as quantity', 'customer_return_items.refund_amount as amount'])
          .where('customer_returns.original_sale_id', '=', originalSaleId)
          .where('customer_return_items.original_sale_item_id', '=', originalItem.id)
          .execute();
        const soldQty = BigInt(originalItem.quantity);
        const returnedQty = previousReturns.reduce((s, r) => s + BigInt(r.quantity), 0n);
        const remainingQty = soldQty - returnedQty;
        if (reqQty > remainingQty) {
          throw Object.assign(new Error('كمية الاستبدال أكبر من الكمية المتبقية من الفاتورة'), { status: 400 });
        }
        const alreadyRefunded = previousReturns.reduce((s, r) => s + BigInt(r.amount), 0n);
        const origNet = BigInt(originalItem.net_revenue);
        const credit = reqQty === remainingQty ? origNet - alreadyRefunded : (origNet * reqQty) / soldQty;
        if (credit <= 0n) {
          throw Object.assign(new Error('قيمة الصنف لا تسمح بالاستبدال'), { status: 400 });
        }
        returnedCreditMinor += credit;
        returnLines.push({ originalSaleItemId: originalItem.id, quantity: reqQty });
      }

      let replacementCart = Cart.empty(tenant.currency);
      const draftItems = [];
      const replacementSaleId = randomUUID();
      for (const [index, repItem] of body.replacementItems.entries()) {
        const variantRow = await trx
          .selectFrom('product_variants as pv')
          .innerJoin('products as p', (join) =>
            join.onRef('p.id', '=', 'pv.product_id').onRef('p.tenant_id', '=', 'pv.tenant_id'),
          )
          .select([
            'pv.id as id',
            'pv.product_id as productId',
            'pv.sku as sku',
            'pv.retail_price as retailPrice',
            'pv.currency as currency',
            'pv.attributes_json as attributesJson',
            'pv.is_active as variantActive',
            'p.name as productName',
            'p.options_json as optionsJson',
            'p.item_kind as itemKind',
            'p.is_active as productActive',
          ])
          .where('pv.tenant_id', '=', ctx.tenantId)
          .where('pv.id', '=', repItem.variantId)
          .executeTakeFirst();
        if (!variantRow || !variantRow.variantActive || !variantRow.productActive) {
          throw Object.assign(new Error('الصنف البديل المختار غير نشط أو غير متاح'), { status: 400 });
        }
        const unitPriceMinor = BigInt(variantRow.retailPrice ?? 0);
        if (unitPriceMinor <= 0n) {
          throw Object.assign(new Error(`الصنف البديل "${variantRow.productName}" لم يُسعّر للبيع بعد`), { status: 400 });
        }
        const unitPriceMoney = Money.fromMinor(unitPriceMinor, tenant.currency);
        const attrs = variantRow.attributesJson ? JSON.parse(variantRow.attributesJson) : {};
        const options = variantRow.optionsJson ? JSON.parse(variantRow.optionsJson) : [];
        const optionLabel = Object.entries(attrs)
          .map(([k, v]) => `${options.find((o) => o.key === k)?.name ?? k}: ${String(v)}`)
          .join(' - ');
        const productName = optionLabel ? `${variantRow.productName} - ${optionLabel}` : variantRow.productName;
        const qtyBig = BigInt(repItem.quantity);
        const lineId = `ex-line-${index}-${randomUUID()}`;
        replacementCart = replacementCart.addItem({
          lineId,
          variantId: variantRow.id,
          productId: variantRow.productId,
          productName,
          sku: variantRow.sku,
          unitPrice: unitPriceMoney,
          quantity: qtyBig,
        });
        draftItems.push({
          id: `${replacementSaleId}:item:${index}`,
          variantId: variantRow.id,
          productId: variantRow.productId,
          productName,
          sku: variantRow.sku,
          variantAttributes: attrs,
          type: 'SALE',
          quantity: qtyBig,
          unitPrice: unitPriceMoney,
          lineDiscount: Money.zero(tenant.currency),
          cartDiscountShare: Money.zero(tenant.currency),
          stockTracked: variantRow.itemKind === 'PRODUCT',
        });
      }

      const replacementTotalMinor = replacementCart.total.amount;
      const netDifferenceMinor = replacementTotalMinor - returnedCreditMinor;

      // Net accounting & drawer delta:
      // - If customer pays extra or even swap (>= 0): offset the returned credit via 'OTHER'
      //   so cash drawer (1010) and current shift only receive the net price difference.
      // - If store refunds difference (< 0): record both return and replacement using the refund
      //   channel so the net drawer/electronic outflow equals the refunded difference cleanly.
      const returnPaymentMethod = netDifferenceMinor >= 0n ? 'OTHER' : body.paymentMethod;
      const paymentTenders = netDifferenceMinor > 0n
        ? [
            { method: 'OTHER', amount: Money.fromMinor(returnedCreditMinor, tenant.currency) },
            { method: body.paymentMethod, amount: Money.fromMinor(netDifferenceMinor, tenant.currency) },
          ]
        : netDifferenceMinor === 0n
          ? [{ method: 'OTHER', amount: Money.fromMinor(replacementTotalMinor, tenant.currency) }]
          : [{ method: body.paymentMethod, amount: Money.fromMinor(replacementTotalMinor, tenant.currency) }];

      const returnNumber = await generateNextReturnNumber(ctx.tenantId, trx);
      const returnRes = await returns.recordInTransaction(trx, ctx, {
        id: randomUUID(),
        returnNumber,
        idempotencyKey: returnIdempotencyKey,
        storeId: body.storeId,
        originalSaleId,
        paymentMethod: returnPaymentMethod,
        occurredAt: now,
        lines: returnLines,
        isExchange: true,
      });

      const saleNumber = await generateNextSaleNumber(ctx.tenantId, trx);
      const saleDraft = {
        id: replacementSaleId,
        tenantId: ctx.tenantId,
        storeId: body.storeId,
        saleNumber,
        idempotencyKey: saleIdempotencyKey,
        cashierUserId: ctx.userId,
        customerName: originalSale.customer_name ?? undefined,
        currency: tenant.currency,
        items: draftItems,
        payments: paymentTenders.map(
          (tender, pIdx) => new SalePayment(`${replacementSaleId}:payment:${pIdx}`, tender),
        ),
        subtotal: replacementCart.grossSubtotal,
        discountTotal: replacementCart.discountTotal,
        total: replacementCart.total,
        createdAt: now,
      };
      const replacementSale = await saleRepo.persistCheckoutInTransaction(trx, ctx, saleDraft, {
        allowNegativeStock: tenant.allowNegativeStock,
      });

      return {
        replay: false,
        originalSaleNumber: originalSale.sale_number,
        returnId: returnRes.id,
        returnNumber,
        saleId: replacementSale.id,
        saleNumber: replacementSale.saleNumber,
        returnedAmount: returnRes.refundAmount.toString(),
        replacementTotal: replacementSale.total.amount.toString(),
        netDifference: netDifferenceMinor.toString(),
        direction: netDifferenceMinor > 0n ? 'CUSTOMER_PAYS' : netDifferenceMinor < 0n ? 'STORE_REFUNDS' : 'EVEN',
      };
    });

    if (!exchangeResult.replay) {
      await recordAudit(ctx, {
        storeId: body.storeId,
        action: 'SALE_EXCHANGED',
        entityType: 'SALE',
        entityId: exchangeResult.saleId,
        summary: `استبدال من فاتورة (${exchangeResult.originalSaleNumber}) إلى (${exchangeResult.saleNumber}) بفارق ${exchangeResult.netDifference}`,
        metadata: {
          originalSaleId,
          returnId: exchangeResult.returnId,
          returnNumber: exchangeResult.returnNumber,
          replacementSaleNumber: exchangeResult.saleNumber,
          returnedAmount: exchangeResult.returnedAmount,
          replacementTotal: exchangeResult.replacementTotal,
          netDifference: exchangeResult.netDifference,
          paymentMethod: body.paymentMethod,
          notes: body.notes ?? '',
        },
      });
    }

    return json(res, exchangeResult.replay ? 200 : 201, {
      returnId: exchangeResult.returnId,
      returnNumber: exchangeResult.returnNumber,
      saleId: exchangeResult.saleId,
      saleNumber: exchangeResult.saleNumber,
      returnedAmount: exchangeResult.returnedAmount,
      replacementTotal: exchangeResult.replacementTotal,
      netDifference: exchangeResult.netDifference,
      direction: exchangeResult.direction,
    });
  }

  if (method === 'POST' && path === '/api/purchases') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(PurchaseSchema, await readJson(req));
    for (const np of body.newProducts) {
      assertVariantOptions(np.options, np.variants);
    }
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const explicitInvoiceNumber = body.invoiceNumber?.trim() || undefined;
    let hasAnyRetailPrice = false;
    let computedRetailTotalMinor = 0n;
    const lines = body.items.map((line) => {
      const qty = BigInt(line.quantity);
      const hasRetail = line.retailPrice !== undefined && line.retailPrice !== null;
      if (hasRetail) {
        hasAnyRetailPrice = true;
        computedRetailTotalMinor += BigInt(line.retailPrice) * qty;
      }
      return {
        variantId: line.variantId,
        quantity: qty,
        unitCost: Money.fromMinor(BigInt(line.unitCost), tenant.currency),
        ...(hasRetail ? { retailPrice: Money.fromMinor(BigInt(line.retailPrice), tenant.currency) } : {}),
      };
    });
    const newProducts = body.newProducts.map((np) => ({
      id: randomUUID(),
      name: np.name,
      sku: np.sku,
      ...(np.barcode ? { barcode: np.barcode } : {}),
      ...(np.categoryId ? { categoryId: np.categoryId } : {}),
      ...(np.brand ? { brand: np.brand } : {}),
      ...(np.description ? { description: np.description } : {}),
      ...(np.imagePath ? { imagePath: np.imagePath } : {}),
      options: np.options,
      variants: np.variants.map((variant) => {
        const qty = BigInt(variant.quantity);
        const hasRetail = variant.retailPrice !== undefined && variant.retailPrice !== null;
        if (hasRetail && qty > 0n) {
          hasAnyRetailPrice = true;
          computedRetailTotalMinor += BigInt(variant.retailPrice) * qty;
        }
        return {
          id: randomUUID(),
          sku: variant.sku,
          ...(variant.barcode ? { barcode: variant.barcode } : {}),
          attributes: variant.attributes ?? {},
          quantity: qty,
          unitCost: Money.fromMinor(BigInt(variant.unitCost), tenant.currency),
          ...(hasRetail ? { retailPrice: Money.fromMinor(BigInt(variant.retailPrice), tenant.currency) } : {}),
          reorderPoint: BigInt(variant.reorderPoint ?? '0'),
        };
      }),
    }));
    const expectedRetailTotal = hasAnyRetailPrice ? Money.fromMinor(computedRetailTotalMinor, tenant.currency) : undefined;
    const savedId = await purchasing.recordPurchase(ctx, {
      id, idempotencyKey: body.idempotencyKey, storeId: body.storeId, supplierId: body.supplierId,
      ...(explicitInvoiceNumber ? { invoiceNumber: explicitInvoiceNumber } : { autoGenerateInvoiceNumber: true }),
      totalAmount: Money.fromMinor(BigInt(body.totalAmount), tenant.currency),
      initialPayment: Money.fromMinor(BigInt(body.paidAmount), tenant.currency),
      paymentMethod: body.paymentMethod,
      targetProfitPercent: body.targetProfitPercent ?? null,
      expectedRetailTotal,
      referenceNumber: body.referenceNumber,
      notes: body.notes, purchasedAt: new Date(),
      lines,
      ...(newProducts.length > 0 ? { newProducts } : {}),
    });
    if (savedId === id) {
      const savedPurchase = await db.selectFrom('supplier_purchases').select('invoice_number').where('id', '=', savedId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      const recordedInvoice = savedPurchase?.invoice_number ?? explicitInvoiceNumber ?? savedId.slice(0, 8);
      await recordAudit(ctx, { storeId: body.storeId, action: 'PURCHASE_RECORDED', entityType: 'PURCHASE', entityId: savedId, summary: `تسجيل فاتورة شراء (${recordedInvoice})`, metadata: { invoiceNumber: recordedInvoice, totalAmount: body.totalAmount, paidAmount: body.paidAmount, targetProfitPercent: body.targetProfitPercent ?? null, expectedRetailTotal: expectedRetailTotal?.amount.toString() ?? null, newProductsCount: newProducts.length } });
    }
    return json(res, 201, { id: savedId });
  }

  const supplierReturnMatch = method === 'POST' ? path.match(/^\/api\/purchases\/([0-9a-f-]+)\/returns$/i) : null;
  if (supplierReturnMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(SupplierReturnSchema, await readJson(req));
    const result = await supplierReturnsRepo.record(ctx, { id: randomUUID(), idempotencyKey: body.idempotencyKey,
      purchaseId: supplierReturnMatch[1], storeId: body.storeId, occurredAt: new Date(),
      lines: body.items.map((item) => ({ purchaseItemId: item.purchaseItemId, quantity: BigInt(item.quantity) })) });
    await recordAudit(ctx, { storeId: body.storeId, action: 'SUPPLIER_RETURN_RECORDED', entityType: 'SUPPLIER_RETURN', entityId: result.id, summary: `تسجيل مرتجع للمورد بقيمة ائتمانية (${result.creditAmount.toString()})`, metadata: { purchaseId: supplierReturnMatch[1], creditAmount: result.creditAmount.toString() } });
    return json(res, 201, { id: result.id, creditAmount: result.creditAmount.toString() });
  }

  const purchasePatchMatch = method === 'PATCH' ? path.match(/^\/api\/purchases\/([0-9a-f-]+)$/i) : null;
  if (purchasePatchMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const purchaseId = purchasePatchMatch[1];
    const body = validate(UpdatePurchaseMetaSchema, await readJson(req));
    const existing = await db.selectFrom('supplier_purchases').select(['id', 'store_id', 'invoice_number', 'notes', 'target_profit_percent']).where('tenant_id', '=', ctx.tenantId).where('id', '=', purchaseId).executeTakeFirst();
    if (!existing || (ctx.storeId && ctx.storeId !== existing.store_id)) {
      throw Object.assign(new Error('فاتورة الشراء غير متاحة'), { status: 404 });
    }
    const nextInvoice = body.invoiceNumber === undefined ? existing.invoice_number : (body.invoiceNumber || null);
    const nextNotes = body.notes === undefined ? existing.notes : (body.notes || null);
    const nextTarget = body.targetProfitPercent === undefined ? existing.target_profit_percent : body.targetProfitPercent;
    await db.updateTable('supplier_purchases').set({ invoice_number: nextInvoice, notes: nextNotes, target_profit_percent: nextTarget }).where('tenant_id', '=', ctx.tenantId).where('id', '=', purchaseId).execute();
    await recordAudit(ctx, { storeId: existing.store_id, action: 'PURCHASE_UPDATED', entityType: 'PURCHASE', entityId: purchaseId, summary: `تعديل بيانات فاتورة الشراء (${nextInvoice ?? purchaseId.slice(0, 8)})`, metadata: { oldInvoiceNumber: existing.invoice_number, newInvoiceNumber: nextInvoice, notes: nextNotes, targetProfitPercent: nextTarget } });
    return json(res, 200, { id: purchaseId, updated: true });
  }

  const paymentMutationMatch = (method === 'PATCH' || method === 'DELETE') ? path.match(/^\/api\/purchases\/([0-9a-f-]+)\/payments\/([^/]+)$/i) : null;
  if (paymentMutationMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    if (!['OWNER', 'STORE_MANAGER'].includes(ctx.roleId)) {
      throw Object.assign(new Error('غير مصرح بتعديل أو إلغاء دفعات التجار'), { status: 403 });
    }
    const purchaseId = paymentMutationMatch[1];
    const paymentId = decodeURIComponent(paymentMutationMatch[2]);
    if (method === 'PATCH') {
      const body = validate(SupplierPaymentSchema, await readJson(req));
      const tenant = await tenantRepo.findById(ctx.tenantId);
      if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
      const updated = await purchasing.updateSupplierPayment(ctx, {
        idempotencyKey: body.idempotencyKey,
        purchaseId,
        paymentId,
        amount: Money.fromMinor(BigInt(body.amount), tenant.currency),
        paymentMethod: body.paymentMethod,
        referenceNumber: body.referenceNumber,
        updatedAt: new Date(),
      });
      await recordAudit(ctx, {
        storeId: updated.storeId,
        action: 'SUPPLIER_PAYMENT_UPDATED',
        entityType: 'SUPPLIER_PAYMENT',
        entityId: updated.id,
        summary: `تعديل دفعة سداد لتاجر من ${updated.oldAmount.toString()} إلى ${updated.newAmount.toString()}`,
        metadata: {
          purchaseId,
          oldAmount: updated.oldAmount.toString(),
          newAmount: updated.newAmount.toString(),
          oldMethod: updated.oldMethod,
          newMethod: updated.newMethod,
        },
      });
      return json(res, 200, { id: updated.id, updated: true });
    }
    const body = validate(z.object({ idempotencyKey: z.string().uuid().optional() }), await readJson(req));
    const deleted = await purchasing.deleteSupplierPayment(ctx, {
      idempotencyKey: body.idempotencyKey ?? randomUUID(),
      purchaseId,
      paymentId,
      deletedAt: new Date(),
    });
    await recordAudit(ctx, {
      storeId: deleted.storeId,
      action: 'SUPPLIER_PAYMENT_DELETED',
      entityType: 'SUPPLIER_PAYMENT',
      entityId: deleted.id,
      summary: `إلغاء وعكس دفعة سداد لتاجر بقيمة ${deleted.deletedAmount.toString()}`,
      metadata: { purchaseId, deletedAmount: deleted.deletedAmount.toString(), paymentMethod: deleted.paymentMethod },
    });
    return json(res, 200, { id: deleted.id, deleted: true });
  }

  const paymentMatch = method === 'POST' ? path.match(/^\/api\/purchases\/([0-9a-f-]+)\/payments$/i) : null;
  if (paymentMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(SupplierPaymentSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const savedId = await purchasing.recordSupplierPayment(ctx, {
      id, idempotencyKey: body.idempotencyKey, purchaseId: paymentMatch[1],
      amount: Money.fromMinor(BigInt(body.amount), tenant.currency),
      paymentMethod: body.paymentMethod, referenceNumber: body.referenceNumber, paidAt: new Date(),
    });
    if (savedId === id) {
      await recordAudit(ctx, { action: 'SUPPLIER_PAYMENT_RECORDED', entityType: 'SUPPLIER_PAYMENT', entityId: savedId, summary: `تسجيل دفعة لمورد (${body.amount})`, metadata: { purchaseId: paymentMatch[1], amount: body.amount, paymentMethod: body.paymentMethod } });
    }
    return json(res, 201, { id: savedId });
  }

  const supplierRefundMatch = method === 'POST' ? path.match(/^\/api\/suppliers\/([0-9a-f-]+)\/refunds$/i) : null;
  if (supplierRefundMatch) {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const supplierId = supplierRefundMatch[1];
    const body = validate(SupplierRefundSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const refundAmount = BigInt(body.amount);
    const cashAccountCode = body.paymentMethod === 'CASH' ? '1010' : body.paymentMethod === 'CASH_SAFE' ? '1015' : '1020';

    const result = await db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('supplier_refunds').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', body.idempotencyKey).executeTakeFirst();
      if (replay) {
        if (replay.supplier_id !== supplierId || replay.store_id !== body.storeId || BigInt(replay.amount) !== refundAmount || replay.payment_method !== body.paymentMethod) {
          throw Object.assign(new Error('مفتاح العملية مستخدم لحركة استرداد مختلفة'), { status: 409 });
        }
        return { id: replay.id, amount: BigInt(replay.amount), isReplay: true };
      }

      const supplier = await trx.selectFrom('suppliers').select(['id', 'name']).where('id', '=', supplierId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      const store = await trx.selectFrom('stores').select('id').where('id', '=', body.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!supplier || !store) throw Object.assign(new Error('التاجر أو الفرع غير متاح'), { status: 404 });

      const purchasesForSup = await trx.selectFrom('supplier_purchases').select(['id', 'idempotency_key', 'total_amount', 'initial_paid_amount'])
        .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', body.storeId).where('supplier_id', '=', supplierId).execute();
      const purchaseIds = purchasesForSup.map((p) => p.id);
      const paymentsByPurchase = new Map();
      let totalBilled = 0n;
      let totalPaid = 0n;
      let totalReturned = 0n;
      if (purchaseIds.length > 0) {
        const payRows = await trx.selectFrom('supplier_payments').select(['id', 'purchase_id', 'idempotency_key', 'amount', 'deleted_at']).where('tenant_id', '=', ctx.tenantId).where('purchase_id', 'in', purchaseIds).execute();
        for (const row of payRows) {
          if (!row.deleted_at) totalPaid += BigInt(row.amount);
          const bucket = paymentsByPurchase.get(row.purchase_id) ?? [];
          bucket.push(row);
          paymentsByPurchase.set(row.purchase_id, bucket);
        }
        const retRows = await trx.selectFrom('supplier_returns').select('credit_amount').where('tenant_id', '=', ctx.tenantId).where('purchase_id', 'in', purchaseIds).execute();
        for (const row of retRows) totalReturned += BigInt(row.credit_amount);
      }
      for (const p of purchasesForSup) {
        totalBilled += BigInt(p.total_amount);
        totalPaid += effectiveLegacyInitialPaid(p, paymentsByPurchase.get(p.id) ?? []);
      }
      const priorRefundRows = await trx.selectFrom('supplier_refunds').select('amount')
        .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', body.storeId).where('supplier_id', '=', supplierId).execute();
      let priorRefunded = 0n;
      for (const row of priorRefundRows) priorRefunded += BigInt(row.amount);

      const netDue = totalBilled - totalPaid - totalReturned + priorRefunded;
      const creditAvailable = netDue < 0n ? -netDue : 0n;
      if (creditAvailable <= 0n) throw Object.assign(new Error('لا يوجد رصيد دائن لصالح المتجر عند هذا التاجر'), { status: 400 });
      if (refundAmount > creditAvailable) throw Object.assign(new Error('المبلغ المطلوب أكبر من الرصيد المستحق لنا عند التاجر'), { status: 400 });

      const refundId = randomUUID();
      const now = new Date();
      const journalKey = `supplier-refund:${body.idempotencyKey}`;
      await postJournalEntry(trx, ctx, {
        storeId: body.storeId,
        currency: tenant.currency,
        date: now,
        sourceType: 'SUPPLIER_REFUND',
        sourceId: refundId,
        idempotencyKey: journalKey,
        description: `استرداد نقدي من التاجر ${supplier.name}`,
        lines: [
          { accountCode: cashAccountCode, side: 'DEBIT', amount: refundAmount, memo: 'تحصيل رصيد مرتجع من التاجر' },
          { accountCode: '2010', side: 'CREDIT', amount: refundAmount, memo: 'تسوية الرصيد الدائن لدى التاجر' },
        ],
      });
      const journalEntry = await trx.selectFrom('journal_entries').select('id').where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalKey).executeTakeFirstOrThrow();

      await trx.insertInto('supplier_refunds').values({
        id: refundId,
        tenant_id: ctx.tenantId,
        store_id: body.storeId,
        supplier_id: supplierId,
        idempotency_key: body.idempotencyKey,
        amount: refundAmount,
        currency: tenant.currency,
        payment_method: body.paymentMethod,
        reference_number: body.referenceNumber ?? null,
        notes: body.notes ?? null,
        journal_entry_id: journalEntry.id,
        refunded_at: now.toISOString(),
        created_by_user_id: ctx.userId,
      }).execute();

      return { id: refundId, amount: refundAmount, isReplay: false, remainingCredit: creditAvailable - refundAmount };
    });

    if (!result.isReplay) {
      await recordAudit(ctx, {
        storeId: body.storeId,
        action: 'SUPPLIER_REFUND_RECEIVED',
        entityType: 'SUPPLIER_REFUND',
        entityId: result.id,
        summary: `استلام مبلغ مسترد من تاجر (${body.amount})`,
        metadata: { supplierId, amount: body.amount, paymentMethod: body.paymentMethod },
      });
    }
    return json(res, 201, { id: result.id, amount: result.amount.toString(), remainingCredit: (result.remainingCredit ?? 0n).toString() });
  }

  if (method === 'POST' && (path === '/api/inventory/receive' || path === '/api/inventory/receive-batch')) {
    ctx.assertPermission(Permissions.INVENTORY_RECEIVE);
    throw Object.assign(new Error('إضافة البضاعة تتم من فاتورة الشراء فقط حتى يتحدث المخزون وحساب التاجر معًا'), { status: 410 });
  }

  if (method === 'POST' && path === '/api/stores') {
    ctx.assertPermission(Permissions.STORES_MANAGE);
    const body = validate(CreateStoreSchema, await readJson(req));
    try {
      const created = await tenantService.createStore(ctx, {
        id: randomUUID(),
        name: body.name,
        code: body.code.toUpperCase(),
        address: body.address || undefined,
        phone: body.phone || undefined,
      });
      await recordAudit(ctx, { storeId: null, action: 'STORE_CREATED', entityType: 'STORE', entityId: created.id, summary: `إضافة فرع جديد (${created.name} - ${created.code})`, metadata: { name: created.name, code: created.code } });
      return json(res, 201, { id: created.id, name: created.name, code: created.code });
    } catch (error) {
      if (error?.message?.startsWith('StoreError:')) throw Object.assign(new Error('كود الفرع مستخدم بالفعل'), { status: 409 });
      throw error;
    }
  }

  if (method === 'POST' && path === '/api/inventory/transfer') {
    ctx.assertPermission(Permissions.INVENTORY_TRANSFER);
    const body = validate(InventoryTransferSchema, await readJson(req));
    const transferId = randomUUID();
    const result = await inventory.transferStock(ctx, {
      id: transferId,
      fromStoreId: body.fromStoreId,
      toStoreId: body.toStoreId,
      variantId: body.variantId,
      quantity: BigInt(body.quantity),
    });
    await recordAudit(ctx, { storeId: body.fromStoreId, action: 'INVENTORY_TRANSFERRED', entityType: 'INVENTORY_TRANSFER', entityId: transferId, summary: `تحويل مخزني بين الفروع بكمية (${body.quantity})`, metadata: { fromStoreId: body.fromStoreId, toStoreId: body.toStoreId, variantId: body.variantId, quantity: body.quantity } });
    return json(res, 201, { id: transferId, transferred: true, quantity: body.quantity, outMovementId: result.out.movementId, inMovementId: result.in.movementId });
  }

  if (method === 'POST' && path === '/api/inventory/damage') {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const body = validate(InventoryDamageSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const variant = await variantRepo.findById(ctx, body.variantId);
    if (!variant) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });
    const qty = BigInt(body.quantity);
    const movementId = randomUUID();
    const damageResult = await db.transaction().execute(async (trx) => {
      const movement = await applyStockMovementInTransaction(trx, ctx, {
        id: movementId,
        storeId: body.storeId,
        variantId: variant.id,
        currency: tenant.currency,
        movementType: 'DAMAGE_WRITE_OFF',
        quantityDelta: -qty,
        sourceType: 'DAMAGE',
        sourceId: body.idempotencyKey,
        allowNegativeStock: tenant.allowNegativeStock,
      });
      const totalLossMinor = movement.unitCost.amount * qty;
      if (totalLossMinor > 0n) {
        await postJournalEntry(trx, ctx, {
          storeId: body.storeId,
          currency: tenant.currency,
          date: new Date(),
          sourceType: 'ADJUSTMENT',
          sourceId: movement.id,
          idempotencyKey: `inventory-damage:${body.idempotencyKey}`,
          description: `إعدام بضاعة تالفة (${variant.sku})${body.reason ? ` - ${body.reason}` : ''}`,
          lines: [
            { accountCode: '5090', side: 'DEBIT', amount: totalLossMinor, memo: 'خسائر وتوالف مخزون بالتكلفة المرجحة' },
            { accountCode: '1300', side: 'CREDIT', amount: totalLossMinor, memo: 'تخفيض قيمة المخزون بالتالف' },
          ],
        });
      }
      return { movement, totalLossMinor };
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'INVENTORY_DAMAGE_RECORDED', entityType: 'STOCK_MOVEMENT', entityId: damageResult.movement.id, summary: `تسجيل تالف مخزني (${variant.sku} - كمية ${body.quantity})`, metadata: { variantId: variant.id, sku: variant.sku, quantity: body.quantity, lossAmount: damageResult.totalLossMinor.toString(), reason: body.reason ?? '' } });
    return json(res, 201, {
      id: damageResult.movement.id,
      resultingQuantity: damageResult.movement.resultingQuantity.toString(),
      lossAmount: moneyJson(Money.fromMinor(damageResult.totalLossMinor, tenant.currency)),
    });
  }

  if (method === 'POST' && path === '/api/inventory/adjust') {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const body = validate(InventoryAdjustSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const variant = await variantRepo.findById(ctx, body.variantId);
    if (!variant) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });
    const targetQty = BigInt(body.targetQuantity);
    const currentPos = await inventoryRepo.getPosition(ctx, body.storeId, variant.id);
    const currentQty = currentPos?.quantityOnHand ?? 0n;
    const delta = targetQty - currentQty;
    if (delta === 0n) throw Object.assign(new Error('الكمية الفعلية مطابقة للرصيد الحالي ولا تحتاج تسوية'), { status: 400 });
    const unitCostMoney = delta > 0n
      ? Money.fromMinor(BigInt(body.unitCost ?? (currentPos?.wacCost.amount ?? 0n).toString()), tenant.currency)
      : undefined;
    if (delta > 0n && (!unitCostMoney || unitCostMoney.amount <= 0n)) {
      throw Object.assign(new Error('الزيادة المخزنية تتطلب تحديد تكلفة الوحدة'), { status: 400 });
    }
    const movementId = randomUUID();
    const adjustResult = await db.transaction().execute(async (trx) => {
      const movement = await applyStockMovementInTransaction(trx, ctx, {
        id: movementId,
        storeId: body.storeId,
        variantId: variant.id,
        currency: tenant.currency,
        movementType: 'INVENTORY_ADJUSTMENT',
        quantityDelta: delta,
        unitCost: unitCostMoney,
        sourceType: 'ADJUSTMENT',
        sourceId: body.idempotencyKey,
        allowNegativeStock: tenant.allowNegativeStock,
      });
      const absQty = delta > 0n ? delta : -delta;
      const valuationDelta = movement.unitCost.amount * absQty;
      if (valuationDelta > 0n) {
        await postJournalEntry(trx, ctx, {
          storeId: body.storeId,
          currency: tenant.currency,
          date: new Date(),
          sourceType: 'ADJUSTMENT',
          sourceId: movement.id,
          idempotencyKey: `inventory-adjust:${body.idempotencyKey}`,
          description: `تسوية جرد مخزني (${variant.sku})${body.reason ? ` - ${body.reason}` : ''}`,
          lines: delta > 0n
            ? [
                { accountCode: '1300', side: 'DEBIT', amount: valuationDelta, memo: 'زيادة رصيد المخزون نتيجة جرد فعلي' },
                { accountCode: '5090', side: 'CREDIT', amount: valuationDelta, memo: 'فروق جرد مخزني موجبة' },
              ]
            : [
                { accountCode: '5090', side: 'DEBIT', amount: valuationDelta, memo: 'عجز جرد مخزني بالتكلفة المرجحة' },
                { accountCode: '1300', side: 'CREDIT', amount: valuationDelta, memo: 'تخفيض رصيد المخزون نتيجة جرد فعلي' },
              ],
        });
      }
      return { movement, delta, valuationDelta };
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'INVENTORY_ADJUSTED', entityType: 'STOCK_MOVEMENT', entityId: adjustResult.movement.id, summary: `تسوية جرد مخزني (${variant.sku}) من ${currentQty} إلى ${targetQty}`, metadata: { variantId: variant.id, sku: variant.sku, previousQuantity: currentQty.toString(), targetQuantity: targetQty.toString(), delta: delta.toString(), reason: body.reason ?? '' } });
    return json(res, 201, {
      id: adjustResult.movement.id,
      previousQuantity: currentQty.toString(),
      resultingQuantity: adjustResult.movement.resultingQuantity.toString(),
      delta: delta.toString(),
    });
  }

  if (method === 'POST' && path === '/api/accounting/treasury-transfer') {
    ctx.assertPermission(Permissions.POS_DRAWER_OPEN);
    const body = validate(TreasuryTransferSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    if (body.fromAccount === body.toAccount) throw Object.assign(new Error('لا يمكن التحويل لنفس الحساب'), { status: 400 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const amountMinor = BigInt(body.amount);
    const accountLabels = { '1010': 'درج النقدية', '1015': 'الخزينة الرئيسية', '1020': 'البنك والتحصيل الإلكتروني' };
    await db.transaction().execute(async (trx) => {
      await postJournalEntry(trx, ctx, {
        storeId: body.storeId,
        currency: tenant.currency,
        date: new Date(),
        sourceType: 'TRANSFER',
        sourceId: body.idempotencyKey,
        idempotencyKey: `treasury-transfer:${body.idempotencyKey}`,
        description: `تحويل نقدية من ${accountLabels[body.fromAccount]} إلى ${accountLabels[body.toAccount]}${body.notes ? ` (${body.notes})` : ''}`,
        lines: [
          { accountCode: body.toAccount, side: 'DEBIT', amount: amountMinor, memo: `استلام تحويل من ${accountLabels[body.fromAccount]}` },
          { accountCode: body.fromAccount, side: 'CREDIT', amount: amountMinor, memo: `صرف تحويل إلى ${accountLabels[body.toAccount]}` },
        ],
      });
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'TREASURY_TRANSFERRED', entityType: 'TREASURY', entityId: body.idempotencyKey, summary: `تحويل مالي من ${accountLabels[body.fromAccount]} إلى ${accountLabels[body.toAccount]} بقيمة (${body.amount})`, metadata: { fromAccount: body.fromAccount, toAccount: body.toAccount, amount: body.amount, notes: body.notes ?? '' } });
    return json(res, 201, {
      transferred: true,
      fromAccount: body.fromAccount,
      toAccount: body.toAccount,
      amount: moneyJson(Money.fromMinor(amountMinor, tenant.currency)),
    });
  }

  if (method === 'POST' && path === '/api/accounting/shift-close') {
    ctx.assertPermission(Permissions.POS_DRAWER_OPEN);
    const body = validate(ShiftCloseSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const actualMinor = BigInt(body.actualCashAmount);
    const shiftResult = await db.transaction().execute(async (trx) => {
      const bookMinor = await computeDrawerBookBalanceMinor(trx, ctx.tenantId, body.storeId);
      const varianceMinor = actualMinor - bookMinor;
      const status = varianceMinor === 0n ? 'BALANCED' : varianceMinor < 0n ? 'SHORTAGE' : 'OVERAGE';
      const now = new Date();
      if (varianceMinor < 0n) {
        const shortageAmount = -varianceMinor;
        await postJournalEntry(trx, ctx, {
          storeId: body.storeId,
          currency: tenant.currency,
          date: now,
          sourceType: 'SESSION_CLOSING',
          sourceId: body.idempotencyKey,
          idempotencyKey: `shift-close:${body.idempotencyKey}`,
          description: `تسوية عجز درج النقدية${body.notes ? ` (${body.notes})` : ''}`,
          lines: [
            { accountCode: '6090', side: 'DEBIT', amount: shortageAmount, memo: 'عجز جرد درج النقدية عند تقفيل الشيفت' },
            { accountCode: '1010', side: 'CREDIT', amount: shortageAmount, memo: 'تخفيض درج النقدية بقيمة العجز الفعلي' },
          ],
        });
      } else if (varianceMinor > 0n) {
        await postJournalEntry(trx, ctx, {
          storeId: body.storeId,
          currency: tenant.currency,
          date: now,
          sourceType: 'SESSION_CLOSING',
          sourceId: body.idempotencyKey,
          idempotencyKey: `shift-close:${body.idempotencyKey}`,
          description: `تسوية فائض درج النقدية${body.notes ? ` (${body.notes})` : ''}`,
          lines: [
            { accountCode: '1010', side: 'DEBIT', amount: varianceMinor, memo: 'زيادة درج النقدية بقيمة الفائض الفعلي' },
            { accountCode: '4010', side: 'CREDIT', amount: varianceMinor, memo: 'فائض جرد درج النقدية عند تقفيل الشيفت' },
          ],
        });
      }
      return { bookMinor, varianceMinor, status };
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'SHIFT_CLOSED', entityType: 'CASH_DRAWER', entityId: body.idempotencyKey, summary: `تقفيل شيفت وجرد درج النقدية (${shiftResult.status})`, metadata: { status: shiftResult.status, bookBalance: shiftResult.bookMinor.toString(), actualCash: actualMinor.toString(), variance: shiftResult.varianceMinor.toString() } });
    return json(res, 201, {
      status: shiftResult.status,
      bookBalance: moneyJson(Money.fromMinor(shiftResult.bookMinor, tenant.currency)),
      actualCash: moneyJson(Money.fromMinor(actualMinor, tenant.currency)),
      variance: moneyJson(Money.fromMinor(shiftResult.varianceMinor, tenant.currency)),
    });
  }

  if (method === 'POST' && path === '/api/accounting/periods/close') {
    ctx.assertPermission(Permissions.SETTINGS_MANAGE);
    const body = validate(CloseAccountingPeriodSchema, await readJson(req));
    const period = await db.selectFrom('accounting_periods').selectAll().where('tenant_id', '=', ctx.tenantId).where('id', '=', body.periodId).executeTakeFirst();
    if (!period) throw Object.assign(new Error('الفترة المحاسبية غير موجودة'), { status: 404 });
    if (period.status === 'CLOSED') return json(res, 200, { id: period.id, status: 'CLOSED' });
    const closedAt = new Date().toISOString();
    await db.updateTable('accounting_periods').set({ status: 'CLOSED', closed_at: closedAt, closed_by_user_id: ctx.userId }).where('tenant_id', '=', ctx.tenantId).where('id', '=', period.id).execute();
    await recordAudit(ctx, { action: 'ACCOUNTING_PERIOD_CLOSED', entityType: 'ACCOUNTING_PERIOD', entityId: period.id, summary: `إقفال الفترة المحاسبية (${period.name})`, metadata: { periodName: period.name, startDate: period.start_date, endDate: period.end_date } });
    return json(res, 200, { id: period.id, status: 'CLOSED', closedAt });
  }

  if (method === 'POST' && path === '/api/accounting/opening-balances') {
    ctx.assertPermission(Permissions.SETTINGS_MANAGE);
    const body = validate(OpeningBalancesSchema, await readJson(req));
    if (ctx.storeId && ctx.storeId !== body.storeId) throw Object.assign(new Error('الفرع غير متاح لهذا المستخدم'), { status: 403 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });

    const cashDrawer = BigInt(body.cashDrawer);
    const cashSafe = BigInt(body.cashSafe);
    const bank = BigInt(body.bank);
    const inventoryVal = BigInt(body.inventory);
    const supplierPayables = BigInt(body.supplierPayables);
    const totalAssets = cashDrawer + cashSafe + bank + inventoryVal;
    if (totalAssets === 0n && supplierPayables === 0n) {
      throw Object.assign(new Error('يجب إدخال قيمة واحدة على الأقل للأرصدة الافتتاحية'), { status: 400 });
    }
    const netEquity = totalAssets - supplierPayables;
    const journalLines = [];
    if (cashDrawer > 0n) journalLines.push({ accountCode: '1010', side: 'DEBIT', amount: cashDrawer, memo: 'رصيد افتتاحي — درج النقدية' });
    if (cashSafe > 0n) journalLines.push({ accountCode: '1015', side: 'DEBIT', amount: cashSafe, memo: 'رصيد افتتاحي — الخزينة الرئيسية' });
    if (bank > 0n) journalLines.push({ accountCode: '1020', side: 'DEBIT', amount: bank, memo: 'رصيد افتتاحي — البنك' });
    if (inventoryVal > 0n) journalLines.push({ accountCode: '1300', side: 'DEBIT', amount: inventoryVal, memo: 'رصيد افتتاحي — المخزون' });
    if (supplierPayables > 0n) journalLines.push({ accountCode: '2010', side: 'CREDIT', amount: supplierPayables, memo: 'رصيد افتتاحي — مستحقات تجار سابقة' });
    if (netEquity > 0n) journalLines.push({ accountCode: '3010', side: 'CREDIT', amount: netEquity, memo: 'رصيد افتتاحي — رأس المال' });
    else if (netEquity < 0n) journalLines.push({ accountCode: '3010', side: 'DEBIT', amount: -netEquity, memo: 'رصيد افتتاحي — عجز رأس المال' });

    const journalKey = `opening-balance:${body.idempotencyKey}`;
    const entryRes = await db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('journal_entries').select(['id', 'entry_number'])
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalKey).executeTakeFirst();
      if (replay) return { id: replay.id, entryNumber: replay.entry_number, isReplay: true };

      const store = await trx.selectFrom('stores').select('id').where('id', '=', body.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!store) throw Object.assign(new Error('الفرع غير موجود'), { status: 404 });

      const existingOpening = await trx
        .selectFrom('journal_entries')
        .select(['id', 'entry_number as entryNumber', 'entry_date as entryDate'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', body.storeId)
        .where('idempotency_key', 'like', 'opening-balance:%')
        .where('reversed_by_entry_id', 'is', null)
        .where('status', '=', 'POSTED')
        .executeTakeFirst();
      if (existingOpening) {
        throw Object.assign(
          new Error(`تم تسجيل الأرصدة الافتتاحية لهذا الفرع مسبقًا بالقيد (${existingOpening.entryNumber}) بتاريخ ${existingOpening.entryDate} — لا يمكن تكرار الأرصدة الافتتاحية لنفس الفرع`),
          { status: 409 },
        );
      }

      await postJournalEntry(trx, ctx, {
        storeId: body.storeId,
        currency: tenant.currency,
        date: new Date(`${body.entryDate}T12:00:00.000Z`),
        entryDate: body.entryDate,
        sourceType: 'ADJUSTMENT',
        sourceId: body.idempotencyKey,
        idempotencyKey: journalKey,
        description: `أرصدة افتتاحية بتاريخ ${body.entryDate}${body.notes ? ` (${body.notes})` : ''}`,
        lines: journalLines,
      });
      const created = await trx.selectFrom('journal_entries').select(['id', 'entry_number'])
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalKey).executeTakeFirstOrThrow();
      return { id: created.id, entryNumber: created.entry_number, isReplay: false };
    });

    if (!entryRes.isReplay) {
      await recordAudit(ctx, {
        storeId: body.storeId,
        action: 'OPENING_BALANCE_POSTED',
        entityType: 'JOURNAL_ENTRY',
        entityId: entryRes.id,
        summary: `تسجيل أرصدة افتتاحية بتاريخ ${body.entryDate}`,
        metadata: { entryNumber: entryRes.entryNumber, cashDrawer: body.cashDrawer, cashSafe: body.cashSafe, bank: body.bank, inventory: body.inventory, supplierPayables: body.supplierPayables, netEquity: netEquity.toString() },
      });
    }
    return json(res, 201, {
      id: entryRes.id,
      entryNumber: entryRes.entryNumber,
      netEquity: moneyJson(Money.fromMinor(netEquity, tenant.currency)),
    });
  }

  const checkoutStatusMatch = method === 'GET' ? path.match(/^\/api\/checkout\/status\/([^/]+)$/i) : null;
  if (checkoutStatusMatch) {
    const ctx = await requireContext(req);
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    const idempotencyKey = validate(z.string().uuid('مفتاح المعاملة غير صالح'), decodeURIComponent(checkoutStatusMatch[1]).trim());
    const requestedStoreId = url.searchParams.get('storeId');
    if (requestedStoreId) assertStoreScope(ctx, requestedStoreId);
    const storeId = await resolveHistoryStore(ctx, url);
    const scopedCtx = new ScopedExecutionContext({
      tenantId: ctx.tenantId,
      storeId,
      userId: ctx.userId,
      roleId: ctx.roleId,
      permissions: ctx.permissions,
      correlationId: ctx.correlationId,
    });
    const canQueryAnyCashier = ctx.hasPermission(Permissions.AUDIT_LOG_VIEW)
      || ctx.roleId === 'OWNER'
      || ctx.roleId === 'STORE_MANAGER';
    const sale = await saleRepo.findByIdempotencyKey(scopedCtx, idempotencyKey);
    if (!sale || (!canQueryAnyCashier && sale.cashierUserId !== ctx.userId)) {
      return json(res, 200, { found: false });
    }
    const cashierUser = await userRepo.findById(ctx, sale.cashierUserId);
    return json(res, 200, {
      found: true,
      sale: {
        ...saleJson(sale),
        cashierName: cashierUser?.fullName ?? cashierUser?.username ?? 'كاشير',
      },
    });
  }

  if (method === 'POST' && path === '/api/checkout') {
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    if (!betaAutoLoginEnabled) {
      await licenseService.touchWatermarkOnCheckout();
    }
    const body = validate(CheckoutSchema, await readJson(req));
    const openShift = database.getRawDatabase().prepare(
      "SELECT id, store_id FROM cashier_shifts WHERE tenant_id = ? AND user_id = ? AND status = 'OPEN' LIMIT 1"
    ).get(ctx.tenantId, ctx.userId);
    if (!openShift) {
      throw Object.assign(new Error('يجب بدء الشيفت أولاً قبل إجراء أي عملية بيع'), { status: 403 });
    }
    if (openShift.store_id !== body.storeId) {
      throw Object.assign(new Error('الشيفت المفتوح مسجل على فرع آخر'), { status: 403 });
    }
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const cartDiscountMinor = body.cartDiscount ? BigInt(body.cartDiscount) : 0n;
    const hasDiscounts = cartDiscountMinor > 0n || body.items.some((item) => item.lineDiscount && BigInt(item.lineDiscount) > 0n);
    if (hasDiscounts) {
      ctx.assertPermission(Permissions.POS_DISCOUNT);
    }
    let cart = Cart.empty(tenant.currency);
    for (const [index, item] of body.items.entries()) {
      const variant = await variantRepo.findById(ctx, item.variantId);
      if (!variant) throw Object.assign(new Error('أحد المنتجات لم يعد متاحًا'), { status: 400 });
      const product = await productRepo.findById(ctx, variant.productId);
      if (!product) throw Object.assign(new Error('أحد المنتجات لم يعد متاحًا'), { status: 400 });
      if (variant.retailPrice.amount <= 0n) throw Object.assign(new Error(`الصنف "${product.name}" لم يتم تسعيره للبيع بعد — حدّد سعر البيع عند الشراء من التاجر أو من تعديل المنتج`), { status: 400 });
      const optionLabel = Object.entries(variant.attributes).map(([key, value]) => `${product.options.find((option) => option.key === key)?.name ?? key}: ${String(value)}`).join(' - ');
      const lineId = `line-${index}-${randomUUID()}`;
      cart = cart.addItem({ lineId, variantId: variant.id, productId: product.id, productName: optionLabel ? `${product.name} - ${optionLabel}` : product.name, sku: variant.sku, unitPrice: variant.retailPrice, quantity: BigInt(item.quantity) });
      if (item.lineDiscount && BigInt(item.lineDiscount) > 0n) {
        cart = cart.setLineDiscount(lineId, Money.fromMinor(BigInt(item.lineDiscount), tenant.currency));
      }
    }
    if (cartDiscountMinor > 0n) {
      cart = cart.setCartDiscount(Money.fromMinor(cartDiscountMinor, tenant.currency));
    }
    if (cart.total.amount <= 0n) {
      throw Object.assign(new Error('صافي الفاتورة بعد الخصم يجب أن يكون أكبر من صفر'), { status: 400 });
    }

    let resolvedPayments;
    if (Array.isArray(body.payments) && body.payments.length > 0) {
      resolvedPayments = body.payments.map((tender) => {
        const amt = BigInt(tender.amountMinor ?? tender.amount ?? '0');
        if (amt <= 0n) {
          throw Object.assign(new Error('جميع مبالغ الدفع المجزأ يجب أن تكون أكبر من صفر'), { status: 400 });
        }
        return { method: tender.method, amount: Money.fromMinor(amt, tenant.currency) };
      });
      const tenderSum = resolvedPayments.reduce((s, t) => s + t.amount.amount, 0n);
      if (tenderSum !== cart.total.amount) {
        throw Object.assign(new Error('مجموع أجزاء الدفع يجب أن يساوي صافي الفاتورة بالضبط'), { status: 400 });
      }
    } else if (body.payment) {
      const amt = BigInt(body.payment.amountMinor ?? body.payment.amount ?? '0');
      resolvedPayments = [{ method: body.payment.method, amount: Money.fromMinor(amt, tenant.currency) }];
    } else {
      const amt = BigInt(body.amountPaidMinor ?? '0');
      resolvedPayments = [{ method: body.paymentMethod, amount: Money.fromMinor(amt, tenant.currency) }];
    }

    const now = new Date();
    const tentativeSaleId = randomUUID();
    const sale = await checkout.checkout(ctx, {
      saleId: tentativeSaleId,
      storeId: body.storeId, cart,
      payments: resolvedPayments,
      idempotencyKey: body.idempotencyKey, customerName: body.customerName, occurredAt: now,
    });
    if (sale.id === tentativeSaleId) {
      const paymentSummary = resolvedPayments.length > 1 ? 'MIXED' : resolvedPayments[0].method;
      await recordAudit(ctx, {
        storeId: body.storeId,
        action: 'SALE_COMPLETED',
        entityType: 'SALE',
        entityId: sale.id,
        summary: `إتمام عملية بيع (${sale.saleNumber})`,
        metadata: {
          saleNumber: sale.saleNumber,
          total: sale.total.amount.toString(),
          paymentMethod: paymentSummary,
          payments: resolvedPayments.map((p) => ({ method: p.method, amount: p.amount.amount.toString() })),
        },
      });
    }
    const cashierUser = await userRepo.findById(ctx, ctx.userId);
    return json(res, 201, { ...saleJson(sale), cashierName: cashierUser?.fullName ?? cashierUser?.username ?? 'كاشير' });
  }

  if (method === 'GET' && path === '/api/stocktakes') {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const storesList = await storeRepo.listByTenant(ctx);
    const storeId = ctx.storeId ?? url.searchParams.get('storeId') ?? storesList[0]?.id;
    if (!storeId) throw Object.assign(new Error('المتجر غير محدد'), { status: 400 });
    assertStoreScope(ctx, storeId);
    const rawDb = database.getRawDatabase();
    const rows = rawDb.prepare(`
      SELECT s.*, c.name AS category_name, u1.full_name AS created_by_name, u2.full_name AS committed_by_name
      FROM stocktake_sessions s
      LEFT JOIN categories c ON c.id = s.category_id AND c.tenant_id = s.tenant_id
      LEFT JOIN users u1 ON u1.id = s.created_by_user_id AND u1.tenant_id = s.tenant_id
      LEFT JOIN users u2 ON u2.id = s.committed_by_user_id AND u2.tenant_id = s.tenant_id
      WHERE s.tenant_id = ? AND s.store_id = ?
      ORDER BY CASE WHEN s.status = 'DRAFT' THEN 0 ELSE 1 END, s.created_at DESC
      LIMIT 100
    `).all(ctx.tenantId, storeId);
    return json(res, 200, { sessions: rows.map(serializeStocktakeSessionSummary) });
  }

  if (method === 'POST' && path === '/api/stocktakes') {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const body = validate(CreateStocktakeSchema, await readJson(req));
    assertStoreScope(ctx, body.storeId);
    const store = await storeRepo.findById(ctx, body.storeId);
    if (!store) throw Object.assign(new Error('الفرع غير موجود'), { status: 404 });
    const tenant = await tenantRepo.findById(ctx.tenantId);
    const currency = typeof tenant?.currency === 'string' ? tenant.currency : (tenant?.currency?.code ?? 'EGP');

    let categoryName = null;
    if (body.scope === 'CATEGORY') {
      if (!body.categoryId) throw Object.assign(new Error('اختر التصنيف المطلوب جرده'), { status: 400 });
      const category = await categoryRepo.findById(ctx, body.categoryId);
      if (!category) throw Object.assign(new Error('التصنيف المحدد غير موجود'), { status: 404 });
      categoryName = category.name;
    }

    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();
    const todayLabel = nowIso.slice(0, 10);
    const defaultTitle = body.scope === 'FULL'
      ? `جرد شامل للمحل — ${todayLabel}`
      : body.scope === 'CATEGORY'
        ? `جرد تصنيف ${categoryName ?? ''} — ${todayLabel}`
        : `جرد انتقائي سريع — ${todayLabel}`;
    const title = body.title?.trim() || defaultTitle;

    const sessionNumber = await db.transaction().execute(async (trx) => {
      let eligibleVariants = [];
      if (body.scope !== 'PARTIAL') {
        let query = trx
          .selectFrom('product_variants as pv')
          .innerJoin('products as p', (join) =>
            join.onRef('p.id', '=', 'pv.product_id').onRef('p.tenant_id', '=', 'pv.tenant_id'),
          )
          .leftJoin('categories as c', (join) =>
            join.onRef('c.id', '=', 'p.category_id').onRef('c.tenant_id', '=', 'p.tenant_id'),
          )
          .select([
            'pv.id as variant_id',
            'pv.product_id',
            'pv.sku',
            'pv.barcode',
            'pv.retail_price',
            'p.name as product_name',
            'p.category_id',
            'c.name as category_name',
          ])
          .where('pv.tenant_id', '=', ctx.tenantId)
          .where('pv.is_active', '=', 1)
          .where('p.is_active', '=', 1)
          .where('p.item_kind', '=', 'PRODUCT');

        if (body.scope === 'CATEGORY' && body.categoryId) {
          query = query.where('p.category_id', '=', body.categoryId);
        }

        const invRows = await trx
          .selectFrom('inventory_items')
          .select(['variant_id', 'quantity_on_hand', 'wac_cost'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('store_id', '=', body.storeId)
          .execute();
        const invByVariant = new Map(invRows.map((item) => [item.variant_id, item]));

        const rawRows = (await query.orderBy('p.name', 'asc').orderBy('pv.sku', 'asc').execute()).map((row) => {
          const inv = invByVariant.get(row.variant_id);
          return {
            ...row,
            quantity_on_hand: inv?.quantity_on_hand ?? 0,
            wac_cost: inv?.wac_cost ?? 0,
          };
        });
        eligibleVariants = body.includeZeroStock
          ? rawRows
          : rawRows.filter((r) => Number(r.quantity_on_hand ?? 0) > 0);
        if (!body.includeZeroStock && eligibleVariants.length === 0) {
          throw Object.assign(
            new Error('لا توجد أصناف برصيد متاح (أكبر من صفر) في هذا النطاق حالياً. يمكنك تفعيل خيار «تضمين الأصناف المنتهية (رصيدها صفر)» إذا أردت الجرد من الصفر.'),
            { status: 400 },
          );
        }
      }

      const allocatedSessionNumber = await generateNextStocktakeNumber(ctx.tenantId, trx);
      await trx
        .insertInto('stocktake_sessions')
        .values({
          id: sessionId,
          tenant_id: ctx.tenantId,
          store_id: body.storeId,
          session_number: allocatedSessionNumber,
          title,
          scope: body.scope,
          category_id: body.scope === 'CATEGORY' ? (body.categoryId ?? null) : null,
          blind_mode: body.blindMode ? 1 : 0,
          include_zero_stock: body.includeZeroStock ? 1 : 0,
          status: 'DRAFT',
          idempotency_key: null,
          uncounted_strategy: null,
          currency,
          notes: body.notes?.trim() || null,
          total_lines: eligibleVariants.length,
          counted_lines: 0,
          total_variance_qty: 0,
          total_surplus_cost: 0n,
          total_shortage_cost: 0n,
          net_variance_cost: 0n,
          net_variance_retail: 0n,
          journal_entry_id: null,
          created_by_user_id: ctx.userId,
          committed_by_user_id: null,
          created_at: nowIso,
          updated_at: nowIso,
          committed_at: null,
          cancelled_at: null,
        })
        .execute();

      for (const variant of eligibleVariants) {
        await trx
          .insertInto('stocktake_lines')
          .values({
            id: randomUUID(),
            session_id: sessionId,
            tenant_id: ctx.tenantId,
            store_id: body.storeId,
            variant_id: variant.variant_id,
            product_id: variant.product_id,
            product_name: variant.product_name,
            sku: variant.sku,
            barcode: variant.barcode ?? null,
            category_id: variant.category_id ?? null,
            category_name: variant.category_name ?? null,
            expected_quantity: Math.max(0, Number(variant.quantity_on_hand ?? 0)),
            counted_quantity: null,
            unit_wac: toNonNegativeBigInt(variant.wac_cost),
            retail_price: toNonNegativeBigInt(variant.retail_price),
            override_unit_cost: null,
            scanned_count: 0,
            reason: null,
            committed_expected_quantity: null,
            committed_variance_qty: null,
            committed_variance_cost: null,
            committed_unit_cost: null,
            last_counted_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .execute();
      }
      return allocatedSessionNumber;
    });

    await recordAudit(ctx, {
      storeId: body.storeId,
      action: 'STOCKTAKE_CREATED',
      entityType: 'STOCKTAKE_SESSION',
      entityId: sessionId,
      summary: `بدء مسودة جرد ${sessionNumber} (${title})`,
      metadata: { sessionNumber, scope: body.scope, blindMode: body.blindMode, includeZeroStock: body.includeZeroStock },
    });

    return json(res, 201, loadStocktakeSessionDetail(ctx, sessionId));
  }

  const stocktakeExportMatch = method === 'GET' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)\/export\.csv$/i) : null;
  if (stocktakeExportMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const detail = loadStocktakeSessionDetail(ctx, stocktakeExportMatch[1], { includeBlindReview: true });
    const formatDecimalSigned = (moneyObj) => {
      if (!moneyObj) return '0';
      const decimals = Number(moneyObj.decimals ?? 2);
      const minor = BigInt(String(moneyObj.amount ?? '0'));
      const sign = minor < 0n ? '-' : '';
      const abs = minor < 0n ? -minor : minor;
      if (decimals === 0) return `${sign}${abs.toString()}`;
      const digits = abs.toString().padStart(decimals + 1, '0');
      return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
    };
    const rows = [[
      'كود الجرد',
      'المنتج',
      'النسخة',
      'SKU',
      'الباركود',
      'التصنيف',
      'الرصيد المتوقع',
      'العد الفعلي',
      'الفرق',
      'متوسط التكلفة',
      'أثر التكلفة',
      'سعر البيع',
      'أثر البيع',
      'مرات المسح',
      'ملاحظة',
    ]];
    for (const line of detail.lines) {
      rows.push([
        detail.session.sessionNumber,
        line.productName,
        line.variantLabel || '',
        line.sku,
        line.barcode || '',
        line.categoryName || '',
        String(line.expectedQuantity ?? ''),
        line.countedQuantity === null ? 'لم يُعدّ' : String(line.countedQuantity),
        line.varianceQty === null ? '' : String(line.varianceQty),
        formatDecimalSigned(line.unitWac),
        line.varianceQty === null ? '' : formatDecimalSigned(line.varianceCost),
        formatDecimalSigned(line.retailPrice),
        line.varianceQty === null ? '' : formatDecimalSigned(line.varianceRetail),
        String(line.scannedCount ?? 0),
        line.reason || '',
      ]);
    }
    const csvContent = '\uFEFF' + rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="stocktake-${detail.session.sessionNumber}.csv"`,
      'Cache-Control': 'no-store',
      ...securityHeaders(),
    });
    res.end(csvContent);
    return;
  }

  const stocktakeDetailMatch = method === 'GET' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)$/i) : null;
  if (stocktakeDetailMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const includeBlindReview = url.searchParams.get('review') === '1';
    return json(res, 200, loadStocktakeSessionDetail(ctx, stocktakeDetailMatch[1], { includeBlindReview }));
  }

  const stocktakeSettingsMatch = method === 'PATCH' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)\/settings$/i) : null;
  if (stocktakeSettingsMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const sessionId = stocktakeSettingsMatch[1];
    const body = validate(UpdateStocktakeSettingsSchema, await readJson(req));
    const existing = await db
      .selectFrom('stocktake_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!existing) throw Object.assign(new Error('جلسة الجرد غير موجودة'), { status: 404 });
    assertStoreScope(ctx, existing.store_id);
    if (existing.status !== 'DRAFT') throw Object.assign(new Error('لا يمكن تعديل إعدادات جرد تم اعتماده أو إلغاؤه'), { status: 409 });

    const updates = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) updates.title = body.title;
    if (body.notes !== undefined) updates.notes = body.notes?.trim() || null;
    if (body.blindMode !== undefined) updates.blind_mode = body.blindMode ? 1 : 0;

    await db
      .updateTable('stocktake_sessions')
      .set(updates)
      .where('id', '=', sessionId)
      .where('tenant_id', '=', ctx.tenantId)
      .where('status', '=', 'DRAFT')
      .execute();

    return json(res, 200, loadStocktakeSessionDetail(ctx, sessionId));
  }

  const stocktakeLinesMatch = method === 'PATCH' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)\/lines$/i) : null;
  if (stocktakeLinesMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const sessionId = stocktakeLinesMatch[1];
    const body = validate(PatchStocktakeLinesSchema, await readJson(req));
    const existing = await db
      .selectFrom('stocktake_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!existing) throw Object.assign(new Error('جلسة الجرد غير موجودة'), { status: 404 });
    assertStoreScope(ctx, existing.store_id);
    if (existing.status !== 'DRAFT') throw Object.assign(new Error('لا يمكن تعديل مسودة جرد تم اعتمادها أو إلغاؤها'), { status: 409 });

    const nowIso = new Date().toISOString();
    let lastScannedLineId = null;

    await db.transaction().execute(async (trx) => {
      if (body.action === 'MARK_REMAINING_EXACT') {
        const uncountedRows = await trx
          .selectFrom('stocktake_lines as l')
          .leftJoin('inventory_items as ii', (join) =>
            join
              .onRef('ii.variant_id', '=', 'l.variant_id')
              .onRef('ii.tenant_id', '=', 'l.tenant_id')
              .onRef('ii.store_id', '=', 'l.store_id'),
          )
          .select(['l.id', 'l.expected_quantity', 'ii.quantity_on_hand as live_quantity'])
          .where('l.session_id', '=', sessionId)
          .where('l.tenant_id', '=', ctx.tenantId)
          .where('l.counted_quantity', 'is', null)
          .execute();
        for (const row of uncountedRows) {
          const exactQty = Math.max(0, Number(row.live_quantity ?? row.expected_quantity ?? 0));
          await trx
            .updateTable('stocktake_lines')
            .set({ counted_quantity: exactQty, last_counted_at: nowIso, updated_at: nowIso })
            .where('id', '=', row.id)
            .where('session_id', '=', sessionId)
            .execute();
        }
      }

      if (body.scanCode) {
        const codeLower = body.scanCode.trim().toLowerCase();
        const step = body.delta ?? 1;
        const sessionMatches = await trx
          .selectFrom('stocktake_lines')
          .selectAll()
          .where('session_id', '=', sessionId)
          .where('tenant_id', '=', ctx.tenantId)
          .execute();
        const existingMatches = sessionMatches.filter(
          (l) => (l.barcode && l.barcode.toLowerCase() === codeLower) || l.sku.toLowerCase() === codeLower,
        );

        if (existingMatches.length === 1) {
          const line = existingMatches[0];
          const nextCount = Math.max(0, Number(line.counted_quantity ?? 0) + step);
          await trx
            .updateTable('stocktake_lines')
            .set({
              counted_quantity: nextCount,
              scanned_count: Number(line.scanned_count ?? 0) + 1,
              last_counted_at: nowIso,
              updated_at: nowIso,
            })
            .where('id', '=', line.id)
            .execute();
          lastScannedLineId = line.id;
        } else if (existingMatches.length > 1) {
          throw Object.assign(new Error('الباركود مطابق لأكثر من سطر في الجرد؛ اختر الصنف مباشرة'), { status: 409 });
        } else {
          const catalogVariants = await trx
            .selectFrom('product_variants as pv')
            .innerJoin('products as p', (join) =>
              join.onRef('p.id', '=', 'pv.product_id').onRef('p.tenant_id', '=', 'pv.tenant_id'),
            )
            .leftJoin('categories as c', (join) =>
              join.onRef('c.id', '=', 'p.category_id').onRef('c.tenant_id', '=', 'p.tenant_id'),
            )
            .select([
              'pv.id as variant_id',
              'pv.product_id',
              'pv.sku as variant_sku',
              'pv.barcode as variant_barcode',
              'pv.retail_price',
              'p.name as product_name',
              'p.sku as product_sku',
              'p.barcode as product_barcode',
              'p.category_id',
              'c.name as category_name',
            ])
            .where('pv.tenant_id', '=', ctx.tenantId)
            .where('pv.is_active', '=', 1)
            .where('p.is_active', '=', 1)
            .where('p.item_kind', '=', 'PRODUCT')
            .execute();

          const exactVariantMatches = catalogVariants.filter(
            (v) => (v.variant_barcode && v.variant_barcode.toLowerCase() === codeLower) || v.variant_sku.toLowerCase() === codeLower,
          );
          const candidateList = exactVariantMatches.length > 0
            ? exactVariantMatches
            : catalogVariants.filter(
              (v) => (v.product_barcode && v.product_barcode.toLowerCase() === codeLower) || v.product_sku.toLowerCase() === codeLower,
            );

          if (candidateList.length === 0) {
            throw Object.assign(new Error(`لم يتم العثور على منتج بالباركود أو الكود: ${body.scanCode}`), { status: 404 });
          }
          if (candidateList.length > 1) {
            throw Object.assign(new Error('الكود مطابق لأكثر من نسخة للمنتج؛ امسح باركود النسخة المحددة'), { status: 409 });
          }

          const picked = candidateList[0];
          const pickedInv = await trx
            .selectFrom('inventory_items')
            .select(['quantity_on_hand', 'wac_cost'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('store_id', '=', existing.store_id)
            .where('variant_id', '=', picked.variant_id)
            .executeTakeFirst();
          const existingLineByVariant = sessionMatches.find((l) => l.variant_id === picked.variant_id);
          if (existingLineByVariant) {
            const nextCount = Math.max(0, Number(existingLineByVariant.counted_quantity ?? 0) + step);
            await trx
              .updateTable('stocktake_lines')
              .set({
                counted_quantity: nextCount,
                scanned_count: Number(existingLineByVariant.scanned_count ?? 0) + 1,
                last_counted_at: nowIso,
                updated_at: nowIso,
              })
              .where('id', '=', existingLineByVariant.id)
              .execute();
            lastScannedLineId = existingLineByVariant.id;
          } else {
            const newLineId = randomUUID();
            await trx
              .insertInto('stocktake_lines')
              .values({
                id: newLineId,
                session_id: sessionId,
                tenant_id: ctx.tenantId,
                store_id: existing.store_id,
                variant_id: picked.variant_id,
                product_id: picked.product_id,
                product_name: picked.product_name,
                sku: picked.variant_sku,
                barcode: picked.variant_barcode ?? null,
                category_id: picked.category_id ?? null,
                category_name: picked.category_name ?? null,
                expected_quantity: Math.max(0, Number(pickedInv?.quantity_on_hand ?? 0)),
                counted_quantity: Math.max(0, step),
                unit_wac: toNonNegativeBigInt(pickedInv?.wac_cost),
                retail_price: toNonNegativeBigInt(picked.retail_price),
                override_unit_cost: null,
                scanned_count: 1,
                reason: null,
                committed_expected_quantity: null,
                committed_variance_qty: null,
                committed_variance_cost: null,
                committed_unit_cost: null,
                last_counted_at: nowIso,
                created_at: nowIso,
                updated_at: nowIso,
              })
              .execute();
            lastScannedLineId = newLineId;
          }
        }
      }

      if (body.addVariantId) {
        const alreadyInSession = await trx
          .selectFrom('stocktake_lines')
          .select(['id', 'counted_quantity'])
          .where('session_id', '=', sessionId)
          .where('variant_id', '=', body.addVariantId)
          .executeTakeFirst();
        if (alreadyInSession) {
          if (body.addDelta !== undefined && body.addDelta > 0) {
            const nextCount = Math.max(0, Number(alreadyInSession.counted_quantity ?? 0) + body.addDelta);
            await trx
              .updateTable('stocktake_lines')
              .set({
                counted_quantity: nextCount,
                last_counted_at: nowIso,
                updated_at: nowIso,
              })
              .where('id', '=', alreadyInSession.id)
              .execute();
          }
          lastScannedLineId = alreadyInSession.id;
        } else {
          const v = await trx
            .selectFrom('product_variants as pv')
            .innerJoin('products as p', (join) =>
              join.onRef('p.id', '=', 'pv.product_id').onRef('p.tenant_id', '=', 'pv.tenant_id'),
            )
            .leftJoin('categories as c', (join) =>
              join.onRef('c.id', '=', 'p.category_id').onRef('c.tenant_id', '=', 'p.tenant_id'),
            )
            .select([
              'pv.id as variant_id',
              'pv.product_id',
              'pv.sku',
              'pv.barcode',
              'pv.retail_price',
              'p.name as product_name',
              'p.category_id',
              'c.name as category_name',
            ])
            .where('pv.id', '=', body.addVariantId)
            .where('pv.tenant_id', '=', ctx.tenantId)
            .where('pv.is_active', '=', 1)
            .where('p.is_active', '=', 1)
            .where('p.item_kind', '=', 'PRODUCT')
            .executeTakeFirst();
          if (!v) throw Object.assign(new Error('الصنف المحدد غير متاح للجرد'), { status: 404 });
          const vInv = await trx
            .selectFrom('inventory_items')
            .select(['quantity_on_hand', 'wac_cost'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('store_id', '=', existing.store_id)
            .where('variant_id', '=', v.variant_id)
            .executeTakeFirst();
          const newLineId = randomUUID();
          await trx
            .insertInto('stocktake_lines')
            .values({
              id: newLineId,
              session_id: sessionId,
              tenant_id: ctx.tenantId,
              store_id: existing.store_id,
              variant_id: v.variant_id,
              product_id: v.product_id,
              product_name: v.product_name,
              sku: v.sku,
              barcode: v.barcode ?? null,
              category_id: v.category_id ?? null,
              category_name: v.category_name ?? null,
              expected_quantity: Math.max(0, Number(vInv?.quantity_on_hand ?? 0)),
              counted_quantity: body.addDelta !== undefined ? Math.max(0, body.addDelta) : null,
              unit_wac: toNonNegativeBigInt(vInv?.wac_cost),
              retail_price: toNonNegativeBigInt(v.retail_price),
              override_unit_cost: null,
              scanned_count: 0,
              reason: null,
              committed_expected_quantity: null,
              committed_variance_qty: null,
              committed_variance_cost: null,
              committed_unit_cost: null,
              last_counted_at: body.addDelta !== undefined && body.addDelta > 0 ? nowIso : null,
              created_at: nowIso,
              updated_at: nowIso,
            })
            .execute();
          lastScannedLineId = newLineId;
        }
      }

      if (body.lines && body.lines.length > 0) {
        for (const patch of body.lines) {
          const lineSet = { updated_at: nowIso };
          if (patch.countedQuantity !== undefined) {
            lineSet.counted_quantity = patch.countedQuantity === null ? null : Math.max(0, patch.countedQuantity);
            if (patch.countedQuantity !== null) lineSet.last_counted_at = nowIso;
          }
          if (patch.overrideUnitCost !== undefined) {
            lineSet.override_unit_cost = patch.overrideUnitCost === null ? null : BigInt(patch.overrideUnitCost);
          }
          if (patch.reason !== undefined) {
            lineSet.reason = patch.reason?.trim() || null;
          }
          await trx
            .updateTable('stocktake_lines')
            .set(lineSet)
            .where('id', '=', patch.lineId)
            .where('session_id', '=', sessionId)
            .where('tenant_id', '=', ctx.tenantId)
            .execute();
        }
      }

      await syncStocktakeDraftTotals(trx, sessionId, ctx.tenantId, existing.store_id);
    });

    return json(res, 200, loadStocktakeSessionDetail(ctx, sessionId, { lastScannedLineId }));
  }

  const stocktakeCommitMatch = method === 'POST' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)\/commit$/i) : null;
  if (stocktakeCommitMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const sessionId = stocktakeCommitMatch[1];
    const body = validate(CommitStocktakeSchema, await readJson(req));

    let auditMeta = null;
    await db.transaction().execute(async (trx) => {
      const idempotentExisting = await trx
        .selectFrom('stocktake_sessions')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', body.idempotencyKey)
        .executeTakeFirst();
      if (idempotentExisting) {
        assertStoreScope(ctx, idempotentExisting.store_id);
        if (idempotentExisting.id === sessionId && idempotentExisting.status === 'COMMITTED') {
          return;
        }
        throw Object.assign(new Error('مفتاح التكرار مستخدم في عملية جرد أخرى'), { status: 409 });
      }

      const session = await trx
        .selectFrom('stocktake_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst();
      if (!session) throw Object.assign(new Error('جلسة الجرد غير موجودة'), { status: 404 });
      assertStoreScope(ctx, session.store_id);
      if (session.status !== 'DRAFT') throw Object.assign(new Error('لا يمكن اعتماد جلسة جرد مغلقة أو ملغاة بالفعل'), { status: 409 });

      const lineRows = await trx
        .selectFrom('stocktake_lines as l')
        .leftJoin('inventory_items as ii', (join) =>
          join
            .onRef('ii.variant_id', '=', 'l.variant_id')
            .onRef('ii.tenant_id', '=', 'l.tenant_id')
            .onRef('ii.store_id', '=', 'l.store_id'),
        )
        .select([
          'l.id',
          'l.variant_id',
          'l.product_name',
          'l.sku',
          'l.expected_quantity',
          'l.counted_quantity',
          'l.unit_wac',
          'l.retail_price',
          'l.override_unit_cost',
          'l.last_counted_at',
          'ii.quantity_on_hand as live_quantity',
          'ii.wac_cost as live_wac_cost',
        ])
        .where('l.session_id', '=', sessionId)
        .where('l.tenant_id', '=', ctx.tenantId)
        .execute();

      if (lineRows.length === 0) {
        throw Object.assign(new Error('جلسة الجرد فارغة؛ أضف صنفًا واحدًا على الأقل قبل الاعتماد'), { status: 400 });
      }

      const countedCountExisting = lineRows.filter((l) => l.counted_quantity !== null && l.counted_quantity !== undefined).length;
      if (body.uncountedStrategy === 'SKIP_UNCOUNTED' && countedCountExisting === 0) {
        throw Object.assign(new Error('لم يتم عدّ أي صنف بعد. قم بعدّ صنف واحد على الأقل أو اختر اعتبار غير المعدود صفراً'), { status: 400 });
      }

      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const currency = session.currency || 'EGP';
      const missingCostNames = [];
      const prepared = [];

      for (const line of lineRows) {
        const liveQty = Math.max(0, Number(line.live_quantity ?? 0));
        const liveWacMinor = BigInt(line.live_wac_cost ?? line.unit_wac ?? 0);
        const overrideCostMinor = line.override_unit_cost !== null && line.override_unit_cost !== undefined ? BigInt(line.override_unit_cost) : null;
        const rawCounted = line.counted_quantity !== null && line.counted_quantity !== undefined
          ? Number(line.counted_quantity)
          : body.uncountedStrategy === 'ZERO_UNCOUNTED'
            ? 0
            : null;

        if (rawCounted === null) {
          prepared.push({ line, skipped: true, liveQty, counted: null, delta: 0, unitCostMinor: liveWacMinor });
          continue;
        }

        const delta = rawCounted - liveQty;
        if (delta > 0 && overrideCostMinor === null && liveWacMinor <= 0n) {
          missingCostNames.push(`${line.product_name} (${line.sku})`);
        }
        const unitCostMinor = delta > 0 ? (overrideCostMinor !== null ? overrideCostMinor : liveWacMinor) : liveWacMinor;
        prepared.push({ line, skipped: false, liveQty, counted: rawCounted, delta, unitCostMinor });
      }

      if (missingCostNames.length > 0) {
        throw Object.assign(
          new Error(`يجب تحديد تكلفة الوحدة للأصناف التي بها زيادة وتكلفتها المسجلة صفر: ${missingCostNames.slice(0, 5).join('، ')}`),
          { status: 400 },
        );
      }

      let surplusCostTotal = 0n;
      let shortageCostTotal = 0n;
      let totalVarianceQty = 0;
      let netVarianceRetail = 0n;
      let countedLines = 0;
      let adjustedLines = 0;

      for (const entry of prepared) {
        const { line, skipped, liveQty, counted, delta, unitCostMinor } = entry;
        if (skipped) {
          await trx
            .updateTable('stocktake_lines')
            .set({
              committed_expected_quantity: liveQty,
              committed_variance_qty: 0,
              committed_variance_cost: 0n,
              committed_unit_cost: unitCostMinor,
              updated_at: nowIso,
            })
            .where('id', '=', line.id)
            .where('session_id', '=', sessionId)
            .execute();
          continue;
        }

        countedLines += 1;
        totalVarianceQty += delta;
        netVarianceRetail += BigInt(delta) * BigInt(line.retail_price ?? 0);

        let lineCostVariance = 0n;
        if (delta !== 0) {
          adjustedLines += 1;
          const movement = await applyStockMovementInTransaction(trx, ctx, {
            id: randomUUID(),
            storeId: session.store_id,
            variantId: line.variant_id,
            currency,
            movementType: 'INVENTORY_ADJUSTMENT',
            quantityDelta: BigInt(delta),
            ...(delta > 0 ? { unitCost: Money.fromMinor(unitCostMinor, currency) } : {}),
            sourceType: 'ADJUSTMENT',
            sourceId: session.id,
            allowNegativeStock: false,
          });
          const absDelta = BigInt(delta > 0 ? delta : -delta);
          const movementTotalCost = movement.unitCost.amount * absDelta;
          if (delta > 0) {
            lineCostVariance = movementTotalCost;
            surplusCostTotal += movementTotalCost;
          } else {
            lineCostVariance = -movementTotalCost;
            shortageCostTotal += movementTotalCost;
          }
        }

        await trx
          .updateTable('stocktake_lines')
          .set({
            counted_quantity: counted,
            last_counted_at: line.last_counted_at ?? nowIso,
            committed_expected_quantity: liveQty,
            committed_variance_qty: delta,
            committed_variance_cost: lineCostVariance,
            committed_unit_cost: unitCostMinor,
            updated_at: nowIso,
          })
          .where('id', '=', line.id)
          .where('session_id', '=', sessionId)
          .execute();
      }

      let journalEntryId = null;
      if (surplusCostTotal > 0n || shortageCostTotal > 0n) {
        const journalLines = [];
        if (surplusCostTotal > 0n) {
          journalLines.push({ accountCode: '1300', side: 'DEBIT', amount: surplusCostTotal, memo: `زيادة مخزون جرد ${session.session_number}` });
          journalLines.push({ accountCode: '5090', side: 'CREDIT', amount: surplusCostTotal, memo: `إثبات زيادة جرد ${session.session_number}` });
        }
        if (shortageCostTotal > 0n) {
          journalLines.push({ accountCode: '5090', side: 'DEBIT', amount: shortageCostTotal, memo: `عجز مخزون جرد ${session.session_number}` });
          journalLines.push({ accountCode: '1300', side: 'CREDIT', amount: shortageCostTotal, memo: `خصم عجز جرد ${session.session_number}` });
        }
        const journalKey = `stocktake-commit-${session.id}`;
        try {
          await postJournalEntry(trx, ctx, {
            storeId: session.store_id,
            currency,
            date: nowDate,
            sourceType: 'ADJUSTMENT',
            sourceId: session.id,
            idempotencyKey: journalKey,
            description: `تسوية الجرد الشامل ${session.session_number} — ${session.title}`,
            lines: journalLines,
          });
        } catch (err) {
          if (/closed|مغلق|مقفل|period/i.test(String(err?.message ?? ''))) {
            throw Object.assign(new Error('لا يمكن اعتماد الجرد لأن الفترة المحاسبية لهذا التاريخ مغلقة'), { status: 409 });
          }
          throw err;
        }
        const journalRow = await trx
          .selectFrom('journal_entries')
          .select('id')
          .where('tenant_id', '=', ctx.tenantId)
          .where('idempotency_key', '=', journalKey)
          .executeTakeFirst();
        journalEntryId = journalRow?.id ?? null;
      }

      const netVarianceCost = surplusCostTotal - shortageCostTotal;
      const updateResult = await trx
        .updateTable('stocktake_sessions')
        .set({
          status: 'COMMITTED',
          idempotency_key: body.idempotencyKey,
          uncounted_strategy: body.uncountedStrategy,
          notes: body.notes !== undefined ? (body.notes?.trim() || null) : session.notes,
          total_lines: lineRows.length,
          counted_lines: countedLines,
          total_variance_qty: totalVarianceQty,
          total_surplus_cost: surplusCostTotal,
          total_shortage_cost: shortageCostTotal,
          net_variance_cost: netVarianceCost,
          net_variance_retail: netVarianceRetail,
          journal_entry_id: journalEntryId,
          committed_by_user_id: ctx.userId,
          committed_at: nowIso,
          updated_at: nowIso,
        })
        .where('id', '=', session.id)
        .where('tenant_id', '=', ctx.tenantId)
        .where('status', '=', 'DRAFT')
        .executeTakeFirst();

      if (updateResult.numUpdatedRows !== 1n) {
        throw Object.assign(new Error('تعذر اعتماد الجرد: تم تغييره في طلب متزامن آخر'), { status: 409 });
      }

      auditMeta = {
        storeId: session.store_id,
        sessionNumber: session.session_number,
        title: session.title,
        countedLines,
        adjustedLines,
        totalVarianceQty,
        surplusCostTotal: surplusCostTotal.toString(),
        shortageCostTotal: shortageCostTotal.toString(),
        journalEntryId,
      };
    });

    if (auditMeta) {
      await recordAudit(ctx, {
        storeId: auditMeta.storeId,
        action: 'STOCKTAKE_COMMITTED',
        entityType: 'STOCKTAKE_SESSION',
        entityId: sessionId,
        summary: `اعتماد وترحيل الجرد ${auditMeta.sessionNumber} (${auditMeta.countedLines} صنف معدود، ${auditMeta.adjustedLines} تعديل رصيد)`,
        metadata: auditMeta,
      });
    }

    return json(res, 200, loadStocktakeSessionDetail(ctx, sessionId, { includeBlindReview: true }));
  }

  const stocktakeCancelMatch = method === 'POST' ? path.match(/^\/api\/stocktakes\/([0-9a-f-]+)\/cancel$/i) : null;
  if (stocktakeCancelMatch) {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    const sessionId = stocktakeCancelMatch[1];
    const existing = await db
      .selectFrom('stocktake_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!existing) throw Object.assign(new Error('جلسة الجرد غير موجودة'), { status: 404 });
    assertStoreScope(ctx, existing.store_id);
    if (existing.status !== 'DRAFT') throw Object.assign(new Error('لا يمكن إلغاء جرد تم اعتماده أو إلغاؤه مسبقاً'), { status: 409 });

    const nowIso = new Date().toISOString();
    const resCancel = await db
      .updateTable('stocktake_sessions')
      .set({ status: 'CANCELLED', cancelled_at: nowIso, updated_at: nowIso })
      .where('id', '=', sessionId)
      .where('tenant_id', '=', ctx.tenantId)
      .where('status', '=', 'DRAFT')
      .executeTakeFirst();
    if (resCancel.numUpdatedRows !== 1n) {
      throw Object.assign(new Error('تعذر إلغاء مسودة الجرد'), { status: 409 });
    }

    await recordAudit(ctx, {
      storeId: existing.store_id,
      action: 'STOCKTAKE_CANCELLED',
      entityType: 'STOCKTAKE_SESSION',
      entityId: sessionId,
      summary: `إلغاء مسودة الجرد ${existing.session_number} (${existing.title})`,
      metadata: { sessionNumber: existing.session_number },
    });

    return json(res, 200, loadStocktakeSessionDetail(ctx, sessionId));
  }

  throw Object.assign(new Error('المسار غير موجود'), { status: 404 });
}

function mimeType(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw Object.assign(new Error('استخدم عنوان التطبيق المحلي'), { status: 421 });
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/api/')) {
      if (restoreMaintenanceMode) {
        return json(res, 503, { error: 'النظام في وضع الصيانة لاستعادة قاعدة البيانات', code: 'RESTORE_IN_PROGRESS', retryable: true });
      }
      activeApiRequestCount += 1;
      try {
        if (process.env.NODE_ENV === 'test' && typeof options.beforeApiRequest === 'function') {
          await options.beforeApiRequest(url);
        }
        return await handleApi(req, res, url);
      } finally {
        activeApiRequestCount -= 1;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw Object.assign(new Error('الطريقة غير مسموحة'), { status: 405 });
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch (uriError) {
      if (uriError instanceof URIError) throw Object.assign(new Error('المسار غير صالح'), { status: 400 });
      throw uriError;
    }
    let target = resolve(publicDir, `.${normalize(relativePath)}`);
    const isCleanSpaRoute = /^\/(pos|sales|inventory|products|stocktake|suppliers|expenses|monthly-expenses|financial-map|accounting|reports|profit-loss|top-products|shifts|users|audit-logs|backups)\/?$/i.test(url.pathname);
    if (isCleanSpaRoute) {
      target = join(publicDir, 'index.html');
    } else {
      if (!target.startsWith(`${publicDir}${sep}`) && target !== join(publicDir, 'index.html')) throw Object.assign(new Error('الملف غير موجود'), { status: 404 });
      if (!existsSync(target)) throw Object.assign(new Error('الملف غير موجود'), { status: 404 });
    }
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': mimeType(target), 'Cache-Control': 'no-store', ...securityHeaders() });
    res.end(content);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const databaseConflict = typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
    const isInsufficientStock = error instanceof DomainError && error.code === 'INSUFFICIENT_STOCK';
    const isDomainClientError = error instanceof DomainError;
    const status = Number.isInteger(error?.status) ? error.status : error?.message?.startsWith('UnauthorizedError') ? 403 : databaseConflict ? 409 : isDomainClientError ? 400 : 500;
    if (status >= 500) {
      console.error('Request failed with status:', Number(status));
      if (process.env.NODE_ENV === 'test' && typeof options.onRequestFailure === 'function') {
        options.onRequestFailure({ status, code: typeof error?.code === 'string' ? error.code : undefined, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const isTransientHardware = error instanceof LicenseHardwareIdentityError;
    const isExposedError = Boolean(error?.exposeMessage);
    const message = isTransientHardware
      ? error.message
      : isExposedError && typeof error?.message === 'string' && error.message
        ? error.message
        : status >= 500
          ? 'حصل خطأ داخلي. لم يتم تنفيذ العملية.'
          : isInsufficientStock
            ? 'الكمية المطلوبة غير متوفرة في المخزون (تم بيعها أو نفد الرصيد)'
            : (error?.message ?? 'حدث خطأ غير متوقع');
    const errorBody = error instanceof LicenseEnforcementError
      ? { error: message, code: error.code, licenseStatus: error.licenseStatus }
      : isTransientHardware
        ? { error: message, code: error.code, retryable: true }
        : isExposedError && typeof error?.code === 'string'
          ? { error: message, code: error.code }
          : { error: message };
    json(res, status, errorBody);
  }
});

startScheduledDatabaseTasks();

let restartScheduled = false;
function schedulePostRestoreRestart(res) {
  res.once('finish', () => {
    if (process.env.NODE_ENV === 'test' && typeof options.onRestoreRestartRequested === 'function') {
      void Promise.resolve().then(() => options.onRestoreRestartRequested()).catch((error) => {
        console.error('Test restore restart callback failed:', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    restartLocalServer();
  });
}

function restartLocalServer() {
  if (restartScheduled) return;
  restartScheduled = true;
  restoreMaintenanceMode = true;
  stopScheduledDatabaseTasks();
  hostSecrets.closeHostChannel?.();
  server.close(() => {
    database.checkpointPassive();
    void database.close().then(() => {
      const child = spawn(process.execPath, [serverFilePath, '--electron-stdio-secret'], {
        cwd: appDir,
        env: process.env,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(`${JSON.stringify({
        watermarkSecret,
        ...(dailyBackupSecret ? { dailyBackupSecret } : {}),
        ...(historicalDailyBackupKeys.length > 0 ? { dailyBackupKeyHistory: historicalDailyBackupKeys } : {}),
        ...(latestExternalClockMs > 0 ? { externalClockMs: latestExternalClockMs } : {}),
      })}\n`);
      child.stdin?.end();
      child.unref();
      setTimeout(() => process.exit(0), 250);
    }).catch((error) => {
      console.error('Could not restart after database restore', error);
      process.exit(1);
    });
  });
}

const controlFilePath = join(dataDir, '.retailos-control.json');
const internalShutdownToken = randomBytes(32).toString('hex');
let controlFileOwned = false;
function removeControlFileSync() {
  if (!controlFileOwned) return;
  controlFileOwned = false;
  try {
    if (existsSync(controlFilePath)) unlinkSync(controlFilePath);
  } catch {
    // Best-effort cleanup of local runtime control file
  }
}

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  try {
    writeFileSync(
      controlFilePath,
      JSON.stringify({
        pid: process.pid,
        port: boundPort,
        token: internalShutdownToken,
        startedAt: new Date().toISOString(),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    controlFileOwned = true;
  } catch (err) {
    console.warn('Could not write runtime control file', err);
  }
  console.log(`RetailOS is running locally at ${origin}`);
  console.log(`Company database: ${databasePath}`);
  void licenseService.getStatus().catch((err) => {
    if (err instanceof LicenseHardwareIdentityError) {
      console.warn(`[RetailOS Licensing] Deferred initial hardware identity check: ${err.message}`);
      return;
    }
    console.error('[RetailOS Licensing] Initial license probe failed:', err);
  });
});

let shutdownPromise = null;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    restoreMaintenanceMode = true;
    stopScheduledDatabaseTasks();
    hostSecrets.closeHostChannel?.();
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 2000);
      timeout.unref();
      server.close(() => {
        clearTimeout(timeout);
        resolve(undefined);
      });
      server.closeIdleConnections?.();
    });
    await ensureDailyBackup({ force: true, syncMirror: true }).catch(() => undefined);
    try {
      database.getRawDatabase().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      database.checkpointPassive();
    }
    await database.close();
    removeControlFileSync();
  })();
  return shutdownPromise;
}
process.on('exit', () => removeControlFileSync());
process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  return { server, port, origin, databasePath, licenseService, shutdown };
}

function isInvokedAsMainModule() {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    return realpathSync(resolve(entryArg)) === realpathSync(serverFilePath);
  } catch {
    return resolve(entryArg) === resolve(serverFilePath);
  }
}

if (isInvokedAsMainModule()) {
  try {
    await createServerApp();
  } catch (startupError) {
    console.error(startupError instanceof Error ? startupError.message : String(startupError));
    process.exit(1);
  }
}
