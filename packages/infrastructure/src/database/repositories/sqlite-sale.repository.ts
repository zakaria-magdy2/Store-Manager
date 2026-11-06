import type { Kysely, Selectable } from 'kysely';
import {
  InventoryPosition,
  InvalidSaleError,
  Money,
  Sale,
  SaleItem,
  SalePayment,
} from '@retailos/core';
import type {
  PaymentMethod,
  ProductAttributes,
  SaleItemType,
  SaleStatus,
} from '@retailos/core';
import type {
  CheckoutOptions,
  CheckoutRepository,
  ExecutionContext,
  SaleDraft,
  SaleRepository,
} from '@retailos/application';
import type {
  RetailOSDatabase,
  SaleItemsTable,
  SalePaymentsTable,
  SalesTable,
} from '../types.js';
import { toBigInt } from '../values.js';
import {
  applyStockMovementInTransaction,
  findInventoryRow,
  toInventoryPosition,
} from './stock-movement.executor.js';
import { accountForPaymentMethod, postJournalEntry } from './accounting-journal.executor.js';

type Executor = Kysely<RetailOSDatabase>;
type SaleRow = Selectable<SalesTable>;
type SaleItemRow = Selectable<SaleItemsTable>;
type SalePaymentRow = Selectable<SalePaymentsTable>;

/**
 * SQLite implementation of both sides of the checkout boundary:
 * `CheckoutRepository` writes an immutable sale, `SaleRepository` reads it back.
 *
 * The whole checkout (stock movements, sale header, lines and tenders) runs in a
 * single transaction. COGS is snapshotted from the live WAC *inside* that
 * transaction, so the sale ledger can never disagree with the stock ledger
 * (ADR-004 / ADR-014).
 *
 * Phase 4 intentionally does not post double-entry journal entries: the chart of
 * accounts and accounting engine arrive in Phase 5.
 */
