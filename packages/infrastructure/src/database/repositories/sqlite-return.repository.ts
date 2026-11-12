import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import { Money, type PaymentMethod } from '@retailos/core';
import type { RetailOSDatabase } from '../types.js';
import { applyStockMovementInTransaction } from './stock-movement.executor.js';
import { accountForPaymentMethod, postJournalEntry } from './accounting-journal.executor.js';

export interface CustomerReturnLineInput { originalSaleItemId: string; quantity: bigint }
export interface RecordCustomerReturnInput {
  id: string; idempotencyKey: string; storeId: string; originalSaleId: string;
  paymentMethod: PaymentMethod; occurredAt: Date; lines: readonly CustomerReturnLineInput[];
  returnNumber?: string;
}

function badRequest(message: string): Error { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message: string): Error { return Object.assign(new Error(message), { status: 409 }); }

export class SqliteReturnRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async record(ctx: ExecutionContext, input: RecordCustomerReturnInput): Promise<{ id: string; refundAmount: bigint }> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    if (!input.lines.length || input.lines.length > 100 || input.lines.some((line) => line.quantity <= 0n)) throw badRequest('حدد صنفًا وكمية صالحة للمرتجع');
    if (new Set(input.lines.map((line) => line.originalSaleItemId)).size !== input.lines.length) throw badRequest('لا تكرر الصنف نفسه في المرتجع');

    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('customer_returns').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        const savedLines = await trx.selectFrom('customer_return_items').selectAll().where('return_id', '=', replay.id).execute();
        const savedByItem = new Map(savedLines.map((line) => [line.original_sale_item_id, BigInt(line.quantity)]));
        if (replay.store_id !== input.storeId || replay.original_sale_id !== input.originalSaleId || replay.payment_method !== input.paymentMethod
          || savedLines.length !== input.lines.length || !input.lines.every((line) => savedByItem.get(line.originalSaleItemId) === line.quantity)) {
          throw conflict('مفتاح العملية مستخدم لمرتجع مختلف');
        }
        return { id: replay.id, refundAmount: BigInt(replay.refund_amount) };
      }

      const sale = await trx.selectFrom('sales').selectAll().where('id', '=', input.originalSaleId)
        .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', input.storeId).executeTakeFirst();
      if (!sale || BigInt(sale.total) <= 0n) throw Object.assign(new Error('فاتورة البيع غير متاحة للمرتجع'), { status: 404 });
      const store = await trx.selectFrom('stores').select('id').where('id', '=', input.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!store) throw Object.assign(new Error('الفرع غير متاح'), { status: 404 });

      const returnId = input.id;
      const details: { originalSaleItemId: string; variantId: string; quantity: bigint; amount: bigint; cost: bigint; unitCost: bigint; itemKind: string }[] = [];
      for (const requested of input.lines) {
        const original = await trx.selectFrom('sale_items').innerJoin('products', 'products.id', 'sale_items.product_id')
          .select(['sale_items.id as id', 'sale_items.variant_id as variantId', 'sale_items.product_id as productId', 'sale_items.quantity as quantity', 'sale_items.item_type as itemType', 'sale_items.net_revenue as netRevenue', 'sale_items.cost_of_goods_sold as cost', 'sale_items.unit_cost_snapshot as unitCost', 'sale_items.currency as currency', 'products.item_kind as itemKind'])
          .where('sale_items.id', '=', requested.originalSaleItemId).where('sale_items.sale_id', '=', sale.id)
          .where('sale_items.tenant_id', '=', ctx.tenantId).executeTakeFirst();
        if (!original || original.itemType !== 'SALE') throw badRequest('الصنف المختار مش موجود في فاتورة بيع أصلية');
        const previous = await trx.selectFrom('customer_return_items').innerJoin('customer_returns', 'customer_returns.id', 'customer_return_items.return_id')
          .select(['customer_return_items.quantity as quantity', 'customer_return_items.refund_amount as amount', 'customer_return_items.cost_amount as cost'])
          .where('customer_returns.original_sale_id', '=', sale.id).where('customer_return_items.original_sale_item_id', '=', original.id).execute();
        const soldQuantity = BigInt(original.quantity);
        const returnedQuantity = previous.reduce((sum, line) => sum + BigInt(line.quantity), 0n);
        const remainingQuantity = soldQuantity - returnedQuantity;
        if (requested.quantity > remainingQuantity) throw badRequest('كمية المرتجع أكبر من الكمية المتبقية من الفاتورة');
        const alreadyRefunded = previous.reduce((sum, line) => sum + BigInt(line.amount), 0n);
        const alreadyCosted = previous.reduce((sum, line) => sum + BigInt(line.cost), 0n);
        const originalAmount = BigInt(original.netRevenue);
        const originalCost = BigInt(original.cost);
        const amount = requested.quantity === remainingQuantity ? originalAmount - alreadyRefunded : (originalAmount * requested.quantity) / soldQuantity;
        const cost = requested.quantity === remainingQuantity ? originalCost - alreadyCosted : (originalCost * requested.quantity) / soldQuantity;
        if (amount <= 0n) throw badRequest('قيمة الصنف لا تسمح بتسجيل رد مالي موجب');
        details.push({ originalSaleItemId: original.id, variantId: original.variantId,
          quantity: requested.quantity, amount, cost, unitCost: BigInt(original.unitCost), itemKind: original.itemKind });
      }

      const refundAmount = details.reduce((sum, line) => sum + line.amount, 0n);
      const costAmount = details.reduce((sum, line) => sum + line.cost, 0n);
      const accountCode = accountForPaymentMethod(input.paymentMethod);
      const journalKey = `return:${input.idempotencyKey}`;
      await postJournalEntry(trx, ctx, {
        storeId: sale.store_id, currency: sale.currency, date: input.occurredAt, sourceType: 'RETURN', sourceId: returnId,
        idempotencyKey: journalKey, description: `مرتجع فاتورة ${sale.sale_number}`,
        lines: [
          { accountCode: '4010', side: 'DEBIT', amount: refundAmount, memo: 'قيمة مرتجعة للعميل' },
          { accountCode, side: 'CREDIT', amount: refundAmount, memo: 'رد المبلغ للعميل' },
          ...(costAmount > 0n ? [{ accountCode: '1300', side: 'DEBIT' as const, amount: costAmount, memo: 'إعادة تكلفة الأصناف للمخزون' }, { accountCode: '5010', side: 'CREDIT' as const, amount: costAmount, memo: 'عكس تكلفة البضاعة المباعة' }] : []),
        ],
      });
      const journalEntry = await trx.selectFrom('journal_entries').select('id').where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', journalKey).executeTakeFirstOrThrow();
      await trx.insertInto('customer_returns').values({ id: returnId, tenant_id: ctx.tenantId, store_id: sale.store_id,
        original_sale_id: sale.id, return_number: input.returnNumber || `RET-${input.occurredAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${returnId.slice(0, 6).toUpperCase()}`,
        idempotency_key: input.idempotencyKey, refund_amount: refundAmount, currency: sale.currency,
        payment_method: input.paymentMethod, journal_entry_id: journalEntry.id, created_by_user_id: ctx.userId,
        created_at: input.occurredAt.toISOString() }).execute();

      for (const [index, line] of details.entries()) {
        if (line.itemKind === 'PRODUCT') await applyStockMovementInTransaction(trx, ctx, {
          id: `${returnId}:movement:${index}`, storeId: sale.store_id, variantId: line.variantId, currency: sale.currency,
          movementType: 'CUSTOMER_RETURN', quantityDelta: line.quantity,
          unitCost: Money.fromMinor(line.unitCost, sale.currency),
          sourceType: 'RETURN', sourceId: returnId,
        });
        await trx.insertInto('customer_return_items').values({ id: `${returnId}:item:${index}`, return_id: returnId,
          tenant_id: ctx.tenantId, original_sale_item_id: line.originalSaleItemId, variant_id: line.variantId,
          quantity: line.quantity, refund_amount: line.amount, cost_amount: line.cost }).execute();
      }
      return { id: returnId, refundAmount };
    });
  }
}
