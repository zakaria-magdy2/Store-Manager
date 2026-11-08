import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
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
import { Cart, DomainError, Money, Permissions, User } from '@retailos/core';
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
  recoverPendingSqliteRestore,
  EscPosReceiptPrinter,
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
  storeName: process.env.RETAILOS_STORE_NAME ?? 'الفرع الرئيسي',
  storeCode: process.env.RETAILOS_STORE_CODE ?? 'MAIN',
};
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const origin = `http://127.0.0.1:${port}`;
const databasePath = join(dataDir, 'retailos.sqlite');
await mkdir(dataDir, { recursive: true });
const restoredAfterCrash = await recoverPendingSqliteRestore(dataDir, databasePath, companyConfig.code);
const database = new SqliteDatabaseManager({ filename: databasePath });
database.connect();
const db = database.getDb();
const migration = await new DatabaseMigrator(db).migrateToLatest();
if (!migration.success) throw migration.error ?? new Error('Database migration failed');
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
    await trx.insertInto('tenants').values({ id: tenantId, name: companyConfig.name, code: companyConfig.code, currency: companyConfig.currency }).execute();
    await trx.insertInto('stores').values({ id: randomUUID(), tenant_id: tenantId, name: companyConfig.storeName, code: companyConfig.storeCode, address: null, phone: null }).execute();
  });
} else if (process.env.RETAILOS_COMPANY_NAME) {
  const existing = (await tenantRepo.listAll())[0];
  await db.updateTable('tenants').set({ name: process.env.RETAILOS_COMPANY_NAME }).where('id', '=', existing.id).execute();
  if (process.env.RETAILOS_STORE_NAME) await db.updateTable('stores').set({ name: process.env.RETAILOS_STORE_NAME }).where('tenant_id', '=', existing.id).where('code', '=', companyConfig.storeCode).execute();
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
  items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100),
  payment: z.object({ method: z.enum(['CASH', 'CARD', 'MOBILE', 'OTHER']), amount: z.string().regex(/^\d{1,15}$/) }),
});
const SupplierSchema = z.object({ name: z.string().min(2).max(120).trim(), phone: z.string().max(40).trim().optional(), notes: z.string().max(500).trim().optional() });
const PurchaseSchema = z.object({ idempotencyKey: z.string().uuid(), supplierId: z.string().uuid(), storeId: z.string().uuid(), invoiceNumber: z.string().max(80).trim().optional(), totalAmount: z.string().regex(/^[1-9]\d{0,14}$/), paidAmount: z.string().regex(/^\d{1,15}$/), paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']).default('CASH'), referenceNumber: z.string().max(80).trim().optional(), notes: z.string().max(500).trim().optional(), items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.string().regex(/^[1-9]\d{0,8}$/), unitCost: z.string().regex(/^\d{1,15}$/) })).min(1).max(100) });
const SupplierPaymentSchema = z.object({ idempotencyKey: z.string().uuid(), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE']), referenceNumber: z.string().max(80).trim().optional() });
const ExpenseSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), categoryCode: z.enum(['RENT', 'UTILITIES', 'TRANSPORT', 'MAINTENANCE', 'SUPPLIES', 'OTHER']), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']), expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().max(500).trim().optional(), referenceNumber: z.string().max(80).trim().optional() });
const CustomerReturnSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), paymentMethod: z.enum(['CASH', 'CARD', 'MOBILE', 'OTHER']), items: z.array(z.object({ originalSaleItemId: z.string().min(1).max(80), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100) });
const RecurringObligationSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), categoryCode: z.enum(['RENT', 'UTILITIES', 'TRANSPORT', 'MAINTENANCE', 'SUPPLIES', 'OTHER']), name: z.string().min(2).max(120).trim(), dueDay: z.number().int().min(1).max(31) });
const MonthlyActualSchema = z.object({ year: z.number().int().min(2000).max(9999), month: z.number().int().min(1).max(12), amount: z.string().regex(/^[1-9]\d{0,14}$/) });
const MonthlyPaymentSchema = z.object({ idempotencyKey: z.string().uuid(), amount: z.string().regex(/^[1-9]\d{0,14}$/), paymentMethod: z.enum(['CASH_DRAWER', 'CASH_SAFE', 'BANK_TRANSFER']), referenceNumber: z.string().max(80).trim().optional() });
const SupplierReturnSchema = z.object({ idempotencyKey: z.string().uuid(), storeId: z.string().uuid(), items: z.array(z.object({ purchaseItemId: z.string().min(1).max(80), quantity: z.string().regex(/^[1-9]\d{0,8}$/) })).min(1).max(100) });
const BackupSchema = z.object({ passphrase: z.string().min(12).max(256) });
const PasswordChangeSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) });
const EmployeeDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const EmployeePhoneSchema = z.string().trim().max(32).regex(/^[+0-9().\-\s]*$/);
const UpdateUserSchema = z.object({ fullName: z.string().min(2).max(100).trim().optional(), phone: EmployeePhoneSchema.nullable().optional(), employmentStartDate: EmployeeDateSchema.optional(), role: z.enum(['OWNER', 'STORE_MANAGER', 'CASHIER', 'AUDITOR']).optional(), storeId: z.string().uuid().nullable().optional(), isActive: z.boolean().optional() }).refine((body) => Object.keys(body).length > 0);
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
const failedLogins = new Map();
const MAX_FAILED_LOGINS = 6;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_KEYS = 2000;

