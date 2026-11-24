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

export interface UpdateExpenseInput {
  idempotencyKey: string;
  expenseId: string;
  categoryCode: (typeof categories)[number][0];
  amount: bigint;
  paymentMethod: 'CASH_DRAWER' | 'CASH_SAFE' | 'BANK_TRANSFER';
  expenseDate: string;
  notes?: string | undefined;
  referenceNumber?: string | undefined;
  updatedAt: Date;
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
        storeId: input.storeId, currency: input.currency, date: new Date(),
        entryDate: input.expenseDate,
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

  /**
   * Soft-voids a direct operating expense by posting a balanced reversal journal entry
   * and marking `deleted_at` so historical reports and Financial Path running balances recalculate cleanly.
   */
  public async softDelete(
    ctx: ExecutionContext,
    input: { expenseId: string; deletedAt: Date },
  ): Promise<{ id: string; storeId: string; amount: bigint; expenseDate: string; paymentMethod: string; categoryName: string }> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('operating_expense_records as oer')
        .leftJoin('expense_categories as ec', (join) =>
          join.onRef('ec.id', '=', 'oer.category_id').onRef('ec.tenant_id', '=', 'oer.tenant_id'),
        )
        .select([
          'oer.id as id',
          'oer.store_id as storeId',
          'oer.expense_type as expenseType',
          'oer.expense_date as expenseDate',
          'oer.amount as amount',
          'oer.currency as currency',
          'oer.payment_method as paymentMethod',
          'oer.source_account_code as sourceAccountCode',
          'oer.deleted_at as deletedAt',
          'ec.name as categoryName',
        ])
        .where('oer.tenant_id', '=', ctx.tenantId)
        .where('oer.id', '=', input.expenseId)
        .executeTakeFirst();

      if (!row || (ctx.storeId && row.storeId !== ctx.storeId)) {
        throw Object.assign(new Error('سجل المصروف غير موجود'), { status: 404 });
      }
      if (row.deletedAt) {
        throw Object.assign(new Error('تم حذف هذا المصروف بالفعل'), { status: 409 });
      }
      if (row.expenseType !== 'DIRECT_DAILY' || !row.storeId) {
        throw Object.assign(new Error('الالتزامات الشهرية المسددة لا يمكن حذفها من هنا'), { status: 400 });
      }

      const amountMinor = BigInt(row.amount);
      const reversalKey = `expense-void:${row.id}`;
      const categoryLabel = row.categoryName || 'مصروف تشغيلي';
      await postJournalEntry(trx, ctx, {
        storeId: row.storeId,
        currency: row.currency,
        date: input.deletedAt,
        entryDate: row.expenseDate,
        sourceType: 'EXPENSE',
        sourceId: row.id,
        idempotencyKey: reversalKey,
        description: `إلغاء / عكس ${categoryLabel}`,
        lines: [
          { accountCode: row.sourceAccountCode, side: 'DEBIT', amount: amountMinor, memo: 'رد قيمة مصروف ملغى' },
          { accountCode: '6090', side: 'CREDIT', amount: amountMinor, memo: `عكس ${categoryLabel}` },
        ],
      });
      const reversalJournal = await trx
        .selectFrom('journal_entries')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', reversalKey)
        .executeTakeFirstOrThrow();

