import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { EMBEDDED_LICENSE_PUBLIC_KEY_PEM } from './license-public-key.generated.js';

export const DEFAULT_DESKTOP_PORT = 3210;

export const DESKTOP_IPC_CHANNELS = Object.freeze({
  HOST_STATUS: 'retailos:host:status',
  SYNC_RUN_BATCH: 'retailos:sync:run-batch',
  SYNC_STATS: 'retailos:sync:stats',
  AUDIT_VERIFY_CHAIN: 'retailos:audit:verify-chain',
} as const);

export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

const ALLOWED_IPC_CHANNEL_SET = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS));

export interface DesktopWindowSecurityPolicy {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly allowedOrigin: string;
  isAllowedNavigationUrl(targetUrl: string): boolean;
  isAllowedChildNavigationUrl(targetUrl: string): boolean;
  isAllowedPermissionRequest(
    permission: string,
    requestingOriginOrUrl: string,
    openerOriginOrUrl?: string,
  ): boolean;
  isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel;
}

const ALLOWED_CLIPBOARD_PERMISSIONS = new Set<string>([
  'clipboard-read',
  'clipboard-sanitized-write',
]);

export function createDesktopWindowSecurityPolicy(
  localLoopbackOrigin = 'http://127.0.0.1:4310',
): DesktopWindowSecurityPolicy {
  const parsedOrigin = new URL(localLoopbackOrigin);
  if (parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== '127.0.0.1') {
    throw new Error(
      'DesktopSecurityError: localLoopbackOrigin must bind strictly to http://127.0.0.1',
    );
  }
  const normalizedOrigin = parsedOrigin.origin;

  const isAllowedLoopbackUrl = (targetUrl: string): boolean => {
    try {
      const parsed = new URL(targetUrl);
      return parsed.origin === normalizedOrigin;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    allowedOrigin: normalizedOrigin,
    isAllowedNavigationUrl(targetUrl: string): boolean {
      return isAllowedLoopbackUrl(targetUrl);
    },
    isAllowedChildNavigationUrl(targetUrl: string): boolean {
      return isAllowedLoopbackUrl(targetUrl);
    },
    isAllowedPermissionRequest(
      permission: string,
      requestingOriginOrUrl: string,
      openerOriginOrUrl?: string,
    ): boolean {
      if (!ALLOWED_CLIPBOARD_PERMISSIONS.has(permission)) {
        return false;
      }
      if (isAllowedLoopbackUrl(requestingOriginOrUrl)) {
        return true;
      }
      if (
        requestingOriginOrUrl === 'about:blank' &&
        typeof openerOriginOrUrl === 'string' &&
        isAllowedLoopbackUrl(openerOriginOrUrl)
      ) {
        return true;
      }
      return false;
    },
    isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel {
      return ALLOWED_IPC_CHANNEL_SET.has(channel);
    },
  });
}

export interface DesktopDataPaths {
  readonly userDataDir: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly backupDir: string;
  readonly dailyBackupDir: string;
}

export function resolveDesktopDataPaths(userDataDir: string): DesktopDataPaths {
  const trimmed = userDataDir.trim();
  if (!trimmed) {
    throw new Error('DesktopPathError: userDataDir must be a non-empty directory path');
  }
  const resolvedUserData = resolve(trimmed);
  const dataDir = join(resolvedUserData, 'data');
  const backupDir = join(dataDir, 'backups');
  return Object.freeze({
    userDataDir: resolvedUserData,
    dataDir,
    databasePath: join(dataDir, 'retailos.sqlite'),
    backupDir,
    dailyBackupDir: join(backupDir, 'daily'),
  });
}

