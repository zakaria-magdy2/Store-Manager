import type { ExecutionContext } from '@retailos/application';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';
import { postJournalEntry } from './accounting-journal.executor.js';
import { applyStockMovementInTransaction } from './stock-movement.executor.js';

export interface SupplierReturnLineInput { purchaseItemId: string; quantity: bigint }
function badRequest(message: string): Error { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message: string): Error { return Object.assign(new Error(message), { status: 409 }); }

export class SqliteSupplierReturnRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async record(ctx: ExecutionContext, input: { id: string; idempotencyKey: string; purchaseId: string; storeId: string; occurredAt: Date; lines: readonly SupplierReturnLineInput[] }): Promise<{ id: string; creditAmount: bigint }> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('Store scope mismatch'), { status: 403 });
    if (!input.lines.length || input.lines.length > 100 || input.lines.some((line) => line.quantity <= 0n)) throw badRequest('حدد صنفًا وكمية صالحة للمرتجع');
    if (new Set(input.lines.map((line) => line.purchaseItemId)).size !== input.lines.length) throw badRequest('لا تكرر الصنف نفسه في المرتجع');

    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('supplier_returns').selectAll().where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        const lines = await trx.selectFrom('supplier_return_items').selectAll().where('return_id', '=', replay.id).execute();
        const byId = new Map(lines.map((line) => [line.purchase_item_id, BigInt(line.quantity)]));
        if (replay.purchase_id !== input.purchaseId || replay.store_id !== input.storeId || lines.length !== input.lines.length || !input.lines.every((line) => byId.get(line.purchaseItemId) === line.quantity)) throw conflict('مفتاح العملية مستخدم لمرتجع مورد مختلف');
        return { id: replay.id, creditAmount: BigInt(replay.credit_amount) };
      }
      const purchase = await trx.selectFrom('supplier_purchases').selectAll().where('id', '=', input.purchaseId)
        .where('tenant_id', '=', ctx.tenantId).where('store_id', '=', input.storeId).executeTakeFirst();
      if (!purchase) throw Object.assign(new Error('فاتورة الشراء غير متاحة'), { status: 404 });

      const details: { purchaseItemId: string; variantId: string; quantity: bigint; unitCost: bigint; credit: bigint; inventoryCost: bigint }[] = [];
      for (const requested of input.lines) {
        const original = await trx.selectFrom('supplier_purchase_items').selectAll().where('id', '=', requested.purchaseItemId)
          .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', purchase.id).where('store_id', '=', purchase.store_id).executeTakeFirst();
        if (!original) throw badRequest('الصنف المختار غير موجود في فاتورة الشراء');
        const previous = await trx.selectFrom('supplier_return_items').innerJoin('supplier_returns', 'supplier_returns.id', 'supplier_return_items.return_id')
          .select(['supplier_return_items.quantity as quantity', 'supplier_return_items.credit_amount as credit'])
          .where('supplier_returns.purchase_id', '=', purchase.id).where('supplier_return_items.purchase_item_id', '=', original.id).execute();
        const alreadyReturned = previous.reduce((sum, item) => sum + BigInt(item.quantity), 0n);
        const remaining = BigInt(original.quantity) - alreadyReturned;
        if (requested.quantity > remaining) throw badRequest('كمية المرتجع أكبر من الكمية المتبقية من فاتورة الشراء');
        const movement = await applyStockMovementInTransaction(trx, ctx, {
          id: `${input.id}:movement:${details.length}`, storeId: purchase.store_id, variantId: original.variant_id,
          currency: purchase.currency, movementType: 'SUPPLIER_RETURN', quantityDelta: -requested.quantity,
          sourceType: 'RETURN', sourceId: input.id,
        });
        details.push({ purchaseItemId: original.id, variantId: original.variant_id, quantity: requested.quantity,
          unitCost: BigInt(original.unit_cost), credit: BigInt(original.unit_cost) * requested.quantity,
          inventoryCost: movement.unitCost.amount * requested.quantity });
      }

      const creditAmount = details.reduce((sum, line) => sum + line.credit, 0n);
      const inventoryCost = details.reduce((sum, line) => sum + line.inventoryCost, 0n);
      let journalEntryId: string | null = null;
      if (creditAmount > 0n || inventoryCost > 0n) {
        const lines = [
          ...(creditAmount > 0n ? [{ accountCode: '2010', side: 'DEBIT' as const, amount: creditAmount, memo: 'تخفيض مستحقات فاتورة المورد' }] : []),
          ...(inventoryCost > 0n ? [{ accountCode: '1300', side: 'CREDIT' as const, amount: inventoryCost, memo: 'إخراج أصناف مرتجعة للمورد' }] : []),
          ...(creditAmount > inventoryCost ? [{ accountCode: '5090', side: 'CREDIT' as const, amount: creditAmount - inventoryCost, memo: 'فرق سعر ائتمان المورد عن تكلفة المخزون' }] : []),
          ...(inventoryCost > creditAmount ? [{ accountCode: '5090', side: 'DEBIT' as const, amount: inventoryCost - creditAmount, memo: 'فرق تكلفة المخزون عن ائتمان المورد' }] : []),
        ];
        await postJournalEntry(trx, ctx, { storeId: purchase.store_id, currency: purchase.currency, date: input.occurredAt,
          sourceType: 'SUPPLIER_RETURN', sourceId: input.id, idempotencyKey: `supplier-return:${input.idempotencyKey}`,
          description: `مرتجع مشتريات ${purchase.invoice_number ?? purchase.id}`, lines });
        journalEntryId = (await trx.selectFrom('journal_entries').select('id').where('tenant_id', '=', ctx.tenantId)
          .where('idempotency_key', '=', `supplier-return:${input.idempotencyKey}`).executeTakeFirstOrThrow()).id;
      }
      await trx.insertInto('supplier_returns').values({ id: input.id, tenant_id: ctx.tenantId, store_id: purchase.store_id,
        supplier_id: purchase.supplier_id, purchase_id: purchase.id,
        return_number: `SR-${input.occurredAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${input.id.slice(0, 6).toUpperCase()}`,
        idempotency_key: input.idempotencyKey, credit_amount: creditAmount, currency: purchase.currency,
        journal_entry_id: journalEntryId, created_by_user_id: ctx.userId, created_at: input.occurredAt.toISOString() }).execute();
      for (const [index, line] of details.entries()) await trx.insertInto('supplier_return_items').values({
        id: `${input.id}:item:${index}`, return_id: input.id, tenant_id: ctx.tenantId,
        purchase_item_id: line.purchaseItemId, variant_id: line.variantId, quantity: line.quantity,
        credit_amount: line.credit, inventory_cost: line.inventoryCost,
      }).execute();
      return { id: input.id, creditAmount };
    });
  }
}