function pruneFailedLogins() {
  const now = Date.now();
  for (const [k, v] of failedLogins.entries()) {
    if (now - v.startedAt >= LOCK_WINDOW_MS) failedLogins.delete(k);
  }
  while (failedLogins.size > MAX_FAILED_KEYS) {
    const oldestKey = failedLogins.keys().next().value;
    if (!oldestKey) break;
    failedLogins.delete(oldestKey);
  }
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
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function readCookie(req, name) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 64 * 1024) throw Object.assign(new Error('Request is too large'), { status: 413 });
  }
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
  const start = `${url.searchParams.get('from')}T00:00:00.000Z`;
  const end = `${url.searchParams.get('to')}T23:59:59.999Z`;
  const sales = await db.selectFrom('sales').innerJoin('sale_items', 'sale_items.sale_id', 'sales.id')
    .select(['sales.id as id', 'sales.created_at as createdAt', 'sale_items.quantity as quantity', 'sale_items.unit_price as unitPrice', 'sale_items.line_discount as lineDiscount', 'sale_items.cart_discount_share as cartDiscountShare', 'sale_items.cost_of_goods_sold as cogs'])
    .where('sales.tenant_id', '=', ctx.tenantId).where('sales.store_id', '=', storeId).where('sales.status', '=', 'COMPLETED')
    .where('sales.created_at', '>=', start).where('sales.created_at', '<=', end).execute();
  const returns = await db.selectFrom('customer_returns').select(['id', 'refund_amount as refundAmount', 'payment_method as paymentMethod', 'created_at as createdAt'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('created_at', '>=', start).where('created_at', '<=', end).execute();
  const returnLines = returns.length ? await db.selectFrom('customer_return_items').select(['return_id as returnId', 'cost_amount as costAmount'])
    .where('tenant_id', '=', ctx.tenantId).where('return_id', 'in', returns.map((item) => item.id)).execute() : [];
  const varianceRows = await db.selectFrom('journal_entries').innerJoin('journal_lines', 'journal_lines.journal_entry_id', 'journal_entries.id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id').select(['journal_lines.entry_type as side', 'journal_lines.amount as amount'])
    .where('journal_entries.tenant_id', '=', ctx.tenantId).where('journal_entries.store_id', '=', storeId)
    .where('journal_entries.source_type', '=', 'SUPPLIER_RETURN').where('journal_entries.entry_date', '>=', url.searchParams.get('from'))
    .where('journal_entries.entry_date', '<=', url.searchParams.get('to')).where('accounts.account_code', '=', '5090').execute();
  const directExpenses = await db.selectFrom('operating_expense_records').select(['amount', 'payment_method as paymentMethod'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'DIRECT_DAILY')
    .where('expense_date', '>=', url.searchParams.get('from')).where('expense_date', '<=', url.searchParams.get('to')).execute();
  const monthlyPayments = await db.selectFrom('operating_expense_records').select(['amount', 'expense_date as expenseDate', 'payment_method as paymentMethod'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'MONTHLY_RECURRING_PAYMENT')
    .where('expense_date', '>=', url.searchParams.get('from')).where('expense_date', '<=', url.searchParams.get('to')).execute();
  const salePayments = await db.selectFrom('sale_payments').innerJoin('sales', 'sales.id', 'sale_payments.sale_id')
    .select(['sale_payments.method as method', 'sale_payments.amount as amount', 'sales.change_given as changeGiven'])
    .where('sale_payments.tenant_id', '=', ctx.tenantId).where('sales.store_id', '=', storeId)
    .where('sale_payments.created_at', '>=', start).where('sale_payments.created_at', '<=', end).execute();
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
  cogs += inventoryCostVariance - returnedCost;
  const netSales = grossSales - discounts - refunds;
  const grossProfit = netSales - cogs;
  const directExpenseTotal = directExpenses.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  let monthlyExpenseTotal = 0n;
  for (const item of actuals) {
    const monthStart = new Date(Date.UTC(item.year, item.month - 1, 1));
    const monthEnd = new Date(Date.UTC(item.year, item.month, 0));
    monthlyExpenseTotal += dailyMonthlyShare(BigInt(item.amount), item.days_in_month, monthStart, from, to < monthEnd ? to : monthEnd);
  }
  const missingMonthlyActuals = [];
  for (let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); cursor <= to; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth() + 1;
    for (const obligation of obligations) {
      if (!actuals.some((item) => item.obligation_id === obligation.id && item.year === year && item.month === month)) missingMonthlyActuals.push({ name: obligation.name, year, month });
    }
  }
  const operatingProfit = grossProfit - directExpenseTotal - monthlyExpenseTotal;
  const cashSales = salePayments.filter((item) => item.method === 'CASH').reduce((sum, item) => sum + BigInt(item.amount), 0n)
    - salePayments.filter((item) => item.method === 'CASH').reduce((sum, item) => sum + BigInt(item.changeGiven), 0n)
    - returns.filter((item) => item.paymentMethod === 'CASH').reduce((sum, item) => sum + BigInt(item.refundAmount), 0n);
  const electronicSales = salePayments.filter((item) => item.method !== 'CASH').reduce((sum, item) => sum + BigInt(item.amount), 0n)
    - returns.filter((item) => item.paymentMethod !== 'CASH').reduce((sum, item) => sum + BigInt(item.refundAmount), 0n);
  const directCashOutflow = directExpenseTotal;
  const monthlyCashOutflow = monthlyPayments.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const unpaid = await db.selectFrom('monthly_expense_actuals').select(['amount', 'paid_amount as paidAmount'])
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .where((eb) => eb.or([eb('year', '<', to.getUTCFullYear()), eb.and([eb('year', '=', to.getUTCFullYear()), eb('month', '<=', to.getUTCMonth() + 1)])])).execute();
  const pendingDue = unpaid.reduce((sum, item) => sum + BigInt(item.amount) - BigInt(item.paidAmount), 0n);
  const money = (amount) => moneyJson(Money.fromMinor(amount, tenant.currency));
  return { storeId, from: url.searchParams.get('from'), to: url.searchParams.get('to'), currency: tenant.currency, missingMonthlyActuals,
    profitLoss: { grossSales: money(grossSales), discounts: money(discounts), returns: money(refunds), netSales: money(netSales), cogs: money(cogs), grossProfit: money(grossProfit), directExpenses: money(directExpenseTotal), monthlyExpenses: money(monthlyExpenseTotal), operatingProfit: money(operatingProfit) },
    cashFlow: { cashSales: money(cashSales), electronicSales: money(electronicSales), directExpenseOutflow: money(directCashOutflow), monthlyObligationOutflow: money(monthlyCashOutflow), pendingUnpaidObligations: money(pendingDue) } };
}

async function topProductsReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_DAILY_VIEW);
  const fromValue = url.searchParams.get('from');
  const toValue = url.searchParams.get('to');
  if ((fromValue === null) !== (toValue === null)) throw Object.assign(new Error('Both report dates are required'), { status: 400 });
  let start = null, end = null;
  if (fromValue && toValue) {
    const from = reportDay(fromValue), to = reportDay(toValue);
    if (from > to) throw Object.assign(new Error('Report start date must be before end date'), { status: 400 });
    start = `${fromValue}T00:00:00.000Z`;
    end = `${toValue}T23:59:59.999Z`;
  }
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const result = database.getRawDatabase().prepare(`
    SELECT p.id AS productId, p.name AS productName,
      SUM(si.quantity - COALESCE((SELECT SUM(ri.quantity) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS unitsSold,
      SUM(si.net_revenue - COALESCE((SELECT SUM(ri.refund_amount) FROM customer_return_items ri WHERE ri.tenant_id = si.tenant_id AND ri.original_sale_item_id = si.id), 0)) AS netRevenue,
      COUNT(DISTINCT s.id) AS orderCount
    FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id AND s.store_id = si.store_id
    INNER JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
    WHERE si.tenant_id = ? AND si.store_id = ? AND s.status = 'COMPLETED'
      AND (? IS NULL OR s.created_at >= ?)
      AND (? IS NULL OR s.created_at <= ?)
    GROUP BY p.id, p.name
    HAVING unitsSold > 0
  `).all(ctx.tenantId, storeId, start, start, end, end);
  const products = result.map((row) => ({
    id: row.productId,
    name: row.productName,
    unitsSold: String(row.unitsSold),
    netRevenue: moneyJson(Money.fromMinor(BigInt(row.netRevenue), tenant.currency)),
    orderCount: String(row.orderCount),
  }));
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
  return { range: fromValue && toValue ? { from: fromValue, to: toValue } : { from: null, to: null }, topByUnits: byUnits[0] ?? null, topByRevenue: byRevenue[0] ?? null, products: byUnits.slice(0, 10) };
}

