import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Transform } from 'node:stream';
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  verifySqliteFile,
  EscPosReceiptPrinter,
  businessDateInTimeZone,
  resolveValidTimeZone,
  postJournalEntry,
  applyStockMovementInTransaction,
} from '@retailos/infrastructure';
import { CreateProductSchema, CreateUserSchema, UpdateProductSchema } from '@retailos/shared';
import { z } from 'zod';

const appDir = dirname(fileURLToPath(import.meta.url));
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
const databasePath = join(dataDir, 'retailos.sqlite');
const dailyBackupDir = join(dataDir, 'backups', 'daily');
const dailyBackupKeyPath = join(dataDir, '.retailos-daily.key');
const preRestoreBackupDir = join(dataDir, 'backups', 'pre-restore');
const quarantineBackupDir = join(dataDir, 'backups', 'quarantine');
const backupSettingsPath = join(dataDir, 'backup-settings.json');
const MAX_DAILY_BACKUPS = 30;
const AUTO_DAILY_REFRESH_MS = 30 * 60 * 1000;
await mkdir(dataDir, { recursive: true });
await mkdir(dailyBackupDir, { recursive: true });
await mkdir(preRestoreBackupDir, { recursive: true });
const restoredAfterCrash = await recoverPendingSqliteRestore(dataDir, databasePath, companyConfig.code);