export function buildServerProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  paths: DesktopDataPaths,
  port: number,
  options?: {
    readonly runAsNode?: boolean | undefined;
    readonly desktopVersion?: string | undefined;
  },
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    PORT: String(port),
    RETAILOS_DATA_DIR: paths.dataDir,
    RETAILOS_DB_PATH: paths.databasePath,
    RETAILOS_BACKUP_DIR: paths.backupDir,
  };
  delete nextEnv.RETAILOS_WATERMARK_SECRET;
  delete nextEnv.RETAILOS_DAILY_BACKUP_KEY;
  delete nextEnv.RETAILOS_TEST_LICENSE_PUBLIC_KEY;
  delete nextEnv.RETAILOS_TEST_CLOCK_FILE;
  if (options?.runAsNode) {
    nextEnv.NODE_ENV = 'production';
    nextEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  if (options?.desktopVersion) {
    nextEnv.RETAILOS_DESKTOP_VERSION = options.desktopVersion;
  }
  return nextEnv;
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const DPAPI_REQUIRED_ERROR_AR =
  'تعذر تهيئة الحماية الآمنة لنظام التشغيل (Windows DPAPI غير متاح). لا يمكن تشغيل النظام بأمان دون تشفير مفاتيح التفعيل والنسخ الاحتياطي.';

export const CLOCK_ADVANCE_STDOUT_PREFIX = '__RETAILOS_CLOCK_ADVANCE__:';
export const DAILY_KEY_UPDATE_STDOUT_PREFIX = '__RETAILOS_DAILY_KEY_UPDATE__:';
export const DAILY_KEY_UPDATE_REQ_STDOUT_PREFIX = '__RETAILOS_DAILY_KEY_UPDATE_REQ__:';
export const DAILY_KEY_UPDATE_ACK_STDIN_PREFIX = '__RETAILOS_DAILY_KEY_UPDATE_ACK__:';
const DAILY_BACKUP_SECRET_PATTERN = /^[^\p{Cc}]{12,256}$/u;

export interface DailyBackupSecretUpdateResult {
  readonly updated?: boolean | undefined;
  readonly historyCount?: number | undefined;
}

export type DailyBackupSecretUpdateHandler = (
  nextSecret: string,
) => DailyBackupSecretUpdateResult | void | Promise<DailyBackupSecretUpdateResult | void>;

function shouldFailClosedOnMissingDpapi(requireDpapi?: boolean): boolean {
  if (typeof requireDpapi === 'boolean') {
    return requireDpapi;
  }
  return process.platform === 'win32' && process.env.NODE_ENV === 'production';
}

async function atomicWriteFile(filePath: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tempPath, data, typeof data === 'string' ? { encoding: 'utf8', mode } : { mode });
  await rename(tempPath, filePath);
}

async function resolveOrCreateDpapiSecret(options: {
  readonly userDataDir: string;
  readonly dpapiFilename: string;
  readonly fallbackFilename: string;
  readonly encoding: 'hex' | 'base64url';
  readonly pattern: RegExp;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
  readonly legacyPlaintextKeyPath?: string | undefined;
}): Promise<string> {
  const userDataDir = resolve(options.userDataDir);
  await mkdir(userDataDir, { recursive: true });
  const dpapiFilePath = join(userDataDir, options.dpapiFilename);
  const fallbackKeyPath = join(userDataDir, options.fallbackFilename);
  const dpapi = options.safeStorage;

  if (dpapi && dpapi.isEncryptionAvailable()) {
    if (existsSync(dpapiFilePath)) {
      try {
        const encrypted = await readFile(dpapiFilePath);
        const decrypted = dpapi.decryptString(encrypted).trim();
        if (options.pattern.test(decrypted)) {
          if (options.legacyPlaintextKeyPath && existsSync(options.legacyPlaintextKeyPath)) {
            await rm(options.legacyPlaintextKeyPath, { force: true }).catch(() => undefined);
          }
          return decrypted;
        }
      } catch {
        // Corrupted or foreign DPAPI blob: generate fresh secret below (existing SQLite HMAC fails closed).
      }
    }

    let secretToSeal: string | null = null;
    let hasLegacyFileToRemove = false;
    if (options.legacyPlaintextKeyPath && existsSync(options.legacyPlaintextKeyPath)) {
      try {
        const legacy = (await readFile(options.legacyPlaintextKeyPath, 'utf8')).trim();
        if (options.pattern.test(legacy)) {
          secretToSeal = legacy;
          hasLegacyFileToRemove = true;
        }
      } catch {
        secretToSeal = null;
      }
    }
    const finalSecret = secretToSeal ?? randomBytes(32).toString(options.encoding);
    const encryptedBlob = dpapi.encryptString(finalSecret);
    await atomicWriteFile(dpapiFilePath, encryptedBlob);
    if (hasLegacyFileToRemove && options.legacyPlaintextKeyPath) {
      await rm(options.legacyPlaintextKeyPath, { force: true }).catch(() => undefined);
    }
    return finalSecret;
  }

  if (shouldFailClosedOnMissingDpapi(options.requireDpapi)) {
    throw new Error(DPAPI_REQUIRED_ERROR_AR);
  }

  if (existsSync(fallbackKeyPath)) {
    const existing = (await readFile(fallbackKeyPath, 'utf8')).trim();
    if (options.pattern.test(existing)) {
      return existing;
    }
  }
  const generated = randomBytes(32).toString(options.encoding);
  await atomicWriteFile(fallbackKeyPath, `${generated}\n`);
  return generated;
}