export class SqliteSaleRepository implements CheckoutRepository, SaleRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async persistCheckout(
    ctx: ExecutionContext,
    draft: SaleDraft,
    options: CheckoutOptions,
  ): Promise<Sale> {
    if (draft.tenantId !== ctx.tenantId) {
      throw new Error(
        'TenantIsolationViolation: Cannot persist a sale for a different tenantId',
      );
    }
    if (ctx.storeId !== undefined && draft.storeId !== ctx.storeId) {
      throw new Error('UnauthorizedError: Cannot persist a checkout for another store');
    }
    if (draft.items.length === 0) {
      throw new InvalidSaleError('A checkout requires at least one item');
    }
    if (draft.payments.length === 0) {
      throw new InvalidSaleError('A checkout requires at least one payment');
    }

    return this.db.transaction().execute(async (trx) => {
      // Replay protection: a repeated idempotency key returns the original sale
      // without touching stock a second time.
      const replay = await this.findSaleBy(
        trx,
        ctx,
        'idempotency_key',
        draft.idempotencyKey,
      );
      if (replay) {
        if (!matchesDraft(replay, draft)) {
          throw new InvalidSaleError(
            `Idempotency key '${draft.idempotencyKey}' was already used for a different checkout`,
          );
        }
        return replay;
      }

      const items: SaleItem[] = [];
      for (const [index, draftItem] of draft.items.entries()) {
        const isSale = draftItem.type === 'SALE';

        let unitCostSnapshot = Money.zero(draft.currency);
        if (draftItem.stockTracked !== false) {
          // A return restocks at the prevailing WAC. Original-sale linkage is
          // part of the future returns workflow.
          let returnUnitCost: Money | undefined;
          if (!isSale) {
            const row = await findInventoryRow(trx, ctx, draft.storeId, draftItem.variantId);
            const position = row
              ? toInventoryPosition(row)
              : InventoryPosition.empty(draftItem.variantId, draft.currency);
            returnUnitCost = position.wacCost;
          }
          const movement = await applyStockMovementInTransaction(trx, ctx, {
            id: `${draft.id}:movement:${index}`,
            storeId: draft.storeId,
            variantId: draftItem.variantId,
            currency: draft.currency,
            movementType: isSale ? 'SALE' : 'CUSTOMER_RETURN',
            quantityDelta: isSale ? -draftItem.quantity : draftItem.quantity,
            unitCost: isSale ? undefined : returnUnitCost,
            sourceType: isSale ? 'SALE' : 'RETURN',
            sourceId: draft.id,
            allowNegativeStock: options.allowNegativeStock,
          });
          unitCostSnapshot = movement.unitCost;
        }

        items.push(
          SaleItem.create({
            id: draftItem.id,
            variantId: draftItem.variantId,
            productId: draftItem.productId,
            productName: draftItem.productName,
            sku: draftItem.sku,
            variantAttributes: draftItem.variantAttributes ?? {},
            type: draftItem.type,
            quantity: draftItem.quantity,
            unitPrice: draftItem.unitPrice,
            lineDiscount: draftItem.lineDiscount,
            cartDiscountShare: draftItem.cartDiscountShare,
            unitCostSnapshot,
            createdAt: draft.createdAt,
          }),
        );
      }

      const sale = Sale.create({
        id: draft.id,
        tenantId: draft.tenantId,
        storeId: draft.storeId,
        saleNumber: draft.saleNumber,
        idempotencyKey: draft.idempotencyKey,
        cashierUserId: draft.cashierUserId,
        customerName: draft.customerName,
        currency: draft.currency,
        items,
        payments: draft.payments,
        createdAt: draft.createdAt,
      });

      if (!sale.total.equals(draft.total)) {
        throw new InvalidSaleError(
          `Checkout total ${sale.total.toDecimalString()} does not match the draft total ${draft.total.toDecimalString()}`,
        );
      }

      await trx
        .insertInto('sales')
        .values({
          id: sale.id,
          tenant_id: sale.tenantId,
          store_id: sale.storeId,
          sale_number: sale.saleNumber,
          idempotency_key: sale.idempotencyKey,
          customer_name: sale.customerName ?? null,
          currency: sale.currency,
          subtotal: sale.subtotal.amount,
          discount_total: sale.discountTotal.amount,
          total: sale.total.amount,
          paid_total: sale.paidTotal.amount,
          change_given: sale.changeGiven.amount,
          cashier_user_id: sale.cashierUserId,
          status: sale.status,
          created_at: sale.createdAt.toISOString(),
        })
        .execute();

      await trx
        .insertInto('sale_items')
        .values(
          items.map((item, index) => ({
            id: item.id,
            sale_id: sale.id,
            tenant_id: sale.tenantId,
            store_id: sale.storeId,
            line_number: index,
            variant_id: item.variantId,
            product_id: item.productId,
            product_name: item.productName,
            sku: item.sku,
            variant_attributes_json: JSON.stringify(item.variantAttributes),
            item_type: item.type,
            quantity: item.quantity,
            unit_price: item.unitPrice.amount,
            line_discount: item.lineDiscount.amount,
            cart_discount_share: item.cartDiscountShare.amount,
            net_revenue: item.netRevenue.amount,
            unit_cost_snapshot: item.unitCostSnapshot.amount,
            cost_of_goods_sold: item.costOfGoodsSold.amount,
            currency: sale.currency,
            created_at: sale.createdAt.toISOString(),
          })),
        )
        .execute();

      await trx
        .insertInto('sale_payments')
        .values(
          sale.payments.map((payment, index) => ({
            id: payment.id,
            sale_id: sale.id,
            tenant_id: sale.tenantId,
            tender_index: index,
            method: payment.method,
            amount: payment.amount.amount,
            created_at: sale.createdAt.toISOString(),
          })),
        )
        .execute();

      const tenderTotals = new Map<string, bigint>();
      for (const payment of sale.payments) {
        const accountCode = accountForPaymentMethod(payment.method);
        tenderTotals.set(accountCode, (tenderTotals.get(accountCode) ?? 0n) + payment.amount.amount);
      }
      const cogs = sale.items.reduce((sum, item) => sum + item.costOfGoodsSold.amount, 0n);
      await postJournalEntry(trx, ctx, {
        storeId: sale.storeId,
        currency: sale.currency,
        date: sale.createdAt,
        sourceType: 'SALE',
        sourceId: sale.id,
        idempotencyKey: 'sale:' + sale.idempotencyKey,
        description: 'مبيعات ' + sale.saleNumber,
        lines: [
          ...[...tenderTotals.entries()].map(([accountCode, amount]) => ({ accountCode, side: 'DEBIT' as const, amount, memo: 'تحصيل من عملية البيع' })),
          ...(cogs > 0n ? [{ accountCode: '5010', side: 'DEBIT' as const, amount: cogs, memo: 'تكلفة الأصناف المباعة' }] : []),
          { accountCode: '4010', side: 'CREDIT', amount: sale.total.amount, memo: 'إيراد البيع' },
          ...(sale.changeGiven.amount > 0n ? [{ accountCode: '1010', side: 'CREDIT' as const, amount: sale.changeGiven.amount, memo: 'باقي نقدي للعميل' }] : []),
          ...(cogs > 0n ? [{ accountCode: '1300', side: 'CREDIT' as const, amount: cogs, memo: 'تخفيض قيمة المخزون' }] : []),
        ],
      });

      return sale;
    });
  }

  public async findById(ctx: ExecutionContext, saleId: string): Promise<Sale | null> {
    const query = this.db
      .selectFrom('sales')
      .selectAll()
      .where('id', '=', saleId)
      .where('tenant_id', '=', ctx.tenantId);
    const row =
      ctx.storeId !== undefined
        ? await query.where('store_id', '=', ctx.storeId).executeTakeFirst()
        : await query.executeTakeFirst();

    return row ? this.loadSale(this.db, row) : null;
  }

  public async findByNumber(
    ctx: ExecutionContext,
    saleNumber: string,
  ): Promise<Sale | null> {
    return this.findSaleBy(this.db, ctx, 'sale_number', saleNumber.trim());
  }

  public async findByIdempotencyKey(
    ctx: ExecutionContext,
    idempotencyKey: string,
  ): Promise<Sale | null> {
    return this.findSaleBy(this.db, ctx, 'idempotency_key', idempotencyKey.trim());
  }

  public async listByStore(
    ctx: ExecutionContext,
    storeId: string,
    limit = 100,
    offset = 0,
  ): Promise<Sale[]> {
    if (ctx.storeId !== undefined && ctx.storeId !== storeId) {
      return [];
    }
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    const rows = await this.db
      .selectFrom('sales')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .execute();

    const sales: Sale[] = [];
    for (const row of rows) {
      sales.push(await this.loadSale(this.db, row));
    }
    return sales;
  }

  private async findSaleBy(
    db: Executor,
    ctx: ExecutionContext,
    column: 'sale_number' | 'idempotency_key',
    value: string,
  ): Promise<Sale | null> {
    const query = db
      .selectFrom('sales')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where(column, '=', value);
    const row =
      ctx.storeId !== undefined
        ? await query.where('store_id', '=', ctx.storeId).executeTakeFirst()
        : await query.executeTakeFirst();

    return row ? this.loadSale(db, row) : null;
  }

  private async loadSale(db: Executor, row: SaleRow): Promise<Sale> {
    const itemRows = await db
      .selectFrom('sale_items')
      .selectAll()
      .where('tenant_id', '=', row.tenant_id)
      .where('sale_id', '=', row.id)
      .orderBy('line_number', 'asc')
      .execute();

    const paymentRows = await db
      .selectFrom('sale_payments')
      .selectAll()
      .where('tenant_id', '=', row.tenant_id)
      .where('sale_id', '=', row.id)
      .orderBy('tender_index', 'asc')
      .execute();

    return this.toSale(row, itemRows, paymentRows);
  }

  private toSale(
    row: SaleRow,
    itemRows: readonly SaleItemRow[],
    paymentRows: readonly SalePaymentRow[],
  ): Sale {
    const items = itemRows.map((item) =>
      SaleItem.create({
        id: item.id,
        variantId: item.variant_id,
        productId: item.product_id,
        productName: item.product_name,
        sku: item.sku,
        variantAttributes: item.variant_attributes_json ? JSON.parse(item.variant_attributes_json) as ProductAttributes : {},
        type: item.item_type as SaleItemType,
        quantity: toBigInt(item.quantity),
        unitPrice: Money.fromMinor(toBigInt(item.unit_price), row.currency),
        lineDiscount: Money.fromMinor(toBigInt(item.line_discount), row.currency),
        cartDiscountShare: Money.fromMinor(
          toBigInt(item.cart_discount_share),
          row.currency,
        ),
        unitCostSnapshot: Money.fromMinor(
          toBigInt(item.unit_cost_snapshot),
          row.currency,
        ),
        createdAt: new Date(item.created_at),
      }),
    );

    const payments = paymentRows.map(
      (payment) =>
        new SalePayment(payment.id, {
          method: payment.method as PaymentMethod,
          amount: Money.fromMinor(toBigInt(payment.amount), row.currency),
        }),
    );

    const sale = Sale.create({
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      saleNumber: row.sale_number,
      idempotencyKey: row.idempotency_key,
      cashierUserId: row.cashier_user_id,
      customerName: row.customer_name ?? undefined,
      currency: row.currency,
      items,
      payments,
      createdAt: new Date(row.created_at),
    });

    if (sale.status !== (row.status as SaleStatus)) {
      throw new InvalidSaleError(
        `Persisted sale status '${row.status}' cannot be rebuilt by this build`,
      );
    }

    return sale;
  }
}

