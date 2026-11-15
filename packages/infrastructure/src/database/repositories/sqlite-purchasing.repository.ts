import type { Kysely } from 'kysely';
import type { ExecutionContext } from '@retailos/application';
import type { Money } from '@retailos/core';
import { applyStockMovementInTransaction } from './stock-movement.executor.js';
import { postJournalEntry } from './accounting-journal.executor.js';
import type { RetailOSDatabase } from '../types.js';

export interface PurchaseLineInput {
  variantId: string;
  quantity: bigint;
  unitCost: Money;
  retailPrice?: Money | undefined;
}

export interface RecordPurchaseInput {
  id: string;
  idempotencyKey: string;
  supplierId: string;
  storeId: string;
  invoiceNumber?: string | undefined;
  totalAmount: Money;
  initialPayment: Money;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'MOBILE';
  targetProfitPercent?: number | null | undefined;
  expectedRetailTotal?: Money | undefined;
  referenceNumber?: string | undefined;
  notes?: string | undefined;
  purchasedAt: Date;
  lines: readonly PurchaseLineInput[];
}

export interface RecordSupplierPaymentInput {
  id: string;
  idempotencyKey: string;
  purchaseId: string;
  amount: Money;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'MOBILE';
  referenceNumber?: string | undefined;
  paidAt: Date;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

export class SqlitePurchasingRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async recordPurchase(ctx: ExecutionContext, input: RecordPurchaseInput): Promise<void> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    if (input.totalAmount.currency.code !== input.initialPayment.currency.code) throw badRequest('Purchase currency mismatch');
    if (input.initialPayment.amount > input.totalAmount.amount) throw badRequest('Initial payment exceeds purchase total');
    if (input.lines.length === 0) throw badRequest('Purchase requires at least one stock item');
    if (
      input.targetProfitPercent !== undefined &&
      input.targetProfitPercent !== null &&
      (!Number.isFinite(input.targetProfitPercent) || input.targetProfitPercent < 0 || input.targetProfitPercent > 100000)
    ) {
      throw badRequest('نسبة الربح المستهدفة غير صالحة');
    }
    if (
      input.expectedRetailTotal !== undefined &&
      (input.expectedRetailTotal.currency.code !== input.totalAmount.currency.code || input.expectedRetailTotal.isNegative())
    ) {
      throw badRequest('إجمالي سعر البيع المتوقع غير صالح');
    }
    const calculatedLinesTotal = input.lines.reduce((sum, line) => sum + line.unitCost.amount * line.quantity, 0n);
    if (calculatedLinesTotal !== input.totalAmount.amount) throw badRequest('قيمة الفاتورة لازم تساوي مجموع أصنافها');