/**
 * Generates (once per install) and protects the per-install license watermark HMAC key
 * in `<userData>/license-watermark.bin` via Windows DPAPI (`safeStorage`).
 * Fails closed on Windows production if DPAPI is unavailable.
 */
export function resolveOrCreateDesktopWatermarkSecret(options: {
  readonly userDataDir: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
  readonly legacyPlaintextKeyPath?: string | undefined;
}): Promise<string> {
  return resolveOrCreateDpapiSecret({
    userDataDir: options.userDataDir,
    dpapiFilename: 'license-watermark.bin',
    fallbackFilename: '.retailos-watermark.key',
    encoding: 'hex',
    pattern: /^[0-9a-f]{64}$/i,
    safeStorage: options.safeStorage,
    requireDpapi: options.requireDpapi,
    legacyPlaintextKeyPath: options.legacyPlaintextKeyPath,
  });
}

/**
 * Generates (once per install) and protects the automatic daily backup passphrase
 * in `<userData>/daily-backup.bin` via Windows DPAPI (`safeStorage`).
 */
export function resolveOrCreateDesktopDailyBackupSecret(options: {
  readonly userDataDir: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
  readonly legacyPlaintextKeyPath?: string | undefined;
}): Promise<string> {
  return resolveOrCreateDpapiSecret({
    userDataDir: options.userDataDir,
    dpapiFilename: 'daily-backup.bin',
    fallbackFilename: '.retailos-daily.key',
    encoding: 'base64url',
    pattern: DAILY_BACKUP_SECRET_PATTERN,
    safeStorage: options.safeStorage,
    requireDpapi: options.requireDpapi,
    legacyPlaintextKeyPath: options.legacyPlaintextKeyPath,
  });
}

function normalizeDailyBackupHistoryList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (DAILY_BACKUP_SECRET_PATTERN.test(trimmed)) {
        unique.add(trimmed);
      }
    }
  }
  return Array.from(unique);
}

/**
 * Reads DPAPI-sealed historical daily backup passphrases preserved across key rotations
 * so older daily `.rfbackup` archives remain recoverable on the same PC and exportable.
 */
export async function readDesktopDailyBackupHistory(options: {
  readonly userDataDir: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
}): Promise<string[]> {
  const userDataDir = resolve(options.userDataDir);
  const keyringPath = join(userDataDir, 'daily-backup-keyring.bin');
  const dpapi = options.safeStorage;

  if (shouldFailClosedOnMissingDpapi(options.requireDpapi) && (!dpapi || !dpapi.isEncryptionAvailable())) {
    throw new Error(DPAPI_REQUIRED_ERROR_AR);
  }
  if (!existsSync(keyringPath)) {
    return [];
  }
  try {
    const rawBytes = await readFile(keyringPath);
    const jsonText =
      dpapi && dpapi.isEncryptionAvailable()
        ? dpapi.decryptString(rawBytes)
        : rawBytes.toString('utf8');
    return normalizeDailyBackupHistoryList(JSON.parse(jsonText));
  } catch {
    return [];
  }
}