function resolveDailyBackupPassphraseSync() {
  const envKey = (process.env.RETAILOS_DAILY_BACKUP_KEY ?? '').trim();
  if (envKey.length >= 12) return envKey.slice(0, 256);
  if (existsSync(dailyBackupKeyPath)) {
    const existing = readFileSync(dailyBackupKeyPath, 'utf8').trim();
    if (existing.length >= 12) return existing.slice(0, 256);
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(dailyBackupKeyPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  return generated;
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
      try {
        const passphrase = resolveDailyBackupPassphraseSync();
        const archive = await readFile(item.path);
        const { decryptBackupArchive } = await import('@retailos/infrastructure');
        const sqliteBytes = decryptBackupArchive(archive, passphrase);
        const tempWork = await mkdtemp(join(quarantineBackupDir, 'recover-'));
        const decryptedPath = join(tempWork, 'candidate.sqlite');
        await writeFile(decryptedPath, sqliteBytes, { mode: 0o600 });
        const quick = checkSqliteFileQuick(decryptedPath);
        if (quick.ok) return { ...item, path: decryptedPath, cleanupDir: tempWork };
        await rm(tempWork, { recursive: true, force: true }).catch(() => undefined);
      } catch { /* try older candidate */ }
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
  const run = async (executor) => {
    const existingRows = await executor
      .selectFrom(existingTable)
      .select(`${existingCol} as num`)
      .where('tenant_id', '=', tenantId)
      .where(existingCol, 'is not', null)
      .execute();
    let maxExisting = 1000;
    const prefixRe = new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\d+)$`);
    for (const row of existingRows) {
      const m = String(row.num ?? '').match(prefixRe);
      if (m) {
        const parsed = Number.parseInt(m[1], 10);
        if (Number.isFinite(parsed) && parsed > maxExisting) maxExisting = parsed;
      }
    }
    await executor
      .insertInto('document_sequences')
      .values({ tenant_id: tenantId, doc_type: docType, last_seq: maxExisting })
      .onConflict((oc) => oc.columns(['tenant_id', 'doc_type']).doNothing())
      .execute();

    const bumped = await executor
      .updateTable('document_sequences')
      .set((eb) => ({ last_seq: eb(eb.ref('last_seq'), '+', 1) }))
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', docType)
      .returning('last_seq')
      .executeTakeFirst();
    let seq = Number(bumped?.last_seq ?? maxExisting + 1);
    while (
      await executor
        .selectFrom(existingTable)
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where(existingCol, '=', `${prefix}${seq}`)
        .executeTakeFirst()
    ) {
      const nextBump = await executor
        .updateTable('document_sequences')
        .set((eb) => ({ last_seq: eb(eb.ref('last_seq'), '+', 1) }))
        .where('tenant_id', '=', tenantId)
        .where('doc_type', '=', docType)
        .returning('last_seq')
        .executeTakeFirst();
      seq = Number(nextBump?.last_seq ?? seq + 1);
    }
    return `${prefix}${seq}`;
  };
  return trx ? run(trx) : db.transaction().execute(run);
}

function generateNextSaleNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'SALE', 'INV-', 'sales', 'sale_number', trx);
}

function generateNextPurchaseNumber(tenantId, trx = null) {
  return allocateNextDocNumber(tenantId, 'PURCHASE', 'PUR-', 'supplier_purchases', 'invoice_number', trx);
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
});
const CheckoutSchema = z.object({
  storeId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  customerName: z.string().max(120).trim().optional(),
  cartDiscount: z.string().regex(/^\d{1,15}$/).optional(),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.string().regex(/^[1-9]\d{0,8}$/),
    lineDiscount: z.string().regex(/^\d{1,15}$/).optional(),
  })).min(1).max(100),
  payment: z.object({ method: z.enum(['CASH', 'CARD', 'MOBILE', 'OTHER']), amount: z.string().regex(/^\d{1,15}$/) }),
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
const PurchaseSchema = z.object({ idempotencyKey: z.string().uuid(), supplierId: z.string().uuid(), storeId: z.string().uuid(), invoiceNumber: z.string().max(80).trim().optional(), totalAmount: z.string().regex(/^[1-9]\d{0,14}$/), paidAmount: z.string().regex(/^\d{1,15}$/), paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']).default('CASH'), targetProfitPercent: z.number().min(0).max(100000).nullable().optional(), referenceNumber: z.string().max(80).trim().optional(), notes: z.string().max(500).trim().optional(), items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.string().regex(/^[1-9]\d{0,8}$/), unitCost: z.string().regex(/^\d{1,15}$/), retailPrice: z.string().regex(/^\d{1,15}$/).nullable().optional() })).min(1).max(100) });
const SupplierPaymentSchema = z.object({ idempotencyKey: z.string().uuid(), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']), referenceNumber: z.string().max(80).trim().optional() });
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
const PasswordChangeSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) });
const EmployeeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const EmployeePhoneSchema = z.string().trim().max(32).regex(/^[+0-9().\-\s]*$/);
const ShiftStartTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'صيغة موعد بدء الشيفت يجب أن تكون HH:MM');
const UpdateUserSchema = z.object({ fullName: z.string().min(2).max(100).trim().optional(), phone: EmployeePhoneSchema.nullable().optional(), employmentStartDate: EmployeeDateSchema.optional(), shiftStartTime: ShiftStartTimeSchema.nullable().optional(), lateGraceMinutes: z.number().int().min(0).max(180).optional(), role: z.enum(['OWNER', 'STORE_MANAGER', 'CASHIER', 'AUDITOR']).optional(), storeId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() }).refine((body) => Object.keys(body).length > 0);
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

function purchaseFilterSql({ tenantId, storeId, bounds = null, supplierId = null, search = '' }) {
  const conds = ['p.tenant_id = ?', 'p.store_id = ?'];
  const args = [tenantId, storeId];
  if (bounds) {
    conds.push("replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ?", "replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?");
    args.push(bounds.startIso, bounds.endExclusiveIso);
  }
  if (supplierId) { conds.push('p.supplier_id = ?'); args.push(supplierId); }
  if (search) {
    conds.push(`(instr(lower(coalesce(p.invoice_number, '')), lower(?)) > 0 OR instr(lower(coalesce(p.notes, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM supplier_purchase_items i WHERE i.tenant_id = p.tenant_id AND i.purchase_id = p.id AND (instr(lower(i.product_name), lower(?)) > 0 OR instr(lower(i.sku), lower(?)) > 0)))`);
    args.push(search, search, search, search);
  }
  return { where: conds.join(' AND '), args };
}

/** Full-history (or filtered) supplier totals computed in SQL: never limited by a page window. */
function supplierPurchaseAggregates(filter) {
  const { where, args } = purchaseFilterSql(filter);
  const rows = database.getRawDatabase().prepare(`
    SELECT p.supplier_id AS supplierId,
      COUNT(*) AS purchaseCount,
      COALESCE(SUM(p.total_amount), 0) AS totalAmount,
      COALESCE(SUM(p.initial_paid_amount), 0) AS initialPaid,
      COALESCE(SUM((SELECT COALESCE(SUM(sp.amount), 0) FROM supplier_payments sp WHERE sp.tenant_id = p.tenant_id AND sp.purchase_id = p.id)), 0) AS laterPaid,
      COALESCE(SUM((SELECT COALESCE(SUM(sr.credit_amount), 0) FROM supplier_returns sr WHERE sr.tenant_id = p.tenant_id AND sr.purchase_id = p.id)), 0) AS returnedCredit
    FROM supplier_purchases p
    WHERE ${where}
    GROUP BY p.supplier_id
  `).all(...args);
  const map = new Map();
  for (const row of rows) {
    const total = BigInt(row.totalAmount ?? 0);
    const paid = BigInt(row.initialPaid ?? 0) + BigInt(row.laterPaid ?? 0);
    const returned = BigInt(row.returnedCredit ?? 0);
    map.set(row.supplierId, { purchaseCount: Number(row.purchaseCount ?? 0), total, paid, returned, due: total - paid - returned });
  }
  return map;
}

function serializeSupplierSummary(supplier, totals, currency, purchases) {
  const t = totals ?? { purchaseCount: 0, total: 0n, paid: 0n, returned: 0n, due: 0n };
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    notes: supplier.notes,
    purchases,
    purchaseCount: t.purchaseCount,
    purchasesComplete: purchases.length >= t.purchaseCount,
    totalPurchased: t.total.toString(),
    totalPaid: t.paid.toString(),
    returnedCredit: t.returned.toString(),
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
    const purchaseReturns = returnsByPurchase.get(purchase.id) ?? [];
    const paid = BigInt(purchase.initial_paid_amount) + purchasePayments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
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
      payments: purchasePayments.map((payment) => ({ id: payment.id, amount: moneyJson(Money.fromMinor(BigInt(payment.amount), payment.currency)), paymentMethod: payment.payment_method, referenceNumber: payment.reference_number, paidAt: payment.paid_at, createdByUserId: payment.created_by_user_id, createdByName: userMap.get(payment.created_by_user_id) || 'المسؤول' })),
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
const MAX_FAILED_KEYS = 2000;

function getAuthFailures(scope, key) {
  const row = database.getRawDatabase().prepare('SELECT count, started_at AS startedAt FROM auth_rate_limits WHERE scope = ? AND key = ?').get(scope, key);
  return row ? { count: Number(row.count), startedAt: Number(row.startedAt) } : { count: 0, startedAt: Date.now() };
}

function recordAuthFailure(scope, key, windowMs = LOCK_WINDOW_MS) {
  const now = Date.now();
  const current = getAuthFailures(scope, key);
  const inWindow = now - current.startedAt < windowMs;
  const nextCount = (inWindow ? current.count : 0) + 1;
  const nextStart = inWindow ? current.startedAt : now;
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
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
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw Object.assign(new Error(result.error.issues.map((issue) => issue.message).join('، ')), { status: 400 });
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
  const minor = typeof minorValue === 'bigint' ? minorValue : BigInt(Math.trunc(Number(minorValue ?? 0)));
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
      total_surplus_cost: Number(totalSurplusCost),
      total_shortage_cost: Number(totalShortageCost),
      net_variance_cost: Number(netVarianceCost),
      net_variance_retail: Number(netVarianceRetail),
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

  let totalLines = lineRows.length;
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

async function requireContext(req) {
  const token = readCookie(req, 'retailos_session');
  if (!token) throw Object.assign(new Error('يلزم تسجيل الدخول'), { status: 401 });
  try {
    return await auth.validateSession(token, req.headers['x-request-id']);
  } catch {
    throw Object.assign(new Error('انتهت الجلسة. سجّل الدخول مرة أخرى.'), { status: 401 });
  }
}

function reportDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw Object.assign(new Error('Invalid report date'), { status: 400 });
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('Invalid report date'), { status: 400 });
  return parsed;
}

function dailyMonthlyShare(amount, daysInMonth, monthStart, from, to) {
  const first = Math.max(0, Math.floor((from.getTime() - monthStart.getTime()) / 86_400_000));
  const last = Math.min(daysInMonth - 1, Math.floor((to.getTime() - monthStart.getTime()) / 86_400_000));
  if (last < first) return 0n;
  const base = amount / BigInt(daysInMonth), remainder = Number(amount % BigInt(daysInMonth));
  let total = base * BigInt(last - first + 1);
  total += BigInt(Math.max(0, Math.min(last, remainder - 1) - first + 1));
  return total;
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
    WHERE p.tenant_id = ? AND p.store_id = ? AND p.initial_paid_amount > 0
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
    WHERE sp.tenant_id = ? AND p.store_id = ?
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
  const netCollections = cashSales + electronicSales;
  const totalCashOutflows = directCashOutflow + monthlyCashOutflow + totalSupplierPaid;
  const netCashRemaining = netCollections - totalCashOutflows;

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
      count: supplierPaymentItems.length,
      items: supplierPaymentItems,
    },
    cashPosition: {
      totalCollections: money(netCollections),
      cashCollections: money(cashSales),
      electronicCollections: money(electronicSales),
      directExpenses: money(directCashOutflow),
      monthlyExpenses: money(monthlyCashOutflow),
      supplierPayments: money(totalSupplierPaid),
      totalOutflows: money(totalCashOutflows),
      netCashRemaining: money(netCashRemaining),
    } };
}

let activeBackupPromise = null;

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
    if (existsSync(destinationPath)) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
    }
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
      if (existsSync(targetPath)) {
        await rm(targetPath, { force: true }).catch(() => undefined);
      }
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
  database.checkpointPassive();
  await database.getRawDatabase().backup(preRestorePath);
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
      SUM(p.initial_paid_amount + COALESCE((SELECT SUM(pay.amount) FROM supplier_payments pay WHERE pay.tenant_id = p.tenant_id AND pay.purchase_id = p.id), 0)) AS paidAmount,
      SUM(COALESCE((SELECT SUM(sr.credit_amount) FROM supplier_returns sr WHERE sr.tenant_id = p.tenant_id AND sr.purchase_id = p.id), 0)) AS returnedCredit,
      SUM(COALESCE((SELECT SUM(spi.quantity) FROM supplier_purchase_items spi WHERE spi.tenant_id = p.tenant_id AND spi.purchase_id = p.id), 0)) AS unitsOrdered
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') >= ? AND replace(COALESCE(p.purchased_at, p.created_at), ' ', 'T') < ?
    GROUP BY s.id, s.name
  `).all(ctx.tenantId, storeId, bounds.startIso, bounds.endExclusiveIso);
  const suppliers = rows.map((row) => {
    const totalMinor = BigInt(row.totalAmount ?? 0);
    const paidMinor = BigInt(row.paidAmount ?? 0);
    const creditMinor = BigInt(row.returnedCredit ?? 0);
    const remainingMinor = totalMinor - paidMinor - creditMinor;
    return {
      id: row.supplierId,
      name: row.supplierName,
      invoiceCount: String(row.invoiceCount),
      unitsOrdered: String(row.unitsOrdered ?? 0),
      totalAmount: moneyJson(Money.fromMinor(totalMinor, tenant.currency)),
      paidAmount: moneyJson(Money.fromMinor(paidMinor, tenant.currency)),
      returnedCredit: moneyJson(Money.fromMinor(creditMinor, tenant.currency)),
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
    let str = String(val).trim();
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
      (SELECT sp.method FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id LIMIT 1) AS payment_method,
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
    WHERE p.tenant_id = ? AND p.store_id = ? AND p.initial_paid_amount > 0
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
    WHERE sp.tenant_id = ? AND p.store_id = ?
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
    const expTimestamp = (e.expense_date && createdLocalDay && e.expense_date !== createdLocalDay)
      ? `${e.expense_date}T23:59:59.000Z`
      : createdIso;
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
  const netCashFlowMinor = netSalesMinor - totalSupplierPaidMinor - totalExpensesMinor + totalShiftCashVarianceMinor;
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

  let growthPercent = 0;
  if (prevRevenue > 0n) {
    growthPercent = Number((projectedMonthEndRevenueMinor - prevRevenue) * 10000n / prevRevenue) / 100;
  } else if (curRevenue > 0n) {
    growthPercent = 100;
  }

  const trendFactor = Math.max(-0.2, Math.min(0.4, (growthPercent / 100) * 0.5));
  const projectedNextMonthMinor = BigInt(Math.round(Number(projectedMonthEndRevenueMinor) * (1 + trendFactor)));
  const nextMonthGrowthPercent = Number(Math.round(trendFactor * 1000) / 10);

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
  const systemContext = new ScopedExecutionContext({ tenantId: tenants[0].id, userId: 'system', roleId: 'OWNER', permissions: new Set(['*']), correlationId: randomUUID() });
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
  const suppliers = canManageCatalog ? await db.selectFrom('suppliers').selectAll().where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1).orderBy('name').execute() : [];
  // Recent window only; full history is served by GET /api/purchases. Supplier totals below cover all history.
  const purchases = canManageCatalog ? await db.selectFrom('supplier_purchases').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('purchased_at', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const purchaseEntries = canManageCatalog ? await loadPurchaseEntries(ctx.tenantId, purchases, userMap) : [];
  const supplierTotals = canManageCatalog ? supplierPurchaseAggregates({ tenantId: ctx.tenantId, storeId }) : new Map();
  const supplierReturnRows = canManageCatalog ? await db.selectFrom('supplier_returns').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('created_at', 'desc').limit(BOOTSTRAP_PURCHASE_WINDOW).execute() : [];
  const supplierData = suppliers.map((supplier) => serializeSupplierSummary(supplier, supplierTotals.get(supplier.id), tenant.currency, purchaseEntries.filter((entry) => entry.supplierId === supplier.id)));
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

  return {
    company: { name: tenant.name, currency: tenant.currency, timezone: resolveValidTimeZone(tenant.timezone) },
    user: { id: ctx.userId, fullName: signedInUser?.fullName ?? '', role: ctx.roleId, storeId: ctx.storeId ?? null, shiftStartTime: signedInUser?.shiftStartTime ?? null, lateGraceMinutes: signedInUser?.lateGraceMinutes ?? 0 },
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
      canReturnSale: ctx.hasPermission(Permissions.POS_REFUND) || ctx.roleId === 'CASHIER',
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

async function handleApi(req, res, url) {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) requireSameOrigin(req);

  if (method === 'GET' && path === '/api/bootstrap') return json(res, 200, await setupState());

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

    let summaryReturns = 0n;
    let summaryReturnedCost = 0n;
    let summaryReturnedUnits = 0n;
    let summaryReturnsCount = 0;
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
    const supplierRows = await db.selectFrom('suppliers').selectAll().where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1).orderBy('name').execute();
    const visibleSuppliers = filter.supplierId ? supplierRows.filter((s) => s.id === filter.supplierId) : supplierRows;
    let sumTotal = 0n; let sumPaid = 0n; let sumReturned = 0n; let sumDue = 0n;
    for (const t of totals.values()) { sumTotal += t.total; sumPaid += t.paid; sumReturned += t.returned; sumDue += t.due; }
    const asMoney = (minor) => moneyJson(Money.fromMinor(minor, currency));
    return json(res, 200, {
      payload: {
        purchases: entries,
        suppliers: visibleSuppliers.map((supplier) => serializeSupplierSummary(supplier, totals.get(supplier.id), currency, [])),
        total,
        offset,
        limit,
        summary: {
          purchaseCount: total,
          supplierCount: visibleSuppliers.length,
          totalPurchased: asMoney(sumTotal),
          totalPaid: asMoney(sumPaid),
          returnedCredit: asMoney(sumReturned),
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
    await db.transaction().execute(async (trx) => {
      const existingOwner = await trx.selectFrom('users').select('id').where('tenant_id', '=', id).where('role', '=', 'OWNER').executeTakeFirst();
      if (existingOwner) throw Object.assign(new Error('تم إنشاء حساب المدير بالفعل'), { status: 409 });
      await trx.insertInto('users').values({ id: user.id, tenant_id: user.tenantId, store_id: null, username: user.username, password_hash: user.passwordHash, full_name: user.fullName, role: user.role }).execute();
    });
    await recordAudit(systemContext, { storeId, actorUserId: user.id, actorUsername: user.username, actorRole: 'OWNER', action: 'OWNER_SETUP', entityType: 'USER', entityId: user.id, summary: `إنشاء حساب مدير النظام (${user.username})` });
    return json(res, 201, { configured: true });
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
    if (Date.now() - failures.startedAt < LOCK_WINDOW_MS && failures.count >= MAX_FAILED_LOGINS) {
      throw Object.assign(new Error('محاولات كثيرة. انتظر عشر دقائق ثم حاول مرة أخرى.'), { status: 429 });
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

  if (method === 'GET' && path === '/api/reports/profit-loss') return json(res, 200, await profitLossReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/top-products') return json(res, 200, await topProductsReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/purchases') return json(res, 200, await purchaseSupplierReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/financial-map') return json(res, 200, await financialMapReport(ctx, url));
  if (method === 'GET' && path === '/api/reports/growth-forecast') return json(res, 200, await growthForecastReport(ctx, url));

  if (method === 'GET' && path === '/api/reports/export.csv') {
    const exportType = url.searchParams.get('type') ?? 'sales';
    const stores = await storeRepo.listByTenant(ctx);
    const requestedStore = url.searchParams.get('storeId');
    const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
    if (!storeId || !stores.some((s) => s.id === storeId)) throw Object.assign(new Error('الفرع غير متاح'), { status: 403 });
    let rows = [];
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
    let mirrorStatus = validatedMirrorPath ? 'PENDING' : 'UNCONFIGURED';
    let mirrorError = null;
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
    const currentTenant = await db.selectFrom('tenants').select(['id', 'code', 'currency']).where('id', '=', ctx.tenantId).executeTakeFirst();
    if (!currentTenant) throw Object.assign(new Error('Company not found'), { status: 404 });

    let preparedRestore;
    try {
      if (body.filename.endsWith('.rfbackup')) {
        preparedRestore = await prepareEncryptedSqliteRestore(targetPath, dataDir, resolveDailyBackupPassphraseSync(), currentTenant);
      } else {
        preparedRestore = await preparePlainSqliteRestore(targetPath, dataDir, currentTenant);
      }
    } catch {
      throw Object.assign(new Error('ملف النسخة اليومية تالف أو لا يخص هذا المتجر'), { status: 400 });
    }
    let restartRequired = false;
    try {
      await createPreRestoreSafetySnapshot();
      restartRequired = true;
      await installPreparedSqliteRestore(database.getRawDatabase(), () => database.close(), databasePath, dataDir, preparedRestore);
      res.once('finish', () => restartLocalServer());
      return json(res, 202, { restored: true, restarting: true, restoredFrom: body.filename });
    } catch (error) {
      if (restartRequired) res.once('finish', () => restartLocalServer());
      throw error;
    } finally {
      if (preparedRestore && !restartRequired) await rm(preparedRestore.workspace, { recursive: true, force: true });
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
    try {
      let uploadSize = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        uploadSize += chunk.length;
        if (uploadSize > maxUploadBytes) callback(Object.assign(new Error('Backup file exceeds the upload limit'), { status: 413 }));
        else callback(null, chunk);
      } });
      await pipeline(req, limit, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
      const currentTenant = await db.selectFrom('tenants').select(['id', 'code', 'currency']).where('id', '=', ctx.tenantId).executeTakeFirst();
      if (!currentTenant) throw Object.assign(new Error('Company not found'), { status: 404 });
      try {
        preparedRestore = await prepareEncryptedSqliteRestore(archivePath, dataDir, passphrase, currentTenant);
      } catch {
        throw Object.assign(new Error('Backup file or passphrase is invalid, or the backup belongs to another company'), { status: 400 });
      }
      await createPreRestoreSafetySnapshot();
      restartRequired = true;
      await installPreparedSqliteRestore(database.getRawDatabase(), () => database.close(), databasePath, dataDir, preparedRestore);
      res.once('finish', () => restartLocalServer());
      return json(res, 202, { restored: true, restarting: true });
    } catch (error) {
      if (restartRequired) res.once('finish', () => restartLocalServer());
      throw error;
    } finally {
      await rm(uploadWorkspace, { recursive: true, force: true });
      if (preparedRestore && !restartRequired) await rm(preparedRestore.workspace, { recursive: true, force: true });
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
    let filterUser = url.searchParams.get('userId') || '';

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
        COALESCE((SELECT sp.method FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id LIMIT 1), 'CASH') as payment_method,
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
    if (ctx.roleId !== 'OWNER' && (target.role !== 'CASHIER' || nextRole !== 'CASHIER' || nextStoreId !== ctx.storeId)) throw Object.assign(new Error('Store managers can only manage cashiers in their assigned store'), { status: 403 });
    if (nextRole === 'CASHIER' && !nextStoreId) throw Object.assign(new Error('Cashiers must be assigned to a store'), { status: 400 });
    if (nextStoreId && !await db.selectFrom('stores').select('id').where('tenant_id', '=', ctx.tenantId).where('id', '=', nextStoreId).executeTakeFirst()) throw Object.assign(new Error('Selected store is unavailable'), { status: 400 });
    if (target.role === 'OWNER' && target.is_active && (nextRole !== 'OWNER' || !nextActive)) {
      const activeOwners = await db.selectFrom('users').select(db.fn.countAll().as('count')).where('tenant_id', '=', ctx.tenantId).where('role', '=', 'OWNER').where('is_active', '=', 1).executeTakeFirst();
      if (Number(activeOwners?.count ?? 0) <= 1) throw Object.assign(new Error('At least one active owner must remain'), { status: 409 });
    }
    const revokeSessions = nextRole !== target.role || nextStoreId !== target.store_id || Number(nextActive) !== target.is_active;
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ full_name: body.fullName ?? target.full_name, phone: body.phone === undefined ? target.phone : body.phone || null, employment_start_date: body.employmentStartDate ?? target.employment_start_date, shift_start_time: nextShiftStartTime, late_grace_minutes: nextLateGraceMinutes, role: nextRole, store_id: nextStoreId, is_active: nextActive ? 1 : 0 }).where('tenant_id', '=', ctx.tenantId).where('id', '=', targetId).execute();
      if (revokeSessions) await trx.updateTable('sessions').set({ is_revoked: 1 }).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', targetId).execute();
    });
    await recordAudit(ctx, { storeId: nextStoreId ?? null, action: 'USER_UPDATED', entityType: 'USER', entityId: targetId, summary: `تحديث بيانات الموظف (${target.username})`, metadata: { role: nextRole, isActive: nextActive, shiftStartTime: nextShiftStartTime, lateGraceMinutes: nextLateGraceMinutes, sessionsRevoked: revokeSessions } });
    return json(res, 200, { updated: true, sessionsRevoked: revokeSessions });
  }

  if (method === 'POST' && path === '/api/account/password') {
    pruneFailedPasswordChanges();
    const rateLimitKey = `${ctx.tenantId}:${ctx.userId}`;
    const failures = getAuthFailures('pwd_change', rateLimitKey);
    if (Date.now() - failures.startedAt < LOCK_WINDOW_MS && failures.count >= MAX_FAILED_PASSWORD_CHANGES) {
      throw Object.assign(new Error('محاولات كثيرة خاطئة. يرجى الانتظار 10 دقائق قبل المحاولة مجدداً.'), { status: 429 });
    }

    const body = validate(PasswordChangeSchema, await readJson(req));
    const currentUser = await userRepo.findById(ctx, ctx.userId);
    const validCurrent = currentUser && await passwordHasher.verify(currentUser.passwordHash, body.currentPassword);
    if (!validCurrent) {
      recordAuthFailure('pwd_change', rateLimitKey);
      throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
    }
    clearAuthFailures('pwd_change', rateLimitKey);
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

  if (method === 'POST' && path === '/api/expenses') {
    ctx.assertPermission(Permissions.EXPENSES_DIRECT_CREATE);
    const body = validate(ExpenseSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const savedId = await expenses.record(ctx, { ...body, id, amount: BigInt(body.amount), currency: tenant.currency });
    return json(res, 201, { id: savedId });
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
    if (!ctx.hasPermission(Permissions.POS_REFUND) && ctx.roleId !== 'CASHIER') {
      ctx.assertPermission(Permissions.POS_REFUND);
    }
    const body = validate(CustomerReturnSchema, await readJson(req));
    const returnNumber = await generateNextReturnNumber(ctx.tenantId);
    const result = await returns.record(ctx, {
      id: randomUUID(),
      returnNumber,
      idempotencyKey: body.idempotencyKey,
      storeId: body.storeId,
      originalSaleId: returnMatch[1],
      paymentMethod: body.paymentMethod,
      occurredAt: new Date(),
      lines: body.items.map((item) => ({ originalSaleItemId: item.originalSaleItemId, quantity: BigInt(item.quantity) }))
    });
    return json(res, 201, { id: result.id, returnNumber, refundAmount: result.refundAmount.toString() });
  }

  const exchangeMatch = method === 'POST' ? path.match(/^\/api\/sales\/([0-9a-f-]+)\/exchange$/i) : null;
  if (exchangeMatch) {
    if (!ctx.hasPermission(Permissions.POS_REFUND) && ctx.roleId !== 'CASHIER') {
      ctx.assertPermission(Permissions.POS_REFUND);
    }
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
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const invoiceNumber = body.invoiceNumber?.trim() || await generateNextPurchaseNumber(ctx.tenantId);
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
    const expectedRetailTotal = hasAnyRetailPrice ? Money.fromMinor(computedRetailTotalMinor, tenant.currency) : undefined;
    const savedId = await purchasing.recordPurchase(ctx, {
      id, idempotencyKey: body.idempotencyKey, storeId: body.storeId, supplierId: body.supplierId,
      invoiceNumber,
      totalAmount: Money.fromMinor(BigInt(body.totalAmount), tenant.currency),
      initialPayment: Money.fromMinor(BigInt(body.paidAmount), tenant.currency),
      paymentMethod: body.paymentMethod,
      targetProfitPercent: body.targetProfitPercent ?? null,
      expectedRetailTotal,
      referenceNumber: body.referenceNumber,
      notes: body.notes, purchasedAt: new Date(),
      lines,
    });
    if (savedId === id) {
      await recordAudit(ctx, { storeId: body.storeId, action: 'PURCHASE_RECORDED', entityType: 'PURCHASE', entityId: savedId, summary: `تسجيل فاتورة شراء (${invoiceNumber})`, metadata: { invoiceNumber, totalAmount: body.totalAmount, paidAmount: body.paidAmount, targetProfitPercent: body.targetProfitPercent ?? null, expectedRetailTotal: expectedRetailTotal?.amount.toString() ?? null } });
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

  if (method === 'POST' && path === '/api/checkout') {
    ctx.assertPermission(Permissions.POS_CHECKOUT);
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
    const now = new Date();
    const existingReplay = await saleRepo.findByIdempotencyKey(ctx, body.idempotencyKey);
    const saleNumber = existingReplay?.saleNumber ?? await generateNextSaleNumber(ctx.tenantId);
    const tentativeSaleId = randomUUID();
    const sale = await checkout.checkout(ctx, {
      saleId: tentativeSaleId, saleNumber,
      storeId: body.storeId, cart,
      payments: [{ method: body.payment.method, amount: Money.fromMinor(BigInt(body.payment.amount), tenant.currency) }],
      idempotencyKey: body.idempotencyKey, customerName: body.customerName, occurredAt: now,
    });
    if (sale.id === tentativeSaleId) {
      await recordAudit(ctx, { storeId: body.storeId, action: 'SALE_COMPLETED', entityType: 'SALE', entityId: sale.id, summary: `إتمام عملية بيع (${sale.saleNumber})`, metadata: { saleNumber: sale.saleNumber, total: sale.total.amount.toString(), paymentMethod: body.payment.method } });
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

    const sessionNumber = await generateNextStocktakeNumber(ctx.tenantId);
    const sessionId = randomUUID();
    const nowIso = new Date().toISOString();
    const todayLabel = nowIso.slice(0, 10);
    const defaultTitle = body.scope === 'FULL'
      ? `جرد شامل للمحل — ${todayLabel}`
      : body.scope === 'CATEGORY'
        ? `جرد تصنيف ${categoryName ?? ''} — ${todayLabel}`
        : `جرد انتقائي سريع — ${todayLabel}`;
    const title = body.title?.trim() || defaultTitle;

    await db.transaction().execute(async (trx) => {
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

      await trx
        .insertInto('stocktake_sessions')
        .values({
          id: sessionId,
          tenant_id: ctx.tenantId,
          store_id: body.storeId,
          session_number: sessionNumber,
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
          total_surplus_cost: 0,
          total_shortage_cost: 0,
          net_variance_cost: 0,
          net_variance_retail: 0,
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
            unit_wac: Math.max(0, Number(variant.wac_cost ?? 0)),
            retail_price: Math.max(0, Number(variant.retail_price ?? 0)),
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
                unit_wac: Math.max(0, Number(pickedInv?.wac_cost ?? 0)),
                retail_price: Math.max(0, Number(picked.retail_price ?? 0)),
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
              unit_wac: Math.max(0, Number(vInv?.wac_cost ?? 0)),
              retail_price: Math.max(0, Number(v.retail_price ?? 0)),
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
            lineSet.override_unit_cost = patch.overrideUnitCost === null ? null : Math.max(0, Math.trunc(Number(patch.overrideUnitCost)));
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
              committed_variance_cost: 0,
              committed_unit_cost: Number(unitCostMinor),
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
            committed_variance_cost: Number(lineCostVariance),
            committed_unit_cost: Number(unitCostMinor),
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
          total_surplus_cost: Number(surplusCostTotal),
          total_shortage_cost: Number(shortageCostTotal),
          net_variance_cost: Number(netVarianceCost),
          net_variance_retail: Number(netVarianceRetail),
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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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
    }
    const message = status >= 500
      ? 'حصل خطأ داخلي. لم يتم تنفيذ العملية.'
      : isInsufficientStock
        ? 'الكمية المطلوبة غير متوفرة في المخزون (تم بيعها أو نفد الرصيد)'
        : (error?.message ?? 'حدث خطأ غير متوقع');
    json(res, status, { error: message });
  }
});

const walCheckpointTimer = setInterval(() => {
  database.checkpointPassive();
  pruneFailedLogins();
  pruneFailedPasswordChanges();
  void ensureDailyBackup({ force: false }).catch(() => undefined);
  void db
    .deleteFrom('sessions')
    .where((eb) => eb.or([eb('is_revoked', '=', 1), eb('expires_at', '<', new Date().toISOString())]))
    .execute()
    .catch(() => undefined);
}, 5 * 60 * 1000);
walCheckpointTimer.unref();
setTimeout(() => {
  void ensureDailyBackup({ force: false }).catch(() => undefined);
}, 1500).unref();

let restartScheduled = false;
function restartLocalServer() {
  if (restartScheduled) return;
  restartScheduled = true;
  clearInterval(walCheckpointTimer);
  server.close(() => {
    database.checkpointPassive();
    void database.close().then(() => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: appDir,
        env: process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      setTimeout(() => process.exit(0), 250);
    }).catch((error) => {
      console.error('Could not restart after database restore', error);
      process.exit(1);
    });
  });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`RetailOS is running locally at ${origin}`);
  console.log(`Company database: ${join(dataDir, 'retailos.sqlite')}`);
});

async function shutdown() {
  clearInterval(walCheckpointTimer);
  server.close();
  await ensureDailyBackup({ force: false, minAgeMs: 60_000, syncMirror: true }).catch(() => undefined);
  database.checkpointPassive();
  await database.close();
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