    await this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('supplier_purchases').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        const existingLines = await trx.selectFrom('supplier_purchase_items').selectAll()
          .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', replay.id).orderBy('id').execute();
        const existingInitialPayment = await trx.selectFrom('supplier_payments').selectAll()
          .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', replay.id)
          .where('idempotency_key', '=', `${input.idempotencyKey}:initial`).executeTakeFirst();
        const replayExpectedRetail = replay.expected_retail_total === null ? null : BigInt(replay.expected_retail_total);
        const sameRequest = replay.supplier_id === input.supplierId && replay.store_id === input.storeId
          && replay.invoice_number === (input.invoiceNumber ?? null)
          && BigInt(replay.total_amount) === input.totalAmount.amount
          && replay.currency === input.totalAmount.currency.code
          && replayExpectedRetail === (input.expectedRetailTotal?.amount ?? null)
          && existingLines.length === input.lines.length
          && existingLines.every((line, index) => line.variant_id === input.lines[index]?.variantId
            && BigInt(line.quantity) === input.lines[index]?.quantity
            && BigInt(line.unit_cost) === input.lines[index]?.unitCost.amount
            && (line.retail_price === null ? null : BigInt(line.retail_price)) === (input.lines[index]?.retailPrice?.amount ?? null))
          && BigInt(existingInitialPayment?.amount ?? 0) === input.initialPayment.amount
          && (!existingInitialPayment || existingInitialPayment.payment_method === input.paymentMethod);
        if (!sameRequest) throw conflict('مفتاح العملية مستخدم لفاتورة مشتريات مختلفة');
        return;
      }
      const supplier = await trx.selectFrom('suppliers').select('id').where('id', '=', input.supplierId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      const store = await trx.selectFrom('stores').select('id').where('id', '=', input.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!supplier || !store) throw badRequest('Supplier or store is not available in this company');

      await trx.insertInto('supplier_purchases').values({
        id: input.id,
        tenant_id: ctx.tenantId,
        store_id: input.storeId,
        supplier_id: input.supplierId,
        idempotency_key: input.idempotencyKey,
        invoice_number: input.invoiceNumber ?? null,
        purchased_at: input.purchasedAt.toISOString(),
        total_amount: input.totalAmount.amount,
        initial_paid_amount: 0n,
        currency: input.totalAmount.currency.code,
        target_profit_percent: input.targetProfitPercent ?? null,
        expected_retail_total: input.expectedRetailTotal?.amount ?? null,
        notes: input.notes ?? null,
        created_by_user_id: ctx.userId,
      }).execute();

      if (input.initialPayment.amount > 0n) {
        await trx.insertInto('supplier_payments').values({
          id: `${input.id}:payment:initial`,
          tenant_id: ctx.tenantId,
          supplier_id: input.supplierId,
          purchase_id: input.id,
          amount: input.initialPayment.amount,
          currency: input.totalAmount.currency.code,
          payment_method: input.paymentMethod,
          idempotency_key: `${input.idempotencyKey}:initial`,
          reference_number: input.referenceNumber ?? null,
          paid_at: input.purchasedAt.toISOString(),
          created_by_user_id: ctx.userId,
        }).execute();
      }

      for (const [index, line] of input.lines.entries()) {
        if (line.quantity <= 0n || line.unitCost.isNegative()) throw badRequest('Purchase item quantity or cost is invalid');
        if (line.unitCost.currency.code !== input.totalAmount.currency.code) throw badRequest('Purchase item currency mismatch');
        if (line.retailPrice !== undefined) {
          if (line.retailPrice.isNegative() || line.retailPrice.currency.code !== input.totalAmount.currency.code) {
            throw badRequest('سعر البيع المحدد للبند غير صالح');
          }
        }
        const variant = await trx.selectFrom('product_variants')
          .innerJoin('products', 'products.id', 'product_variants.product_id')
          .select([
            'product_variants.id as variantId',
            'product_variants.tenant_id as tenantId',
            'product_variants.product_id as productId',
            'product_variants.sku as sku',
            'product_variants.currency as currency',
            'product_variants.is_active as variantActive',
            'products.name as productName',
            'products.item_kind as itemKind',
            'products.is_active as productActive',
          ])
          .where('product_variants.id', '=', line.variantId)
          .where('product_variants.tenant_id', '=', ctx.tenantId)
          .executeTakeFirst();
        if (!variant || !variant.variantActive || !variant.productActive || variant.itemKind !== 'PRODUCT' || variant.currency !== input.totalAmount.currency.code) {
          throw badRequest('Purchase line must reference an active stock-tracked product in this company currency');
        }

        await trx.insertInto('supplier_purchase_items').values({
          id: `${input.id}:item:${index}`,
          tenant_id: ctx.tenantId,
          store_id: input.storeId,
          purchase_id: input.id,
          variant_id: variant.variantId,
          product_id: variant.productId,
          product_name: variant.productName,
          sku: variant.sku,
          quantity: line.quantity,
          unit_cost: line.unitCost.amount,
          retail_price: line.retailPrice?.amount ?? null,
          currency: input.totalAmount.currency.code,
        }).execute();

        if (line.retailPrice !== undefined) {
          await trx
            .updateTable('product_variants')
            .set({ retail_price: line.retailPrice.amount })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', variant.variantId)
            .execute();
        }

        await applyStockMovementInTransaction(trx, ctx, {
          id: `${input.id}:movement:${index}`,
          storeId: input.storeId,
          variantId: variant.variantId,
          currency: input.totalAmount.currency.code,
          movementType: 'PURCHASE_RECEIPT',
          quantityDelta: line.quantity,
          unitCost: line.unitCost,
          sourceType: 'PURCHASE',
          sourceId: input.id,
        });
      }

      await postJournalEntry(trx, ctx, {
        storeId: input.storeId,
        currency: input.totalAmount.currency.code,
        date: input.purchasedAt,
        sourceType: 'PURCHASE',
        sourceId: input.id,
        idempotencyKey: `purchase:${input.idempotencyKey}`,
        description: `فاتورة مشتريات ${input.invoiceNumber ?? input.id}`,
        lines: [
          { accountCode: '1300', side: 'DEBIT', amount: calculatedLinesTotal, memo: 'إضافة أصناف للمخزون' },
          ...(input.initialPayment.amount > 0n ? [{ accountCode: cashAccount(input.paymentMethod), side: 'CREDIT' as const, amount: input.initialPayment.amount, memo: 'المدفوع عند استلام الفاتورة' }] : []),
          ...(input.totalAmount.amount > input.initialPayment.amount ? [{ accountCode: '2010', side: 'CREDIT' as const, amount: input.totalAmount.amount - input.initialPayment.amount, memo: 'رصيد مستحق للتاجر' }] : []),
        ],
      });
    });
  }

  public async recordSupplierPayment(ctx: ExecutionContext, input: RecordSupplierPaymentInput): Promise<string> {
    if (input.amount.amount <= 0n) throw badRequest('مبلغ السداد لازم يكون أكبر من صفر');
    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('supplier_payments').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        if (replay.purchase_id !== input.purchaseId || BigInt(replay.amount) !== input.amount.amount || replay.payment_method !== input.paymentMethod || replay.reference_number !== (input.referenceNumber ?? null)) {
          throw conflict('مفتاح العملية مستخدم لعملية سداد مختلفة');
        }
        return replay.id;
      }

      const purchase = await trx.selectFrom('supplier_purchases').selectAll()
        .where('id', '=', input.purchaseId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!purchase || (ctx.storeId && ctx.storeId !== purchase.store_id)) throw Object.assign(new Error('فاتورة التاجر غير متاحة'), { status: 404 });
      if (input.amount.currency.code !== purchase.currency) throw badRequest('عملة السداد لا تطابق عملة الفاتورة');
      const payments = await trx.selectFrom('supplier_payments').select('amount')
        .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', purchase.id).execute();
      const paid = BigInt(purchase.initial_paid_amount) + payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
      if (input.amount.amount > BigInt(purchase.total_amount) - paid) throw badRequest('المبلغ أكبر من المديونية المتبقية');

      await trx.insertInto('supplier_payments').values({
        id: input.id,
        tenant_id: ctx.tenantId,
        supplier_id: purchase.supplier_id,
        purchase_id: purchase.id,
        amount: input.amount.amount,
        currency: purchase.currency,
        payment_method: input.paymentMethod,
        idempotency_key: input.idempotencyKey,
        reference_number: input.referenceNumber ?? null,
        paid_at: input.paidAt.toISOString(),
        created_by_user_id: ctx.userId,
      }).execute();

      await postJournalEntry(trx, ctx, {
        storeId: purchase.store_id,
        currency: purchase.currency,
        date: input.paidAt,
        sourceType: 'PURCHASE_PAYMENT',
        sourceId: input.id,
        idempotencyKey: `supplier-payment:${input.idempotencyKey}`,
        description: `سداد فاتورة التاجر ${purchase.invoice_number ?? purchase.id}`,
        lines: [
          { accountCode: '2010', side: 'DEBIT', amount: input.amount.amount, memo: 'تخفيض مديونية التاجر' },
          { accountCode: cashAccount(input.paymentMethod), side: 'CREDIT', amount: input.amount.amount, memo: 'صرف دفعة للتاجر' },
        ],
      });
      return input.id;
    });
  }
}

function cashAccount(method: RecordPurchaseInput['paymentMethod']): string {
  return method === 'CASH' ? '1010' : '1020';
}