async function readCurrentDailyBackupSecretIfExists(options: {
  readonly userDataDir: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
}): Promise<string | null> {
  const userDataDir = resolve(options.userDataDir);
  const dpapiFilePath = join(userDataDir, 'daily-backup.bin');
  const fallbackKeyPath = join(userDataDir, '.retailos-daily.key');
  const dpapi = options.safeStorage;
  if (dpapi && dpapi.isEncryptionAvailable() && existsSync(dpapiFilePath)) {
    try {
      const decrypted = dpapi.decryptString(await readFile(dpapiFilePath)).trim();
      if (DAILY_BACKUP_SECRET_PATTERN.test(decrypted)) {
        return decrypted;
      }
    } catch {
      return null;
    }
  }
  if ((!dpapi || !dpapi.isEncryptionAvailable()) && existsSync(fallbackKeyPath)) {
    try {
      const fallback = (await readFile(fallbackKeyPath, 'utf8')).trim();
      if (DAILY_BACKUP_SECRET_PATTERN.test(fallback)) {
        return fallback;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Updates the active DPAPI-sealed daily backup master passphrase while preserving any
 * previous key(s) inside `daily-backup-keyring.bin` BEFORE overwriting `daily-backup.bin`.
 */
export async function updateDesktopDailyBackupSecret(options: {
  readonly userDataDir: string;
  readonly dailyBackupSecret: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
}): Promise<{ readonly updated: boolean; readonly historyCount: number }> {
  const nextSecret = options.dailyBackupSecret.trim();
  if (!DAILY_BACKUP_SECRET_PATTERN.test(nextSecret)) {
    throw new Error('كلمة مرور النسخ الاحتياطي الرئيسية يجب أن تكون بين 12 و 256 حرفًا صالحًا');
  }

  const userDataDir = resolve(options.userDataDir);
  const dpapi = options.safeStorage;
  if (shouldFailClosedOnMissingDpapi(options.requireDpapi) && (!dpapi || !dpapi.isEncryptionAvailable())) {
    throw new Error(DPAPI_REQUIRED_ERROR_AR);
  }

  await mkdir(userDataDir, { recursive: true });
  const existingSecret = await readCurrentDailyBackupSecretIfExists({
    userDataDir,
    safeStorage: dpapi,
  });
  const history = await readDesktopDailyBackupHistory({
    userDataDir,
    safeStorage: dpapi,
    requireDpapi: options.requireDpapi,
  });

  const preservedSet = new Set<string>(history);
  if (existingSecret && existingSecret !== nextSecret) {
    preservedSet.add(existingSecret);
  }
  const nextHistory = Array.from(preservedSet);

  // Persist historical keyring BEFORE overwriting daily-backup.bin so no existing key is ever lost.
  if (nextHistory.length > history.length) {
    const keyringPath = join(userDataDir, 'daily-backup-keyring.bin');
    const serialized = JSON.stringify(nextHistory);
    const encodedHistory: Buffer | string =
      dpapi && dpapi.isEncryptionAvailable() ? dpapi.encryptString(serialized) : serialized;
    await atomicWriteFile(keyringPath, encodedHistory);
  }

  if (dpapi && dpapi.isEncryptionAvailable()) {
    await atomicWriteFile(join(userDataDir, 'daily-backup.bin'), dpapi.encryptString(nextSecret));
  } else {
    await atomicWriteFile(join(userDataDir, '.retailos-daily.key'), `${nextSecret}\n`);
  }

  return {
    updated: existingSecret !== nextSecret,
    historyCount: nextHistory.length,
  };
}

function computeExternalClockHmac(watermarkSecret: string, clockMs: number): string {
  return createHmac('sha256', Buffer.from(watermarkSecret, 'utf8'))
    .update(`RetailOS-External-Clock-v1:${String(clockMs)}`)
    .digest('hex');
}

export interface ExternalClockReadResult {
  readonly clockMs: number | null;
  readonly tampered: boolean;
}

export async function readExternalClockWatermark(options: {
  readonly userDataDir: string;
  readonly watermarkSecret: string;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
}): Promise<ExternalClockReadResult> {
  const clockFilePath = join(resolve(options.userDataDir), 'license-clock.dat');
  if (!existsSync(clockFilePath)) {
    return { clockMs: null, tampered: false };
  }

  const dpapi = options.safeStorage;
  if (shouldFailClosedOnMissingDpapi(options.requireDpapi) && (!dpapi || !dpapi.isEncryptionAvailable())) {
    throw new Error(DPAPI_REQUIRED_ERROR_AR);
  }

  try {
    const rawBytes = await readFile(clockFilePath);
    const jsonText =
      dpapi && dpapi.isEncryptionAvailable()
        ? dpapi.decryptString(rawBytes)
        : rawBytes.toString('utf8');
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const clockMs = parsed?.clockMs;
    const hmac = parsed?.hmac;
    if (
      typeof clockMs !== 'number' ||
      !globalThis.Number.isSafeInteger(clockMs) ||
      clockMs <= 0 ||
      typeof hmac !== 'string'
    ) {
      return { clockMs: null, tampered: true };
    }
    const expected = computeExternalClockHmac(options.watermarkSecret, clockMs);
    const actualBuf = Buffer.from(hmac, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      return { clockMs: null, tampered: true };
    }
    return { clockMs, tampered: false };
  } catch {
    return { clockMs: null, tampered: true };
  }
}

export async function writeExternalClockWatermark(options: {
  readonly userDataDir: string;
  readonly watermarkSecret: string;
  readonly clockMs: number;
  readonly safeStorage?: SafeStorageAdapter | undefined;
  readonly requireDpapi?: boolean | undefined;
}): Promise<void> {
  if (!globalThis.Number.isSafeInteger(options.clockMs) || options.clockMs <= 0) {
    return;
  }

  const dpapi = options.safeStorage;
  if (shouldFailClosedOnMissingDpapi(options.requireDpapi) && (!dpapi || !dpapi.isEncryptionAvailable())) {
    throw new Error(DPAPI_REQUIRED_ERROR_AR);
  }

  const existing = await readExternalClockWatermark({
    userDataDir: options.userDataDir,
    watermarkSecret: options.watermarkSecret,
    safeStorage: options.safeStorage,
    requireDpapi: options.requireDpapi,
  });
  if (existing.tampered) {
    // Do not overwrite an already tampered external clock file automatically.
    return;
  }
  if (existing.clockMs !== null && existing.clockMs >= options.clockMs) {
    return;
  }

  await mkdir(resolve(options.userDataDir), { recursive: true });
  const clockFilePath = join(resolve(options.userDataDir), 'license-clock.dat');
  const payload = JSON.stringify({
    clockMs: options.clockMs,
    hmac: computeExternalClockHmac(options.watermarkSecret, options.clockMs),
  });
  const encoded: Buffer | string =
    dpapi && dpapi.isEncryptionAvailable() ? dpapi.encryptString(payload) : payload;
  await atomicWriteFile(clockFilePath, encoded);
}

async function listRuntimeCodeFiles(dirPath: string, baseDir = dirPath, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'integrity-manifest.json') {
      continue;
    }
    const fullPath = join(dirPath, entry.name);
    if (entry.name === 'node_modules') {
      if (dirPath === baseDir) {
        const retailosScopeDir = join(fullPath, '@retailos');
        if (existsSync(retailosScopeDir)) {
          await listRuntimeCodeFiles(retailosScopeDir, baseDir, acc);
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      await listRuntimeCodeFiles(fullPath, baseDir, acc);
      continue;
    }
    if (
      entry.name.endsWith('.mjs') ||
      entry.name.endsWith('.js') ||
      entry.name.endsWith('.html')
    ) {
      acc.push(fullPath.slice(baseDir.length + 1).replace(/\\/g, '/'));
    }
  }
  return acc;
}

export async function verifyStagedRuntimeIntegrity(options: {
  readonly webDir: string;
  readonly publicKeyPem?: string | undefined;
  readonly requireManifest?: boolean | undefined;
}): Promise<{ readonly checked: boolean; readonly verifiedFiles: number }> {
  const webDir = resolve(options.webDir);
  const manifestPath = join(webDir, 'integrity-manifest.json');
  if (!existsSync(manifestPath)) {
    if (options.requireManifest) {
      throw new Error('ملف التحقق من سلامة البرنامج (integrity-manifest.json) مفقود');
    }
    return { checked: false, verifiedFiles: 0 };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('تعذر قراءة ملف التحقق من سلامة البرنامج (integrity-manifest.json)');
  }

  if (
    parsed.version !== 1 ||
    parsed.algorithm !== 'sha256' ||
    !parsed.files ||
    typeof parsed.files !== 'object' ||
    Array.isArray(parsed.files) ||
    typeof parsed.signature !== 'string'
  ) {
    throw new Error('تنسيق ملف التحقق من سلامة البرنامج (integrity-manifest.json) غير صالح');
  }

  const rawFiles = parsed.files as Record<string, unknown>;
  const sortedKeys = Object.keys(rawFiles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!sortedKeys.includes('server.mjs')) {
    throw new Error('ملف التحقق من سلامة البرنامج يفتقد الملف الأساسي للخادم');
  }

  const sortedFiles: Record<string, string> = {};
  for (const key of sortedKeys) {
    const val = rawFiles[key];
    if (typeof val !== 'string' || !/^[0-9a-f]{64}$/i.test(val)) {
      throw new Error(`قيمة البصمة الرقمية غير صالحة للملف: ${key}`);
    }
    sortedFiles[key] = val.toLowerCase();
  }

  const canonicalPayload = JSON.stringify({
    version: 1,
    algorithm: 'sha256',
    files: sortedFiles,
  });
  const pubKey = createPublicKey((options.publicKeyPem ?? EMBEDDED_LICENSE_PUBLIC_KEY_PEM).trim());
  const sigBytes = Buffer.from(parsed.signature, 'base64url');
  const signatureOk = verify(
    null,
    Buffer.from(`ROS-MANIFEST-V1:${canonicalPayload}`, 'utf8'),
    pubKey,
    sigBytes,
  );
  if (!signatureOk) {
    throw new Error('تم العبث بملفات التشغيل: التوقيع الرقمي لـ integrity-manifest.json غير مطابق');
  }

  for (const relPath of sortedKeys) {
    const resolvedTarget = resolve(webDir, relPath);
    if (!resolvedTarget.startsWith(`${webDir}${sep}`) && resolvedTarget !== webDir) {
      throw new Error(`مسار ملف غير مسموح في manifest: ${relPath}`);
    }
    if (!existsSync(resolvedTarget)) {
      throw new Error(`تم حذف ملف تشغيل أساسي: ${relPath}`);
    }
    const actualHash = createHash('sha256')
      .update(await readFile(resolvedTarget))
      .digest('hex')
      .toLowerCase();
    if (actualHash !== sortedFiles[relPath]) {
      throw new Error(`تم تعديل ملف تشغيل محمي (${relPath}) وتوقفت الحماية عن الإقلاع`);
    }
  }

  const diskCodeFiles = await listRuntimeCodeFiles(webDir);
  for (const relFile of diskCodeFiles) {
    if (!Object.prototype.hasOwnProperty.call(sortedFiles, relFile)) {
      throw new Error(`تم رصد ملف برمجي غير موقّع داخل حزمة التشغيل: ${relFile}`);
    }
  }

  return { checked: true, verifiedFiles: sortedKeys.length };
}

export async function isPortFreeOnLoopback(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  return new Promise<boolean>((resolvePromise) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => {
      resolvePromise(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

export async function resolveAvailableLoopbackPort(
  preferredPort = DEFAULT_DESKTOP_PORT,
): Promise<number> {
  if (await isPortFreeOnLoopback(preferredPort)) {
    return preferredPort;
  }
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => rejectPromise(error));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
        probe.close(() =>
          rejectPromise(new Error('Failed to allocate a loopback port for RetailOS server')),
        );
        return;
      }
      const allocatedPort = address.port;
      probe.close((closeError) => {
        if (closeError) {
          rejectPromise(closeError);
          return;
        }
        resolvePromise(allocatedPort);
      });
    });
  });
}

export interface BootstrapIdentityCheckResult {
  readonly ok: boolean;
  readonly configured?: boolean | undefined;
  readonly companyName?: string | undefined;
  readonly companyCode?: string | undefined;
}

export async function verifyBootstrapIdentity(
  origin: string,
  timeoutMs = 1500,
): Promise<BootstrapIdentityCheckResult> {
  try {
    const response = await fetch(`${origin}/api/bootstrap`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { ok: false };
    }
    const payload = (await response.json()) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || typeof payload.configured !== 'boolean') {
      return { ok: false };
    }
    return {
      ok: true,
      configured: payload.configured,
      companyName: typeof payload.companyName === 'string' ? payload.companyName : undefined,
      companyCode: typeof payload.companyCode === 'string' ? payload.companyCode : undefined,
    };
  } catch {
    return { ok: false };
  }
}

export async function waitForServerReady(options: {
  readonly origin: string;
  readonly child: ChildProcess;
  readonly logs?: readonly string[] | undefined;
  readonly maxAttempts?: number | undefined;
  readonly intervalMs?: number | undefined;
}): Promise<BootstrapIdentityCheckResult> {
  const maxAttempts = options.maxAttempts ?? 240;
  const intervalMs = options.intervalMs ?? 125;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.child.exitCode !== null) {
      const tail = options.logs ? options.logs.slice(-25).join('') : '';
      throw new Error(
        `Embedded RetailOS server exited prematurely with code ${String(options.child.exitCode)}.${tail ? `\n${tail}` : ''}`,
      );
    }
    const identity = await verifyBootstrapIdentity(options.origin);
    if (identity.ok) {
      return identity;
    }
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, intervalMs);
      timer.unref();
    });
  }

  const tail = options.logs ? options.logs.slice(-25).join('') : '';
  throw new Error(
    `Timed out waiting for embedded RetailOS server at ${options.origin}.${tail ? `\n${tail}` : ''}`,
  );
}

