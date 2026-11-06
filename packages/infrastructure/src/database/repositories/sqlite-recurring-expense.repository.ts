import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';
import { postJournalEntry } from './accounting-journal.executor.js';

const names = { RENT: 'إيجار المحل', UTILITIES: 'مرافق وفواتير', TRANSPORT: 'نقل ومواصلات', MAINTENANCE: 'صيانة', SUPPLIES: 'مستلزمات تشغيل', OTHER: 'التزامات أخرى' } as const;
export type MonthlyExpenseCategory = keyof typeof names;
export type MonthlyPaymentMethod = 'CASH_DRAWER' | 'CASH_SAFE' | 'BANK_TRANSFER';
function badRequest(message: string): Error { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message: string): Error { return Object.assign(new Error(message), { status: 409 }); }
function accountFor(method: MonthlyPaymentMethod): string { return method === 'CASH_DRAWER' ? '1010' : method === 'CASH_SAFE' ? '1015' : '1020'; }

export class SqliteRecurringExpenseRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async create(ctx: ExecutionContext, input: { id: string; idempotencyKey: string; storeId: string; categoryCode: MonthlyExpenseCategory; name: string; dueDay: number; currency: string }): Promise<string> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    if (!input.name.trim() || input.dueDay < 1 || input.dueDay > 31) throw badRequest('اسم الالتزام أو يوم الاستحقاق غير صالح');
    return this.db.transaction().execute(async (trx) => {
      const categoryCode = `MONTHLY_${input.categoryCode}`;
      const categoryId = `${ctx.tenantId}:expense-category:${categoryCode}`;
      const replay = await trx.selectFrom('recurring_expense_obligations').selectAll().where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        if (replay.store_id !== input.storeId || replay.category_id !== categoryId || replay.name !== input.name.trim() || replay.due_day_of_month !== input.dueDay || replay.currency !== input.currency) throw conflict('مفتاح العملية مستخدم لالتزام مختلف');
        return replay.id;
      }
      const store = await trx.selectFrom('stores').select('id').where('id', '=', input.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!store) throw Object.assign(new Error('الفرع غير متاح'), { status: 404 });
      await trx.insertInto('expense_categories').values({ id: categoryId, tenant_id: ctx.tenantId, code: categoryCode, name: names[input.categoryCode], expense_type: 'MONTHLY_RECURRING', account_code: '6090' }).onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing()).execute();
      await trx.insertInto('recurring_expense_obligations').values({ id: input.id, tenant_id: ctx.tenantId, store_id: input.storeId, category_id: categoryId, name: input.name.trim(), due_day_of_month: input.dueDay, currency: input.currency, idempotency_key: input.idempotencyKey }).execute();
      return input.id;
    });
  }

  public async confirmActual(ctx: ExecutionContext, input: { obligationId: string; year: number; month: number; amount: bigint; confirmedAt: Date }): Promise<{ id: string; amount: bigint }> {
    if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 9999 || !Number.isInteger(input.month) || input.month < 1 || input.month > 12 || input.amount <= 0n || input.amount > 999_999_999_999_999n) throw badRequest('الشهر أو المبلغ الفعلي غير صالح');
    if (input.year > input.confirmedAt.getUTCFullYear() || (input.year === input.confirmedAt.getUTCFullYear() && input.month > input.confirmedAt.getUTCMonth() + 1)) throw badRequest('لا يمكن تأكيد مصروف لشهر لم يبدأ بعد');
    return this.db.transaction().execute(async (trx) => {
      const obligation = await trx.selectFrom('recurring_expense_obligations').selectAll().where('id', '=', input.obligationId).where('tenant_id', '=', ctx.tenantId).where('is_active', '=', 1).executeTakeFirst();
      if (!obligation || (ctx.storeId && ctx.storeId !== obligation.store_id)) throw Object.assign(new Error('الالتزام الشهري غير متاح'), { status: 404 });
      const existing = await trx.selectFrom('monthly_expense_actuals').selectAll().where('tenant_id', '=', ctx.tenantId).where('obligation_id', '=', obligation.id).where('year', '=', input.year).where('month', '=', input.month).executeTakeFirst();
      if (existing) {
        if (BigInt(existing.amount) !== input.amount) throw conflict('تم تأكيد قيمة مختلفة لهذا الالتزام في الشهر المحدد');
        return { id: existing.id, amount: BigInt(existing.amount) };
      }
      const ym = `${input.year}-${String(input.month).padStart(2, '0')}`;
      const startDate = `${ym}-01`, date = new Date(`${startDate}T12:00:00.000Z`);
      const daysInMonth = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
      const journalKey = `monthly-accrual:${obligation.id}:${ym}`;
      await postJournalEntry(trx, ctx, { storeId: obligation.store_id!, currency: obligation.currency, date, sourceType: 'EXPENSE', sourceId: `${obligation.id}:${ym}`, idempotencyKey: journalKey, description: `استحقاق ${obligation.name} - ${ym}`, lines: [
        { accountCode: '6090', side: 'DEBIT', amount: input.amount, memo: 'إثبات المصروف الشهري' },
        { accountCode: '2020', side: 'CREDIT', amount: input.amount, memo: 'التزام شهري مستحق' },
      ] });
      const period = await trx.selectFrom('accounting_periods').select('id').where('tenant_id', '=', ctx.tenantId).where('start_date', '<=', startDate).where('end_date', '>=', startDate).executeTakeFirstOrThrow();
      const journal = await trx.selectFrom('journal_entries').select('id').where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalKey).executeTakeFirstOrThrow();
      const id = randomUUID();
      await trx.insertInto('monthly_expense_actuals').values({ id, tenant_id: ctx.tenantId, store_id: obligation.store_id, obligation_id: obligation.id, period_id: period.id, year: input.year, month: input.month, days_in_month: daysInMonth, amount: input.amount, currency: obligation.currency, status: 'DUE', paid_amount: 0n, journal_entry_id: journal.id, confirmed_by_user_id: ctx.userId, confirmed_at: input.confirmedAt.toISOString() }).execute();
      return { id, amount: input.amount };
    });
  }

  public async pay(ctx: ExecutionContext, input: { id: string; idempotencyKey: string; actualId: string; amount: bigint; paymentMethod: MonthlyPaymentMethod; referenceNumber?: string; paidAt: Date }): Promise<{ id: string; remaining: bigint }> {
    if (input.amount <= 0n || input.amount > 999_999_999_999_999n) throw badRequest('مبلغ السداد غير صالح');
    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('operating_expense_records').selectAll().where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        if (replay.monthly_actual_id !== input.actualId || BigInt(replay.amount) !== input.amount || replay.payment_method !== input.paymentMethod || replay.reference_number !== (input.referenceNumber ?? null)) throw conflict('مفتاح العملية مستخدم لسداد مختلف');
        const actual = await trx.selectFrom('monthly_expense_actuals').select(['amount', 'paid_amount']).where('id', '=', input.actualId).where('tenant_id', '=', ctx.tenantId).executeTakeFirstOrThrow();
        return { id: replay.id, remaining: BigInt(actual.amount) - BigInt(actual.paid_amount) };
      }
      const actual = await trx.selectFrom('monthly_expense_actuals').selectAll().where('id', '=', input.actualId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!actual || (ctx.storeId && ctx.storeId !== actual.store_id)) throw Object.assign(new Error('المستحق الشهري غير متاح'), { status: 404 });
      const outstanding = BigInt(actual.amount) - BigInt(actual.paid_amount);
      if (input.amount > outstanding) throw badRequest('مبلغ السداد أكبر من المتبقي على الالتزام');
      const obligation = await trx.selectFrom('recurring_expense_obligations').select(['name', 'category_id']).where('id', '=', actual.obligation_id).where('tenant_id', '=', ctx.tenantId).executeTakeFirstOrThrow();
      const sourceAccount = accountFor(input.paymentMethod), journalKey = `monthly-payment:${input.idempotencyKey}`;
      await postJournalEntry(trx, ctx, { storeId: actual.store_id!, currency: actual.currency, date: input.paidAt, sourceType: 'EXPENSE', sourceId: input.id, idempotencyKey: journalKey, description: `سداد ${obligation.name} - ${actual.year}/${String(actual.month).padStart(2, '0')}`, lines: [
        { accountCode: '2020', side: 'DEBIT', amount: input.amount, memo: 'تسوية مستحق شهري' },
        { accountCode: sourceAccount, side: 'CREDIT', amount: input.amount, memo: 'سداد نقدي أو بنكي' },
      ] });
      const journal = await trx.selectFrom('journal_entries').select('id').where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalKey).executeTakeFirstOrThrow();
      await trx.insertInto('operating_expense_records').values({ id: input.id, tenant_id: ctx.tenantId, store_id: actual.store_id, category_id: obligation.category_id, expense_type: 'MONTHLY_RECURRING_PAYMENT', monthly_actual_id: actual.id, expense_date: input.paidAt.toISOString().slice(0, 10), amount: input.amount, currency: actual.currency, payment_method: input.paymentMethod, source_account_code: sourceAccount, notes: null, reference_number: input.referenceNumber ?? null, attachment_path: null, journal_entry_id: journal.id, created_by_user_id: ctx.userId, idempotency_key: input.idempotencyKey }).execute();
      const paidAmount = BigInt(actual.paid_amount) + input.amount;
      const status = paidAmount === BigInt(actual.amount) ? 'PAID' : 'PARTIALLY_PAID';
      await trx.updateTable('monthly_expense_actuals').set({ paid_amount: paidAmount, status }).where('id', '=', actual.id).where('tenant_id', '=', ctx.tenantId).execute();
      return { id: input.id, remaining: BigInt(actual.amount) - paidAmount };
    });
  }
}