function matchesDraft(sale: Sale, draft: SaleDraft): boolean {
  if (
    sale.storeId !== draft.storeId ||
    sale.saleNumber !== draft.saleNumber.trim() ||
    sale.cashierUserId !== draft.cashierUserId ||
    sale.customerName !== (draft.customerName?.trim() || undefined) ||
    sale.currency !== draft.currency.trim().toUpperCase() ||
    !sale.subtotal.equals(draft.subtotal) ||
    !sale.discountTotal.equals(draft.discountTotal) ||
    !sale.total.equals(draft.total) ||
    sale.items.length !== draft.items.length ||
    sale.payments.length !== draft.payments.length
  ) {
    return false;
  }

  for (const [index, item] of draft.items.entries()) {
    const stored = sale.items[index];
    if (
      !stored ||
      stored.variantId !== item.variantId ||
      stored.productId !== item.productId ||
      stored.productName !== item.productName ||
      stored.sku !== item.sku.trim().toUpperCase() ||
      stored.type !== item.type ||
      stored.quantity !== item.quantity ||
      !stored.unitPrice.equals(item.unitPrice) ||
      !stored.lineDiscount.equals(item.lineDiscount) ||
      !stored.cartDiscountShare.equals(item.cartDiscountShare)
    ) {
      return false;
    }
  }

  return draft.payments.every((payment, index) => {
    const stored = sale.payments[index];
    return !!stored && stored.method === payment.method && stored.amount.equals(payment.amount);
  });
}