async function purchaseSupplierReport(ctx, url) {
  ctx.assertPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const fromValue = url.searchParams.get('from'), toValue = url.searchParams.get('to');
  if (!fromValue || !toValue) throw Object.assign(new Error('Both report dates are required'), { status: 400 });
  const from = reportDay(fromValue), to = reportDay(toValue);
  if (from > to) throw Object.assign(new Error('Report start date must be before end date'), { status: 400 });
  const stores = await storeRepo.listByTenant(ctx);
  const requestedStore = url.searchParams.get('storeId');
  const storeId = ctx.storeId ?? requestedStore ?? stores[0]?.id;
  if (!storeId || !stores.some((store) => store.id === storeId)) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
  const tenant = await tenantRepo.findById(ctx.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  const rows = database.getRawDatabase().prepare(`
    SELECT s.id AS supplierId, s.name AS supplierName, COUNT(p.id) AS invoiceCount, SUM(p.total_amount) AS totalAmount
    FROM supplier_purchases p
    INNER JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND substr(p.purchased_at, 1, 10) >= ? AND substr(p.purchased_at, 1, 10) <= ?
    GROUP BY s.id, s.name
  `).all(ctx.tenantId, storeId, fromValue, toValue);
  const suppliers = rows.map((row) => ({ id: row.supplierId, name: row.supplierName, invoiceCount: String(row.invoiceCount), totalAmount: moneyJson(Money.fromMinor(BigInt(row.totalAmount), tenant.currency)) }));
  const bySpend = [...suppliers].sort((a, b) => BigInt(a.totalAmount.amount) === BigInt(b.totalAmount.amount) ? a.name.localeCompare(b.name) : BigInt(a.totalAmount.amount) > BigInt(b.totalAmount.amount) ? -1 : 1);
  const byInvoices = [...suppliers].sort((a, b) => Number(b.invoiceCount) - Number(a.invoiceCount) || a.name.localeCompare(b.name));
  return { range: { from: fromValue, to: toValue }, topBySpend: bySpend[0] ?? null, topByInvoices: byInvoices[0] ?? null, suppliers: bySpend };
}

function requireSameOrigin(req) {
  if (req.headers.origin !== origin) {
    throw Object.assign(new Error('الطلب غير مسموح'), { status: 403 });
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
  const canViewSales = ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW);
  const canViewAccounting = ctx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW);
  const sales = canViewSales ? (await saleRepo.listByStore(ctx, storeId, 100)).map(saleJson) : [];
  const returnedLines = canViewSales ? await db.selectFrom('customer_return_items').innerJoin('customer_returns', 'customer_returns.id', 'customer_return_items.return_id')
    .select(['customer_return_items.original_sale_item_id as itemId', 'customer_return_items.quantity as quantity'])
    .where('customer_return_items.tenant_id', '=', ctx.tenantId).where('customer_returns.store_id', '=', storeId).execute() : [];
  const returnedQuantityByItem = new Map();
  for (const line of returnedLines) returnedQuantityByItem.set(line.itemId, (returnedQuantityByItem.get(line.itemId) ?? 0n) + BigInt(line.quantity));
  for (const sale of sales) sale.items = sale.items.map((item) => ({ ...item, returnableQuantity: item.type === 'SALE' ? (BigInt(item.quantity) - (returnedQuantityByItem.get(item.id) ?? 0n)).toString() : '0' }));
  const customerReturnRows = canViewSales ? await db.selectFrom('customer_returns').innerJoin('sales', 'sales.id', 'customer_returns.original_sale_id')
    .select(['customer_returns.id as id', 'customer_returns.return_number as returnNumber', 'customer_returns.created_at as createdAt', 'customer_returns.refund_amount as refundAmount', 'customer_returns.currency as currency', 'customer_returns.payment_method as paymentMethod', 'sales.sale_number as saleNumber'])
    .where('customer_returns.tenant_id', '=', ctx.tenantId).where('customer_returns.store_id', '=', storeId)
    .orderBy('customer_returns.created_at', 'desc').limit(100).execute() : [];
  const journalHeaders = canViewAccounting ? await db.selectFrom('journal_entries').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId)
    .orderBy('entry_date', 'desc').orderBy('created_at', 'desc').limit(200).execute() : [];
  const allJournalLines = journalHeaders.length
    ? await db.selectFrom('journal_lines').innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
      .select(['journal_lines.journal_entry_id as entryId', 'journal_lines.entry_type as side', 'journal_lines.amount as amount', 'journal_lines.currency as currency', 'journal_lines.memo as memo', 'accounts.account_code as accountCode', 'accounts.account_name as accountName'])
      .where('journal_lines.journal_entry_id', 'in', journalHeaders.map((entry) => entry.id)).orderBy('journal_lines.created_at').execute()
    : [];
  const linesByEntryId = new Map();
  for (const line of allJournalLines) {
    const bucket = linesByEntryId.get(line.entryId) ?? [];
    bucket.push(line);
    linesByEntryId.set(line.entryId, bucket);
  }
  const accountingEntries = journalHeaders.map((entry) => {
    const lines = linesByEntryId.get(entry.id) ?? [];
    const debit = lines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + BigInt(line.amount), 0n);
    const credit = lines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + BigInt(line.amount), 0n);
    return { id: entry.id, entryNumber: entry.entry_number, date: entry.entry_date, sourceType: entry.source_type, description: lines[0]?.memo?.split(' — ')[0] ?? entry.source_type, debitTotal: debit.toString(), creditTotal: credit.toString(), balanced: debit === credit, lines: lines.map((line) => ({ side: line.side, accountCode: line.accountCode, accountName: line.accountName, amount: moneyJson(Money.fromMinor(BigInt(line.amount), line.currency)), memo: line.memo })) };
  });
  const canViewExpenses = ctx.hasPermission(Permissions.EXPENSES_DIRECT_CREATE) || canViewAccounting;
  const expenseRows = canViewExpenses ? await db.selectFrom('operating_expense_records').innerJoin('expense_categories', 'expense_categories.id', 'operating_expense_records.category_id')
    .select(['operating_expense_records.id as id', 'operating_expense_records.expense_date as date', 'operating_expense_records.amount as amount', 'operating_expense_records.currency as currency', 'operating_expense_records.payment_method as paymentMethod', 'operating_expense_records.notes as notes', 'operating_expense_records.reference_number as referenceNumber', 'expense_categories.name as category'])
    .where('operating_expense_records.tenant_id', '=', ctx.tenantId).where('operating_expense_records.store_id', '=', storeId).where('operating_expense_records.expense_type', '=', 'DIRECT_DAILY')
    .orderBy('operating_expense_records.expense_date', 'desc').execute() : [];
  const canManageCatalog = ctx.hasPermission(Permissions.CATALOG_MANAGE);
  const suppliers = canManageCatalog ? await db.selectFrom('suppliers').selectAll().where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1).orderBy('name').execute() : [];
  const purchases = canManageCatalog ? await db.selectFrom('supplier_purchases').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('purchased_at', 'desc').execute() : [];
  const purchaseItems = canManageCatalog ? await db.selectFrom('supplier_purchase_items').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).execute() : [];
  const supplierPayments = canManageCatalog ? await db.selectFrom('supplier_payments').selectAll().where('tenant_id', '=', ctx.tenantId).execute() : [];
  const supplierReturnRows = canManageCatalog ? await db.selectFrom('supplier_returns').selectAll().where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).orderBy('created_at', 'desc').execute() : [];
  const supplierReturnItems = canManageCatalog ? await db.selectFrom('supplier_return_items').selectAll().where('tenant_id', '=', ctx.tenantId).execute() : [];
  const returnedQuantityByPurchaseItem = new Map();
  for (const item of supplierReturnItems) returnedQuantityByPurchaseItem.set(item.purchase_item_id, (returnedQuantityByPurchaseItem.get(item.purchase_item_id) ?? 0n) + BigInt(item.quantity));
  const supplierData = suppliers.map((supplier) => {
    const entries = purchases.filter((purchase) => purchase.supplier_id === supplier.id).map((purchase) => {
      const payments = supplierPayments.filter((payment) => payment.purchase_id === purchase.id);
      const vendorReturns = supplierReturnRows.filter((item) => item.purchase_id === purchase.id);
      const paid = BigInt(purchase.initial_paid_amount) + payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
      const returnCredit = vendorReturns.reduce((sum, item) => sum + BigInt(item.credit_amount), 0n);
      return { id: purchase.id, invoiceNumber: purchase.invoice_number, purchasedAt: purchase.purchased_at, totalAmount: moneyJson(Money.fromMinor(BigInt(purchase.total_amount), purchase.currency)), paidAmount: moneyJson(Money.fromMinor(paid, purchase.currency)), returnedCredit: moneyJson(Money.fromMinor(returnCredit, purchase.currency)), remainingAmount: moneyJson(Money.fromMinor(BigInt(purchase.total_amount) - paid - returnCredit, purchase.currency)), notes: purchase.notes, items: purchaseItems.filter((line) => line.purchase_id === purchase.id).map((line) => { const returned = returnedQuantityByPurchaseItem.get(line.id) ?? 0n; return { id: line.id, productName: line.product_name, sku: line.sku, quantity: line.quantity.toString(), returnableQuantity: (BigInt(line.quantity) - returned).toString(), unitCost: moneyJson(Money.fromMinor(BigInt(line.unit_cost), line.currency)) }; }), payments: payments.map((payment) => ({ id: payment.id, amount: moneyJson(Money.fromMinor(BigInt(payment.amount), payment.currency)), paymentMethod: payment.payment_method, referenceNumber: payment.reference_number, paidAt: payment.paid_at })), returns: vendorReturns.map((item) => ({ id: item.id, returnNumber: item.return_number, creditAmount: moneyJson(Money.fromMinor(BigInt(item.credit_amount), item.currency)), createdAt: item.created_at })) };
    });
    return { id: supplier.id, name: supplier.name, phone: supplier.phone, notes: supplier.notes, purchases: entries, totalPurchased: entries.reduce((sum, item) => sum + BigInt(item.totalAmount.amount), 0n).toString(), totalPaid: entries.reduce((sum, item) => sum + BigInt(item.paidAmount.amount), 0n).toString(), balanceDue: entries.reduce((sum, item) => sum + BigInt(item.remainingAmount.amount), 0n).toString(), currency: tenant.currency };
  });
  const monthlyNow = new Date();
  const monthlyYear = monthlyNow.getUTCFullYear(), monthlyMonth = monthlyNow.getUTCMonth() + 1;
  const canViewMonthlyExpenses = ctx.hasPermission(Permissions.EXPENSES_MONTHLY_CONFIRM) || ctx.hasPermission(Permissions.EXPENSES_MONTHLY_PAY) || ctx.hasPermission(Permissions.REPORTS_MONTHLY_VIEW);
  const monthlyObligations = canViewMonthlyExpenses ? await db.selectFrom('recurring_expense_obligations')
    .innerJoin('expense_categories', 'expense_categories.id', 'recurring_expense_obligations.category_id')
    .select(['recurring_expense_obligations.id as id', 'recurring_expense_obligations.name as name', 'recurring_expense_obligations.due_day_of_month as dueDay', 'recurring_expense_obligations.currency as currency', 'expense_categories.name as category'])
    .where('recurring_expense_obligations.tenant_id', '=', ctx.tenantId).where('recurring_expense_obligations.store_id', '=', storeId)
    .where('recurring_expense_obligations.is_active', '=', 1).orderBy('recurring_expense_obligations.due_day_of_month').execute() : [];
  const monthlyActualRows = canViewMonthlyExpenses && monthlyObligations.length ? await db.selectFrom('monthly_expense_actuals').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('year', '=', monthlyYear).where('month', '=', monthlyMonth).execute() : [];
  const monthlyPaymentRows = canViewMonthlyExpenses && monthlyActualRows.length ? await db.selectFrom('operating_expense_records').selectAll()
    .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', storeId).where('expense_type', '=', 'MONTHLY_RECURRING_PAYMENT')
    .where('monthly_actual_id', 'in', monthlyActualRows.map((actual) => actual.id)).orderBy('expense_date', 'desc').execute() : [];
  const monthlyExpenses = monthlyObligations.map((obligation) => {
    const actual = monthlyActualRows.find((item) => item.obligation_id === obligation.id);
    const payments = actual ? monthlyPaymentRows.filter((item) => item.monthly_actual_id === actual.id) : [];
    const amount = actual ? BigInt(actual.amount) : 0n, paid = actual ? BigInt(actual.paid_amount) : 0n;
    return { ...obligation, actual: actual ? { id: actual.id, year: actual.year, month: actual.month,
      amount: moneyJson(Money.fromMinor(amount, actual.currency)), paidAmount: moneyJson(Money.fromMinor(paid, actual.currency)),
      remainingAmount: moneyJson(Money.fromMinor(amount - paid, actual.currency)), status: actual.status,
      payments: payments.map((item) => ({ id: item.id, amount: moneyJson(Money.fromMinor(BigInt(item.amount), item.currency)), method: item.payment_method, referenceNumber: item.reference_number, paidAt: item.expense_date })) } : null };
  });
  const today = new Date().toISOString().slice(0, 10);
  const todaysSales = sales.filter((sale) => sale.createdAt.slice(0, 10) === today);
  const revenueMinor = todaysSales.reduce((sum, sale) => sum + BigInt(sale.total.amount), 0n).toString();
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
  return {
    company: { name: tenant.name, currency: tenant.currency },
    user: { id: ctx.userId, fullName: signedInUser?.fullName ?? '', role: ctx.roleId, storeId: ctx.storeId ?? null },
    stores: stores.map((store) => ({ id: store.id, name: store.name, code: store.code, address: store.address ?? null, phone: store.phone ?? null })),
    users: managedUsers.map((user) => ({ id: user.id, username: user.username, fullName: user.fullName, phone: user.phone ?? null, employmentStartDate: user.employmentStartDate, role: user.role, storeId: user.storeId ?? null, isActive: user.isActive, createdAt: user.createdAt.toISOString() })),
    selectedStoreId: storeId,
    categories: (await categoryRepo.listByTenant(ctx)).map((category) => ({ id: category.id, name: category.name, code: category.code })),
    products: productData,
    suppliers: canManageCatalog ? supplierData : [],
    supplierReturns: canManageCatalog ? supplierReturnRows.map((item) => ({ id: item.id, returnNumber: item.return_number, purchaseId: item.purchase_id, creditAmount: moneyJson(Money.fromMinor(BigInt(item.credit_amount), item.currency)), createdAt: item.created_at })) : [],
    accountingEntries,
    accountingPeriods: accountingPeriods.map((period) => ({ id: period.id, name: period.name, startDate: period.start_date, endDate: period.end_date, status: period.status, closedAt: period.closed_at })),
    drawerBookBalance: drawerBookBalanceMinor !== null ? moneyJson(Money.fromMinor(drawerBookBalanceMinor, tenant.currency)) : null,
    treasuryBalances: treasuryMinor ? {
      drawer: moneyJson(Money.fromMinor(treasuryMinor.drawer, tenant.currency)),
      safe: moneyJson(Money.fromMinor(treasuryMinor.safe, tenant.currency)),
      bank: moneyJson(Money.fromMinor(treasuryMinor.bank, tenant.currency)),
    } : null,
    expenses: expenseRows.map((expense) => ({ ...expense, amount: moneyJson(Money.fromMinor(BigInt(expense.amount), expense.currency)) })),
    capabilities: { canViewAccounting, canViewExpenses, canCreateExpenses: ctx.hasPermission(Permissions.EXPENSES_DIRECT_CREATE), canRefund: ctx.hasPermission(Permissions.POS_REFUND), canViewSales, canViewInventory: ctx.hasPermission(Permissions.INVENTORY_ADJUST), canTransferInventory: ctx.hasPermission(Permissions.INVENTORY_TRANSFER), canManageCatalog, canManageStores: ctx.hasPermission(Permissions.STORES_MANAGE), canCloseShift, canClosePeriod, canManageBackups: ctx.hasPermission(Permissions.SYSTEM_BACKUP_MANAGE), canManageUsers, canViewAuditLogs: ctx.hasPermission(Permissions.AUDIT_LOG_VIEW), cashierMode: ctx.roleId === 'CASHIER' },
    lowStock,
    sales,
    customerReturns: customerReturnRows.map((item) => ({ ...item, refundAmount: moneyJson(Money.fromMinor(BigInt(item.refundAmount), item.currency)) })),
    monthlyExpenses,
    monthlyPeriod: { year: monthlyYear, month: monthlyMonth },
    summary: {
      todaySalesCount: canViewSales ? todaysSales.length : null,
      todayRevenue: canViewSales ? moneyJson(Money.fromMinor(BigInt(revenueMinor), tenant.currency)) : null,
      productCount: products.length,
      lowStockCount: lowStock.length,
    },
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
    if (!ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW)) throw Object.assign(new Error('غير مصرح بعرض سجل المبيعات'), { status: 403 });
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
    if (from && to) { reportDay(from); reportDay(to); if (from > to) throw Object.assign(new Error('تاريخ البداية يجب أن يسبق تاريخ النهاية'), { status: 400 }); }
    const conditions = ["tenant_id = ?", "store_id = ?"];
    const args = [ctx.tenantId, storeId];
    if (from && to) { conditions.push("substr(created_at, 1, 10) >= ?", "substr(created_at, 1, 10) <= ?"); args.push(from, to); }
    if (search) {
      conditions.push("(instr(lower(sale_number), lower(?)) > 0 OR instr(lower(coalesce(customer_name, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM sale_items si WHERE si.tenant_id = sales.tenant_id AND si.store_id = sales.store_id AND si.sale_id = sales.id AND (instr(lower(si.product_name), lower(?)) > 0 OR instr(lower(si.sku), lower(?)) > 0)))");
      args.push(search, search, search, search);
    }
    const rawDatabase = database.getRawDatabase();
    const where = conditions.join(' AND ');
    const count = rawDatabase.prepare(`SELECT COUNT(*) AS total FROM sales WHERE ${where}`).get(...args);
    const matches = rawDatabase.prepare(`SELECT id FROM sales WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const sales = (await Promise.all(matches.map((row) => saleRepo.findById(ctx, row.id)))).filter(Boolean);
    const total = Number(count?.total ?? 0);
    const ids = sales.map((sale) => sale.id);
    const returnedLines = ids.length ? await db.selectFrom('customer_return_items').innerJoin('customer_returns', 'customer_returns.id', 'customer_return_items.return_id').innerJoin('sale_items', 'sale_items.id', 'customer_return_items.original_sale_item_id')
      .select(['customer_return_items.original_sale_item_id as itemId', 'customer_return_items.quantity as quantity'])
      .where('customer_return_items.tenant_id', '=', ctx.tenantId).where('customer_returns.store_id', '=', storeId).where('sale_items.sale_id', 'in', ids).execute() : [];
    const returned = new Map();
    for (const line of returnedLines) returned.set(line.itemId, (returned.get(line.itemId) ?? 0n) + BigInt(line.quantity));
    const rows = sales.map(saleJson).map((sale) => ({ ...sale, items: sale.items.map((item) => ({ ...item, returnableQuantity: item.type === 'SALE' ? (BigInt(item.quantity) - (returned.get(item.id) ?? 0n)).toString() : '0' })) }));
    return json(res, 200, { payload: { sales: rows, total, offset, limit } });
  }

  const saleDetailMatch = method === 'GET' ? path.match(/^\/api\/sales\/([0-9a-f-]+)$/i) : null;
  if (saleDetailMatch) {
    const ctx = await requireContext(req);
    if (!ctx.hasPermission(Permissions.REPORTS_DAILY_VIEW)) throw Object.assign(new Error('غير مصرح بعرض تفاصيل الفاتورة'), { status: 403 });
    const sale = await saleRepo.findById(ctx, saleDetailMatch[1]);
    if (!sale) throw Object.assign(new Error('الفاتورة غير موجودة'), { status: 404 });
    const cashier = await userRepo.findById(ctx, sale.cashierUserId);
    const returned = await db.selectFrom('customer_returns').select(['id', 'return_number as returnNumber', 'refund_amount as refundAmount', 'currency', 'payment_method as paymentMethod', 'created_at as createdAt']).where('tenant_id', '=', ctx.tenantId).where('store_id', '=', sale.storeId).where('original_sale_id', '=', sale.id).orderBy('created_at', 'asc').execute();
    return json(res, 200, { payload: { ...saleJson(sale), cashierName: cashier?.fullName ?? 'غير معروف', returns: returned.map((item) => ({ ...item, refundAmount: moneyJson(Money.fromMinor(BigInt(item.refundAmount), item.currency)) })) } });
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
        items: sale.items.map((item) => ({
          productName: item.productName,
          sku: item.sku,
          quantity: item.quantity.toString(),
          unitPrice: moneyJson(item.unitPrice),
          lineTotal: moneyJson(item.netRevenue),
        })),
        total: moneyJson(sale.total),
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
    const failures = failedLogins.get(key) ?? { count: 0, startedAt: Date.now() };
    if (Date.now() - failures.startedAt < LOCK_WINDOW_MS && failures.count >= MAX_FAILED_LOGINS) {
      throw Object.assign(new Error('محاولات كثيرة. انتظر عشر دقائق ثم حاول مرة أخرى.'), { status: 429 });
    }
    try {
      const session = await auth.login({ tenantCode: state.companyCode, username: body.username, password: body.password });
      failedLogins.delete(key);
      const loginCtx = await auth.validateSession(session.token);
      await recordAudit(loginCtx, { storeId: session.user.storeId ?? null, actorUserId: session.user.id, actorUsername: session.user.username, actorRole: session.user.role, action: 'AUTH_LOGIN_SUCCESS', entityType: 'SESSION', entityId: session.user.id, summary: `تسجيل دخول ناجح للمستخدم (${session.user.username})` });
      const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
      return json(res, 200, { user: session.user }, { 'Set-Cookie': `retailos_session=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
    } catch {
      const next = Date.now() - failures.startedAt < LOCK_WINDOW_MS ? failures : { count: 0, startedAt: Date.now() };
      failedLogins.set(key, { count: next.count + 1, startedAt: next.startedAt });
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
          metadata: { attemptCount: next.count + 1 },
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

  if (method === 'POST' && path === '/api/users') {
    ctx.assertPermission(Permissions.USERS_MANAGE);
    const body = validate(CreateUserSchema, await readJson(req));
    try {
      const created = await tenantService.createUser(ctx, {
        id: randomUUID(), username: body.username, passwordPlain: body.password,
        fullName: body.fullName, phone: body.phone || undefined, employmentStartDate: body.employmentStartDate, role: body.role, storeId: body.storeId,
      });
      await recordAudit(ctx, { storeId: created.storeId ?? null, action: 'USER_CREATED', entityType: 'USER', entityId: created.id, summary: `إضافة حساب موظف جديد (${created.username} - ${created.role})`, metadata: { role: created.role, username: created.username } });
      return json(res, 201, { id: created.id, username: created.username });
    } catch (error) {
      if (error?.message?.startsWith('UserError:')) throw Object.assign(new Error('Username is already in use'), { status: 409 });
      if (error?.message?.startsWith('StoreError:')) throw Object.assign(new Error('Selected store is unavailable'), { status: 400 });
      throw error;
    }
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
      await trx.updateTable('users').set({ full_name: body.fullName ?? target.full_name, phone: body.phone === undefined ? target.phone : body.phone || null, employment_start_date: body.employmentStartDate ?? target.employment_start_date, role: nextRole, store_id: nextStoreId, is_active: nextActive ? 1 : 0 }).where('tenant_id', '=', ctx.tenantId).where('id', '=', targetId).execute();
      if (revokeSessions) await trx.updateTable('sessions').set({ is_revoked: 1 }).where('tenant_id', '=', ctx.tenantId).where('user_id', '=', targetId).execute();
    });
    await recordAudit(ctx, { storeId: nextStoreId ?? null, action: 'USER_UPDATED', entityType: 'USER', entityId: targetId, summary: `تحديث بيانات الموظف (${target.username})`, metadata: { role: nextRole, isActive: nextActive, sessionsRevoked: revokeSessions } });
    return json(res, 200, { updated: true, sessionsRevoked: revokeSessions });
  }

  if (method === 'POST' && path === '/api/account/password') {
    const body = validate(PasswordChangeSchema, await readJson(req));
    const currentUser = await userRepo.findById(ctx, ctx.userId);
    if (!currentUser || !await passwordHasher.verify(currentUser.passwordHash, body.currentPassword)) {
      throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
    }
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
        const values = { sku: variant.sku.toUpperCase(), barcode: variant.barcode?.trim() || (existing?.barcode ?? null), attributes_json: JSON.stringify(variant.attributes ?? {}), retail_price: BigInt(variant.retailPrice), currency: tenant.currency, reorder_point: BigInt(variant.reorderPoint), is_active: 1 };
        if (variant.id) await trx.updateTable('product_variants').set(values).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).where('id', '=', variant.id).execute();
        else await trx.insertInto('product_variants').values({ id: randomUUID(), tenant_id: ctx.tenantId, product_id: productId, ...values }).execute();
      }
      for (const variant of omittedVariants) await trx.updateTable('product_variants').set({ is_active: 0 }).where('tenant_id', '=', ctx.tenantId).where('product_id', '=', productId).where('id', '=', variant.id).execute();
    });
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
    await expenses.record(ctx, { ...body, id, amount: BigInt(body.amount), currency: tenant.currency });
    return json(res, 201, { id });
  }

  if (method === 'POST' && path === '/api/recurring-expenses') {
    ctx.assertPermission(Permissions.EXPENSES_MONTHLY_CONFIRM);
    const body = validate(RecurringObligationSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = await recurringExpenses.create(ctx, { ...body, id: randomUUID(), currency: tenant.currency });
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
    const payment = await recurringExpenses.pay(ctx, { ...body, id: randomUUID(), actualId: monthlyPaymentMatch[1], amount: BigInt(body.amount), paidAt: new Date() });
    return json(res, 201, { id: payment.id, remaining: payment.remaining.toString() });
  }

  const returnMatch = method === 'POST' ? path.match(/^\/api\/sales\/([0-9a-f-]+)\/returns$/i) : null;
  if (returnMatch) {
    ctx.assertPermission(Permissions.POS_REFUND);
    const body = validate(CustomerReturnSchema, await readJson(req));
    const result = await returns.record(ctx, { id: randomUUID(), idempotencyKey: body.idempotencyKey,
      storeId: body.storeId, originalSaleId: returnMatch[1], paymentMethod: body.paymentMethod,
      occurredAt: new Date(), lines: body.items.map((item) => ({ originalSaleItemId: item.originalSaleItemId, quantity: BigInt(item.quantity) })) });
    return json(res, 201, { id: result.id, refundAmount: result.refundAmount.toString() });
  }

  if (method === 'POST' && path === '/api/purchases') {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);
    const body = validate(PurchaseSchema, await readJson(req));
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    const id = randomUUID();
    const invoiceNumber = body.invoiceNumber?.trim() || `PUR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`;
    await purchasing.recordPurchase(ctx, {
      id, idempotencyKey: body.idempotencyKey, storeId: body.storeId, supplierId: body.supplierId,
      invoiceNumber,
      totalAmount: Money.fromMinor(BigInt(body.totalAmount), tenant.currency),
      initialPayment: Money.fromMinor(BigInt(body.paidAmount), tenant.currency),
      paymentMethod: body.paymentMethod, referenceNumber: body.referenceNumber,
      notes: body.notes, purchasedAt: new Date(),
      lines: body.items.map((line) => ({ variantId: line.variantId, quantity: BigInt(line.quantity), unitCost: Money.fromMinor(BigInt(line.unitCost), tenant.currency) })),
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'PURCHASE_RECORDED', entityType: 'PURCHASE', entityId: id, summary: `تسجيل فاتورة شراء (${invoiceNumber})`, metadata: { invoiceNumber, totalAmount: body.totalAmount, paidAmount: body.paidAmount } });
    return json(res, 201, { id });
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
    await purchasing.recordSupplierPayment(ctx, {
      id, idempotencyKey: body.idempotencyKey, purchaseId: paymentMatch[1],
      amount: Money.fromMinor(BigInt(body.amount), tenant.currency),
      paymentMethod: body.paymentMethod, referenceNumber: body.referenceNumber, paidAt: new Date(),
    });
    await recordAudit(ctx, { action: 'SUPPLIER_PAYMENT_RECORDED', entityType: 'SUPPLIER_PAYMENT', entityId: id, summary: `تسجيل دفعة لمورد (${body.amount})`, metadata: { purchaseId: paymentMatch[1], amount: body.amount, paymentMethod: body.paymentMethod } });
    return json(res, 201, { id });
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
            { accountCode: '6090', side: 'DEBIT', amount: shortageAmount, memo: 'عجز جرد درج النقدية عند تقفيل الوردية' },
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
            { accountCode: '4010', side: 'CREDIT', amount: varianceMinor, memo: 'فائض جرد درج النقدية عند تقفيل الوردية' },
          ],
        });
      }
      return { bookMinor, varianceMinor, status };
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'SHIFT_CLOSED', entityType: 'CASH_DRAWER', entityId: body.idempotencyKey, summary: `تقفيل وردية وجرد درج النقدية (${shiftResult.status})`, metadata: { status: shiftResult.status, bookBalance: shiftResult.bookMinor.toString(), actualCash: actualMinor.toString(), variance: shiftResult.varianceMinor.toString() } });
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
    const tenant = await tenantRepo.findById(ctx.tenantId);
    if (!tenant) throw Object.assign(new Error('بيانات الشركة غير متاحة'), { status: 404 });
    let cart = Cart.empty(tenant.currency);
    for (const [index, item] of body.items.entries()) {
      const variant = await variantRepo.findById(ctx, item.variantId);
      if (!variant) throw Object.assign(new Error('أحد المنتجات لم يعد متاحًا'), { status: 400 });
      const product = await productRepo.findById(ctx, variant.productId);
      if (!product) throw Object.assign(new Error('أحد المنتجات لم يعد متاحًا'), { status: 400 });
      const optionLabel = Object.entries(variant.attributes).map(([key, value]) => `${product.options.find((option) => option.key === key)?.name ?? key}: ${String(value)}`).join(' - ');
      cart = cart.addItem({ lineId: `line-${index}-${randomUUID()}`, variantId: variant.id, productId: product.id, productName: optionLabel ? `${product.name} - ${optionLabel}` : product.name, sku: variant.sku, unitPrice: variant.retailPrice, quantity: BigInt(item.quantity) });
    }
    const now = new Date();
    const sale = await checkout.checkout(ctx, {
      saleId: randomUUID(), saleNumber: `R-${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 6).toUpperCase()}`,
      storeId: body.storeId, cart,
      payments: [{ method: body.payment.method, amount: Money.fromMinor(BigInt(body.payment.amount), tenant.currency) }],
      idempotencyKey: body.idempotencyKey, customerName: body.customerName, occurredAt: now,
    });
    await recordAudit(ctx, { storeId: body.storeId, action: 'SALE_COMPLETED', entityType: 'SALE', entityId: sale.id, summary: `إتمام عملية بيع (${sale.saleNumber})`, metadata: { saleNumber: sale.saleNumber, total: sale.total.amount.toString(), paymentMethod: body.payment.method } });
    return json(res, 201, saleJson(sale));
  }

  throw Object.assign(new Error('المسار غير موجود'), { status: 404 });
}