interface ControlFileState {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

async function readControlFileState(dataDir: string): Promise<ControlFileState | null> {
  try {
    const raw = await readFile(join(dataDir, '.retailos-control.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.port === 'number' &&
      Number.isSafeInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return {
        pid: parsed.pid,
        port: parsed.port,
        token: parsed.token,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceTerminatePid(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => resolvePromise(),
      );
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
}

export async function stopManagedServerProcess(options: {
  readonly child: ChildProcess | null;
  readonly dataDir: string;
  readonly origin: string;
  readonly timeoutMs?: number | undefined;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const control = await readControlFileState(options.dataDir);
  const trackedPids = new Set<number>();
  if (options.child?.pid && Number.isSafeInteger(options.child.pid) && options.child.pid > 0) {
    trackedPids.add(options.child.pid);
  }
  if (control) {
    trackedPids.add(control.pid);
  }

  if (control) {
    const controlOrigin = `http://127.0.0.1:${String(control.port)}`;
    try {
      await fetch(`${controlOrigin}/api/internal/shutdown`, {
        method: 'POST',
        headers: {
          Origin: controlOrigin,
          'x-retailos-shutdown-token': control.token,
        },
        signal: AbortSignal.timeout(2500),
      });
    } catch {
      // Fall back to process signals below.
    }
  }

  if (options.child && options.child.exitCode === null) {
    await Promise.race([
      once(options.child, 'exit').catch(() => undefined),
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, timeoutMs);
        timer.unref();
      }),
    ]);
  }

  const pollDeadline = Date.now() + 1500;
  while (Date.now() < pollDeadline) {
    const anyAlive = Array.from(trackedPids).some((pid) => isProcessAlive(pid));
    if (!anyAlive) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 100);
      timer.unref();
    });
  }

  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore already dead process.
      }
    }
  }

  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 500);
    timer.unref();
  });

  for (const pid of trackedPids) {
    await forceTerminatePid(pid);
  }
}