      const updateRes = await trx
        .updateTable('operating_expense_records')
        .set({
          deleted_at: input.deletedAt.toISOString(),
          deleted_by_user_id: ctx.userId,
          reversal_journal_entry_id: reversalJournal.id,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (updateRes.numUpdatedRows !== 1n) {
        throw Object.assign(new Error('تعذر حذف المصروف لتزامن طلب آخر'), { status: 409 });
      }

      return {
        id: row.id,
        storeId: row.storeId,
        amount: amountMinor,
        expenseDate: row.expenseDate,
        paymentMethod: row.paymentMethod,
        categoryName: categoryLabel,
      };
    });
  }

  public async update(
    ctx: ExecutionContext,
    input: UpdateExpenseInput,
  ): Promise<{
    id: string;
    storeId: string;
    oldAmount: bigint;
    newAmount: bigint;
    oldMethod: string;
    newMethod: string;
    categoryName: string;
  }> {
    if (input.amount <= 0n || input.amount > 999_999_999_999_999n) {
      throw Object.assign(new Error('قيمة المصروف غير صالحة'), { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate) || new Date(`${input.expenseDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.expenseDate) {
      throw Object.assign(new Error('تاريخ المصروف غير صالح'), { status: 400 });
    }
    const category = categories.find(([code]) => code === input.categoryCode);
    if (!category) throw Object.assign(new Error('تصنيف المصروف غير متاح'), { status: 400 });

    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('operating_expense_records as oer')
        .leftJoin('expense_categories as ec', (join) =>
          join.onRef('ec.id', '=', 'oer.category_id').onRef('ec.tenant_id', '=', 'oer.tenant_id'),
        )
        .select([
          'oer.id as id',
          'oer.store_id as storeId',
          'oer.category_id as categoryId',
          'oer.expense_type as expenseType',
          'oer.expense_date as expenseDate',
          'oer.amount as amount',
          'oer.currency as currency',
          'oer.payment_method as paymentMethod',
          'oer.source_account_code as sourceAccountCode',
          'oer.notes as notes',
          'oer.reference_number as referenceNumber',
          'oer.journal_entry_id as journalEntryId',
          'oer.deleted_at as deletedAt',
          'ec.name as categoryName',
        ])
        .where('oer.tenant_id', '=', ctx.tenantId)
        .where('oer.id', '=', input.expenseId)
        .executeTakeFirst();

      if (!row || (ctx.storeId && row.storeId !== ctx.storeId)) {
        throw Object.assign(new Error('سجل المصروف غير موجود'), { status: 404 });
      }
      if (row.deletedAt) {
        throw Object.assign(new Error('لا يمكن تعديل مصروف محذوف'), { status: 409 });
      }
      if (row.expenseType !== 'DIRECT_DAILY' || !row.storeId) {
        throw Object.assign(new Error('الالتزامات الشهرية لا يمكن تعديلها من هنا'), { status: 400 });
      }

      const oldAmount = BigInt(row.amount);
      const newCategoryId = `${ctx.tenantId}:expense-category:${input.categoryCode}`;
      const newSourceAccount = input.paymentMethod === 'CASH_DRAWER' ? '1010' : input.paymentMethod === 'CASH_SAFE' ? '1015' : '1020';
      const newNotes = input.notes?.trim() || null;
      const newRef = input.referenceNumber?.trim() || null;
      const editKey = `expense-edit:${input.idempotencyKey}`;

      const existingEditJournal = await trx
        .selectFrom('journal_entries')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', editKey)
        .executeTakeFirst();
      if (existingEditJournal) {
        if (
          oldAmount !== input.amount ||
          row.paymentMethod !== input.paymentMethod ||
          row.expenseDate !== input.expenseDate ||
          row.categoryId !== newCategoryId ||
          (row.notes ?? null) !== newNotes ||
          (row.referenceNumber ?? null) !== newRef
        ) {
          throw Object.assign(new Error('مفتاح التعديل مستخدم لتعديل مصروف مختلف'), { status: 409 });
        }
        return {
          id: row.id,
          storeId: row.storeId,
          oldAmount,
          newAmount: input.amount,
          oldMethod: row.paymentMethod,
          newMethod: input.paymentMethod,
          categoryName: category[1],
        };
      }

      await trx
        .insertInto('expense_categories')
        .values({
          id: newCategoryId,
          tenant_id: ctx.tenantId,
          code: input.categoryCode,
          name: category[1],
          expense_type: 'DIRECT_DAILY',
          account_code: '6090',
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing())
        .execute();

      let nextJournalEntryId = row.journalEntryId;
      const financialChanged =
        oldAmount !== input.amount ||
        row.paymentMethod !== input.paymentMethod ||
        row.expenseDate !== input.expenseDate ||
        row.categoryId !== newCategoryId;

      if (financialChanged) {
        const oldCategoryLabel = row.categoryName || 'مصروف تشغيلي';
        await postJournalEntry(trx, ctx, {
          storeId: row.storeId,
          currency: row.currency,
          date: input.updatedAt,
          entryDate: row.expenseDate,
          sourceType: 'EXPENSE',
          sourceId: row.id,
          idempotencyKey: `expense-edit-rev:${input.idempotencyKey}`,
          description: `عكس مصروف سابق للتعديل (${oldCategoryLabel})`,
          lines: [
            { accountCode: row.sourceAccountCode, side: 'DEBIT', amount: oldAmount, memo: 'رد قيمة مصروف قبل التعديل' },
            { accountCode: '6090', side: 'CREDIT', amount: oldAmount, memo: `عكس ${oldCategoryLabel} قبل التعديل` },
          ],
        });

        await postJournalEntry(trx, ctx, {
          storeId: row.storeId,
          currency: row.currency,
          date: new Date(`${input.expenseDate}T12:00:00.000Z`),
          entryDate: input.expenseDate,
          sourceType: 'EXPENSE',
          sourceId: row.id,
          idempotencyKey: editKey,
          description: `تعديل مصروف ${category[1]}`,
          lines: [
            { accountCode: '6090', side: 'DEBIT', amount: input.amount, memo: `${category[1]} (معدّل)` },
            { accountCode: newSourceAccount, side: 'CREDIT', amount: input.amount, memo: 'دفع المصروف المعدّل' },
          ],
        });

        const nextJournal = await trx
          .selectFrom('journal_entries')
          .select('id')
          .where('tenant_id', '=', ctx.tenantId)
          .where('idempotency_key', '=', editKey)
          .executeTakeFirstOrThrow();
        nextJournalEntryId = nextJournal.id;
      }

      await trx
        .updateTable('operating_expense_records')
        .set({
          category_id: newCategoryId,
          expense_date: input.expenseDate,
          amount: input.amount,
          payment_method: input.paymentMethod,
          source_account_code: newSourceAccount,
          notes: newNotes,
          reference_number: newRef,
          journal_entry_id: nextJournalEntryId,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.id)
        .where('deleted_at', 'is', null)
        .execute();

      return {
        id: row.id,
        storeId: row.storeId,
        oldAmount,
        newAmount: input.amount,
        oldMethod: row.paymentMethod,
        newMethod: input.paymentMethod,
        categoryName: category[1],
      };
    });
  }
}

