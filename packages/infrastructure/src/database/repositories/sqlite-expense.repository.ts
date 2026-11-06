import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';
import { postJournalEntry } from './accounting-journal.executor.js';

const categories = [
  ['RENT', 'إيجار المحل'],
  ['UTILITIES', 'مرافق وفواتير'],
  ['TRANSPORT', 'نقل ومواصلات'],
  ['MAINTENANCE', 'صيانة'],
  ['SUPPLIES', 'مستلزمات تشغيل'],
  ['OTHER', 'مصروفات أخرى'],
] as const;

export interface RecordExpenseInput {
  id: string;
  idempotencyKey: string;
  storeId: string;
  categoryCode: (typeof categories)[number][0];
  amount: bigint;
  currency: string;
  paymentMethod: 'CASH_DRAWER' | 'CASH_SAFE' | 'BANK_TRANSFER';
  expenseDate: string;
  notes?: string;
  referenceNumber?: string;
}

export class SqliteExpenseRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async record(ctx: ExecutionContext, input: RecordExpenseInput): Promise<string> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    if (input.amount <= 0n || input.amount > 999_999_999_999_999n) throw Object.assign(new Error('قيمة المصروف غير صالحة'), { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate) || new Date(`${input.expenseDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.expenseDate) {
      throw Object.assign(new Error('تاريخ المصروف غير صالح'), { status: 400 });
    }

    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('operating_expense_records').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        if (replay.store_id !== input.storeId || replay.category_id !== `${ctx.tenantId}:expense-category:${input.categoryCode}`
          || BigInt(replay.amount) !== input.amount || replay.expense_date !== input.expenseDate
          || replay.payment_method !== input.paymentMethod || replay.notes !== (input.notes ?? null)
          || replay.reference_number !== (input.referenceNumber ?? null)) {
          throw Object.assign(new Error('مفتاح العملية مستخدم لمصروف مختلف'), { status: 409 });
        }
        return replay.id;
      }

      const store = await trx.selectFrom('stores').select('id').where('id', '=', input.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!store) throw Object.assign(new Error('الفرع غير متاح'), { status: 404 });
      const category = categories.find(([code]) => code === input.categoryCode);
      if (!category) throw Object.assign(new Error('تصنيف المصروف غير متاح'), { status: 400 });
      const categoryId = `${ctx.tenantId}:expense-category:${input.categoryCode}`;
      await trx.insertInto('expense_categories').values({
        id: categoryId, tenant_id: ctx.tenantId, code: input.categoryCode, name: category[1],
        expense_type: 'DIRECT_DAILY', account_code: '6090',
      }).onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing()).execute();
      const accountCode = input.paymentMethod === 'CASH_DRAWER' ? '1010' : input.paymentMethod === 'CASH_SAFE' ? '1015' : '1020';
      const journalIdempotencyKey = `expense:${input.idempotencyKey}`;
      await postJournalEntry(trx, ctx, {
        storeId: input.storeId, currency: input.currency, date: new Date(`${input.expenseDate}T12:00:00.000Z`),
        sourceType: 'EXPENSE', sourceId: input.id, idempotencyKey: journalIdempotencyKey,
        description: `مصروف ${category[1]}`,
        lines: [
          { accountCode: '6090', side: 'DEBIT', amount: input.amount, memo: category[1] },
          { accountCode, side: 'CREDIT', amount: input.amount, memo: 'دفع المصروف' },
        ],
      });
      await trx.insertInto('operating_expense_records').values({
        id: input.id, tenant_id: ctx.tenantId, store_id: input.storeId, category_id: categoryId,
        expense_type: 'DIRECT_DAILY', monthly_actual_id: null, expense_date: input.expenseDate,
        amount: input.amount, currency: input.currency, payment_method: input.paymentMethod,
        source_account_code: accountCode, notes: input.notes ?? null, reference_number: input.referenceNumber ?? null,
        attachment_path: null, journal_entry_id: await trx.selectFrom('journal_entries').select('id')
          .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', journalIdempotencyKey).executeTakeFirstOrThrow().then((row) => row.id),
        created_by_user_id: ctx.userId, idempotency_key: input.idempotencyKey,
      }).execute();
      return input.id;
    });
  }
}