export function startManagedServerChild(options: {
  readonly execPath: string;
  readonly serverScriptPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly watermarkSecret: string;
  readonly dailyBackupSecret?: string | undefined;
  readonly dailyBackupKeyHistory?: readonly string[] | undefined;
  readonly externalClockMs?: number | null | undefined;
  readonly externalClockTampered?: boolean | undefined;
  readonly onClockAdvance?: ((clockMs: number) => void) | undefined;
  readonly onDailyBackupSecretUpdate?: DailyBackupSecretUpdateHandler | undefined;
}): { readonly child: ChildProcess; readonly logs: string[] } {
  const logs: string[] = [];
  const appendLog = (chunk: Buffer | string) => {
    logs.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (logs.length > 200) {
      logs.shift();
    }
  };

  const child = spawn(options.execPath, [options.serverScriptPath, '--electron-stdio-secret'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (!child.stdin) {
    throw new Error('Failed to open private stdin pipe for RetailOS watermark secret');
  }
  const childStdin = child.stdin;
  childStdin.on('error', () => undefined);

  let dailyKeyAckQueue: Promise<void> = Promise.resolve();
  const sendDailyKeyAck = (payload: {
    readonly requestId: string;
    readonly ok: boolean;
    readonly historyCount?: number | undefined;
    readonly error?: string | undefined;
  }): void => {
    if (childStdin.destroyed || !childStdin.writable) {
      return;
    }
    try {
      childStdin.write(`${DAILY_KEY_UPDATE_ACK_STDIN_PREFIX}${JSON.stringify(payload)}\n`);
    } catch {
      // Child stdin pipe may already be closed during teardown.
    }
  };

  let stdoutBuffer = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.startsWith(CLOCK_ADVANCE_STDOUT_PREFIX)) {
        const rawDigits = line.slice(CLOCK_ADVANCE_STDOUT_PREFIX.length).trim();
        if (/^\d{10,16}$/.test(rawDigits)) {
          const parsedMs = globalThis.Number.parseInt(rawDigits, 10);
          if (globalThis.Number.isSafeInteger(parsedMs) && parsedMs > 0) {
            options.onClockAdvance?.(parsedMs);
          }
        }
      } else if (line.startsWith(DAILY_KEY_UPDATE_REQ_STDOUT_PREFIX)) {
        const rawReq = line.slice(DAILY_KEY_UPDATE_REQ_STDOUT_PREFIX.length).trim();
        let requestId = '';
        let decodedKey = '';
        let requestValid = false;
        if (rawReq.length > 0 && rawReq.length <= 2048) {
          try {
            const parsedReq = JSON.parse(rawReq) as Record<string, unknown>;
            if (
              parsedReq &&
              typeof parsedReq === 'object' &&
              typeof parsedReq.requestId === 'string' &&
              parsedReq.requestId.trim().length > 0 &&
              parsedReq.requestId.trim().length <= 128 &&
              typeof parsedReq.key === 'string' &&
              parsedReq.key.trim().length >= 16 &&
              parsedReq.key.trim().length <= 512
            ) {
              requestId = parsedReq.requestId.trim();
              const candidateDecoded = Buffer.from(parsedReq.key.trim(), 'base64url')
                .toString('utf8')
                .trim();
              if (DAILY_BACKUP_SECRET_PATTERN.test(candidateDecoded)) {
                decodedKey = candidateDecoded;
                requestValid = true;
              }
            }
          } catch {
            requestValid = false;
          }
        }
        if (!requestValid) {
          if (requestId) {
            sendDailyKeyAck({
              requestId,
              ok: false,
              error: 'طلب حفظ مفتاح النسخ الاحتياطي غير صالح',
            });
          }
        } else {
          const capturedRequestId = requestId;
          const capturedKey = decodedKey;
          dailyKeyAckQueue = dailyKeyAckQueue.then(async () => {
            if (!options.onDailyBackupSecretUpdate) {
              sendDailyKeyAck({
                requestId: capturedRequestId,
                ok: false,
                error: 'معالج حفظ مفتاح النسخ الاحتياطي غير متاح في التطبيق الرئيسي',
              });
              return;
            }
            try {
              const persistResult = await options.onDailyBackupSecretUpdate(capturedKey);
              sendDailyKeyAck({
                requestId: capturedRequestId,
                ok: true,
                ...(persistResult &&
                typeof persistResult === 'object' &&
                typeof persistResult.historyCount === 'number'
                  ? { historyCount: persistResult.historyCount }
                  : {}),
              });
            } catch (persistError) {
              sendDailyKeyAck({
                requestId: capturedRequestId,
                ok: false,
                error:
                  persistError instanceof Error ? persistError.message : String(persistError),
              });
            }
          });
        }
      } else if (line.startsWith(DAILY_KEY_UPDATE_STDOUT_PREFIX)) {
        const encoded = line.slice(DAILY_KEY_UPDATE_STDOUT_PREFIX.length).trim();
        if (encoded.length >= 16 && encoded.length <= 512) {
          try {
            const decoded = Buffer.from(encoded, 'base64url').toString('utf8').trim();
            if (DAILY_BACKUP_SECRET_PATTERN.test(decoded)) {
              void Promise.resolve(options.onDailyBackupSecretUpdate?.(decoded)).catch(
                () => undefined,
              );
            }
          } catch {
            // Ignore malformed daily backup update signal
          }
        }
      } else if (line.length > 0) {
        appendLog(`${line}\n`);
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', appendLog);

  // Keep stdin open after startup handshake so the host can send ACK responses for key rotations.
  childStdin.write(
    `${JSON.stringify({
      watermarkSecret: options.watermarkSecret,
      supportsKeyPersistAck: true,
      ...(options.dailyBackupSecret ? { dailyBackupSecret: options.dailyBackupSecret } : {}),
      ...(options.dailyBackupKeyHistory && options.dailyBackupKeyHistory.length > 0
        ? { dailyBackupKeyHistory: options.dailyBackupKeyHistory }
        : {}),
      ...(typeof options.externalClockMs === 'number' && options.externalClockMs > 0
        ? { externalClockMs: options.externalClockMs }
        : {}),
      ...(options.externalClockTampered ? { externalClockTampered: true } : {}),
    })}\n`,
  );
  child.once('exit', () => {
    try {
      if (!childStdin.destroyed) {
        childStdin.end();
      }
    } catch {
      // Ignore already closed stdin pipe.
    }
  });

  return { child, logs };
}
