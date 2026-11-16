import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export interface JournalLineInput {
  accountCode: string;
  side: 'DEBIT' | 'CREDIT';
  amount: bigint;
  memo: string;
}

const accountDefaults = [
  ['1010', 'درج النقدية', 'ASSET', 'DEBIT'],
  ['1015', 'الخزينة', 'ASSET', 'DEBIT'],
  ['1020', 'البنك والتحصيل الإلكتروني', 'ASSET', 'DEBIT'],
  ['1300', 'المخزون', 'ASSET', 'DEBIT'],
  ['2010', 'مستحقات التجار', 'LIABILITY', 'CREDIT'],
  ['2020', 'التزامات مستحقة', 'LIABILITY', 'CREDIT'],
  ['4010', 'إيرادات المبيعات', 'REVENUE', 'CREDIT'],
  ['5010', 'تكلفة البضاعة المباعة', 'EXPENSE', 'DEBIT'],
  ['5090', 'فروق تكلفة المورد والمخزون', 'EXPENSE', 'DEBIT'],
  ['6090', 'مصروفات تشغيل عامة', 'EXPENSE', 'DEBIT'],
] as const;

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

export function resolveValidTimeZone(candidate?: string | null): string {
  const tz = (candidate ?? '').trim() || 'Africa/Cairo';
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(0));
    return tz;
  } catch {
    return 'Africa/Cairo';
  }
}

/**
 * Formats an instant as `YYYY-MM-DD` in the store/tenant's IANA business timezone
 * (e.g. Africa/Cairo), ensuring late-night sales match business-local periods.
 */
export function businessDateInTimeZone(date: Date, timeZone = 'Africa/Cairo'): string {
  const safeTz = resolveValidTimeZone(timeZone);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export async function postJournalEntry(
  trx: Kysely<RetailOSDatabase>,
  ctx: ExecutionContext,
  input: {
    storeId: string;
    currency: string;
    date: Date;
    entryDate?: string | undefined;
    sourceType: 'EXPENSE' | 'SALE' | 'PURCHASE' | 'PURCHASE_PAYMENT' | 'SUPPLIER_RETURN' | 'RETURN' | 'TRANSFER' | 'ADJUSTMENT' | 'SESSION_CLOSING';
    sourceId: string;
    idempotencyKey: string;
    description: string;
    lines: readonly JournalLineInput[];
  },
): Promise<void> {
  const debits = input.lines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + line.amount, 0n);
  const credits = input.lines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + line.amount, 0n);
  if (debits <= 0n || debits !== credits || input.lines.some((line) => line.amount <= 0n)) {
    throw new Error('AccountingInvariantError: journal entry is not balanced');
  }

  let accounts = await trx
    .selectFrom('accounts')
    .select(['id', 'account_code'])
    .where('tenant_id', '=', ctx.tenantId)
    .execute();
  const existingCodes = new Set(accounts.map((a) => a.account_code));
  const missingDefaults = accountDefaults.filter(([code]) => !existingCodes.has(code));
  if (missingDefaults.length > 0) {
    for (const [accountCode, accountName, accountType, normalBalance] of missingDefaults) {
      await trx.insertInto('accounts').values({
        id: ctx.tenantId + ':account:' + accountCode,
        tenant_id: ctx.tenantId,
        account_code: accountCode,
        account_name: accountName,
        account_type: accountType,
        normal_balance: normalBalance,
      }).onConflict((oc) => oc.columns(['tenant_id', 'account_code']).doNothing()).execute();
    }
    accounts = await trx
      .selectFrom('accounts')
      .select(['id', 'account_code'])
      .where('tenant_id', '=', ctx.tenantId)
      .execute();
  }

  let date: string;
  if (input.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(input.entryDate)) {
    date = input.entryDate;
  } else {
    const tenantRow = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirst();
    date = businessDateInTimeZone(input.date, tenantRow?.timezone ?? 'Africa/Cairo');
  }

  let period = await trx.selectFrom('accounting_periods').selectAll().where('tenant_id', '=', ctx.tenantId)
    .where('start_date', '<=', date).where('end_date', '>=', date).executeTakeFirst();
  if (period && period.status !== 'OPEN') throw conflict('الفترة المحاسبية مقفلة ولا تقبل قيودًا جديدة');
  if (!period) {
    const year = Number.parseInt(date.slice(0, 4), 10);
    const month = Number.parseInt(date.slice(5, 7), 10);
    const ym = date.slice(0, 7);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const startDate = `${ym}-01`;
    const endDate = `${ym}-${String(daysInMonth).padStart(2, '0')}`;
    const overlapping = await trx.selectFrom('accounting_periods').select('id').where('tenant_id', '=', ctx.tenantId)
      .where('start_date', '<=', endDate).where('end_date', '>=', startDate).executeTakeFirst();
    if (overlapping) throw conflict('تعذر إنشاء فترة محاسبية بسبب تداخل الفترات');
    const periodId = `${ctx.tenantId}:period:${ym}`;
    await trx.insertInto('accounting_periods').values({
      id: periodId, tenant_id: ctx.tenantId, name: ym, start_date: startDate, end_date: endDate,
      status: 'OPEN', closed_at: null, closed_by_user_id: null,
    }).execute();
    period = await trx.selectFrom('accounting_periods').selectAll().where('id', '=', periodId).executeTakeFirstOrThrow();
  }

  const accountIds = new Map(accounts.map((account) => [account.account_code, account.id]));
  const journalId = randomUUID();
  const createdAt = input.date.toISOString();
  await trx.insertInto('journal_entries').values({
    id: journalId, tenant_id: ctx.tenantId, store_id: input.storeId, period_id: period.id,
    entry_number: 'J-' + createdAt.replace(/\D/g, '').slice(0, 14) + '-' + journalId.slice(0, 6).toUpperCase(),
    entry_date: date, source_type: input.sourceType, source_id: input.sourceId,
    idempotency_key: input.idempotencyKey, status: 'POSTED', reversed_by_entry_id: null,
    created_at: createdAt, created_by_user_id: ctx.userId,
  }).execute();
  await trx.insertInto('journal_lines').values(input.lines.map((line) => {
    const accountId = accountIds.get(line.accountCode);
    if (!accountId) throw new Error('AccountingInvariantError: missing account ' + line.accountCode);
    return {
      id: randomUUID(), journal_entry_id: journalId, account_id: accountId,
      entry_type: line.side, amount: line.amount, currency: input.currency,
      memo: input.description + ' — ' + line.memo,
    };
  })).execute();
}

export function accountForPaymentMethod(method: string): string {
  return method === 'CASH' ? '1010' : '1020';
}