function mimeType(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) throw Object.assign(new Error('استخدم عنوان التطبيق المحلي'), { status: 421 });
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw Object.assign(new Error('الطريقة غير مسموحة'), { status: 405 });
    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = resolve(publicDir, `.${normalize(relativePath)}`);
    if (!target.startsWith(`${publicDir}${sep}`) && target !== join(publicDir, 'index.html')) throw Object.assign(new Error('الملف غير موجود'), { status: 404 });
    if (!existsSync(target)) throw Object.assign(new Error('الملف غير موجود'), { status: 404 });
    const content = await readFile(target);
    res.writeHead(200, { 'Content-Type': mimeType(target), 'Cache-Control': 'no-store', ...securityHeaders() });
    res.end(content);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const databaseConflict = typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
    const isDomainClientError = error instanceof DomainError;
    const status = Number.isInteger(error?.status) ? error.status : error?.message?.startsWith('UnauthorizedError') ? 403 : databaseConflict ? 409 : isDomainClientError ? 400 : 500;
    if (status >= 500) console.error('Request failed', error);
    const message = status >= 500 ? 'حصل خطأ داخلي. لم يتم تنفيذ العملية.' : error?.message ?? 'حدث خطأ غير متوقع';
    json(res, status, { error: message });
  }
});

const walCheckpointTimer = setInterval(() => {
  database.checkpointPassive();
  pruneFailedLogins();
  void db
    .deleteFrom('sessions')
    .where((eb) => eb.or([eb('is_revoked', '=', 1), eb('expires_at', '<', new Date().toISOString())]))
    .execute()
    .catch(() => undefined);
}, 5 * 60 * 1000);
walCheckpointTimer.unref();

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
  database.checkpointPassive();
  await database.close();
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
