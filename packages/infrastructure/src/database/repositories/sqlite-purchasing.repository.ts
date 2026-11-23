import type { Kysely } from 'kysely';
import type { ExecutionContext } from '@retailos/application';
import { serializeAttributes } from '@retailos/core';
import type { Money, ProductOption } from '@retailos/core';
import { applyStockMovementInTransaction } from './stock-movement.executor.js';
import { postJournalEntry } from './accounting-journal.executor.js';
import { allocateDocumentNumberInTransaction } from './document-sequence.executor.js';
import type { RetailOSDatabase } from '../types.js';

export interface PurchaseLineInput {
  variantId: string;
  quantity: bigint;
  unitCost: Money;
  retailPrice?: Money | undefined;
}

export interface InlinePurchaseVariantInput {
  id: string;
  sku: string;
  barcode?: string | undefined;
  attributes: Record<string, string | number | boolean>;
  quantity: bigint;
  unitCost: Money;
  retailPrice?: Money | undefined;
  reorderPoint?: bigint | undefined;
}

export interface InlinePurchaseProductInput {
  id: string;
  name: string;
  sku: string;
  barcode?: string | undefined;
  categoryId?: string | undefined;
  brand?: string | undefined;
  description?: string | undefined;
  imagePath?: string | undefined;
  options: readonly ProductOption[];
  variants: readonly InlinePurchaseVariantInput[];
}

export interface RecordPurchaseInput {
  id: string;
  idempotencyKey: string;
  supplierId: string;
  storeId: string;
  invoiceNumber?: string | undefined;
  autoGenerateInvoiceNumber?: boolean | undefined;
  totalAmount: Money;
  initialPayment: Money;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'MOBILE';
  targetProfitPercent?: number | null | undefined;
  expectedRetailTotal?: Money | undefined;
  referenceNumber?: string | undefined;
  notes?: string | undefined;
  purchasedAt: Date;
  lines: readonly PurchaseLineInput[];
  newProducts?: readonly InlinePurchaseProductInput[] | undefined;
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

export interface UpdateSupplierPaymentInput {
  idempotencyKey: string;
  purchaseId: string;
  paymentId: string;
  amount: Money;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'MOBILE';
  referenceNumber?: string | undefined;
  updatedAt: Date;
}

export interface DeleteSupplierPaymentInput {
  idempotencyKey: string;
  purchaseId: string;
  paymentId: string;
  deletedAt: Date;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

export class SqlitePurchasingRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async recordPurchase(ctx: ExecutionContext, input: RecordPurchaseInput): Promise<string> {
    if (ctx.storeId && ctx.storeId !== input.storeId) throw Object.assign(new Error('لا تملك صلاحية تسجيل فاتورة على هذا الفرع'), { status: 403 });
    if (input.totalAmount.currency.code !== input.initialPayment.currency.code) throw badRequest('عملة الدفع لا تطابق عملة الفاتورة');
    if (input.initialPayment.amount > input.totalAmount.amount) throw badRequest('المبلغ المدفوع أكبر من إجمالي الفاتورة');
    const newProducts = input.newProducts ?? [];
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

    const seenNewProductSkus = new Set<string>();
    const seenNewVariantSkus = new Set<string>();
    const seenNewBarcodes = new Set<string>();
    interface PreparedNewVariantLine {
      productId: string;
      productName: string;
      productSku: string;
      categoryId: string | null;
      variantId: string;
      sku: string;
      quantity: bigint;
      unitCost: Money;
      retailPrice: Money | undefined;
    }
    const preparedNewLines: PreparedNewVariantLine[] = [];

    for (const np of newProducts) {
      const normalizedName = np.name.trim();
      const normalizedProductSku = np.sku.trim().toUpperCase();
      if (normalizedName.length < 2) throw badRequest('اسم المنتج الجديد يجب أن يكون حرفين على الأقل');
      if (!normalizedProductSku) throw badRequest('كود المنتج الجديد مطلوب');
      if (seenNewProductSkus.has(normalizedProductSku)) {
        throw badRequest(`كود المنتج ${normalizedProductSku} مكرر داخل نفس الفاتورة`);
      }
      seenNewProductSkus.add(normalizedProductSku);
      if (np.variants.length === 0) throw badRequest(`المنتج ${normalizedName} يجب أن يحتوي على تركيبة واحدة على الأقل`);

      const optionKeys = np.options.map((opt) => opt.key);
      if (new Set(optionKeys).size !== optionKeys.length) {
        throw badRequest(`خيارات المنتج ${normalizedName} تحتوي على أسماء مكررة`);
      }
      if (optionKeys.length === 0 && np.variants.length > 1) {
        throw badRequest(`المنتج بدون خيارات (${normalizedName}) يجب أن يحتوي على تركيبة واحدة فقط`);
      }
      const seenCombinations = new Set<string>();
      let productPurchasedVariantCount = 0;

      for (const variant of np.variants) {
        const normalizedVariantSku = variant.sku.trim().toUpperCase();
        if (!normalizedVariantSku) throw badRequest(`كود التركيبة مطلوب للمنتج ${normalizedName}`);
        if (seenNewVariantSkus.has(normalizedVariantSku)) {
          throw badRequest(`كود التركيبة ${normalizedVariantSku} مكرر داخل نفس الفاتورة`);
        }
        seenNewVariantSkus.add(normalizedVariantSku);

        const normalizedBarcode = variant.barcode?.trim() || null;
        if (normalizedBarcode) {
          if (seenNewBarcodes.has(normalizedBarcode)) {
            throw badRequest(`الباركود ${normalizedBarcode} مكرر داخل نفس الفاتورة`);
          }
          seenNewBarcodes.add(normalizedBarcode);
        }

        if (optionKeys.length === 0 && Object.keys(variant.attributes).length > 0) {
          throw badRequest(`تركيبة النسخة ${normalizedVariantSku} لا تطابق خيارات المنتج ${normalizedName}`);
        }
        if (optionKeys.length > 0) {
          const attrs = variant.attributes;
          if (
            Object.keys(attrs).length !== optionKeys.length ||
            optionKeys.some((key) => {
              const opt = np.options.find((entry) => entry.key === key);
              return !opt || !opt.values.includes(String(attrs[key]));
            })
          ) {
            throw badRequest(`تركيبة النسخة ${normalizedVariantSku} لا تطابق خيارات المنتج ${normalizedName}`);
          }
          const comboKey = JSON.stringify(Object.fromEntries(optionKeys.map((key) => [key, attrs[key]])));
          if (seenCombinations.has(comboKey)) {
            throw badRequest(`تركيبات المنتج ${normalizedName} مكررة`);
          }
          seenCombinations.add(comboKey);
        }

        if (variant.quantity < 0n || variant.unitCost.isNegative()) {
          throw badRequest('كمية أو تكلفة تركيبة المنتج الجديد غير صالحة');
        }
        if (variant.unitCost.currency.code !== input.totalAmount.currency.code) {
          throw badRequest('Purchase item currency mismatch');
        }
        if (variant.retailPrice !== undefined) {
          if (variant.retailPrice.isNegative() || variant.retailPrice.currency.code !== input.totalAmount.currency.code) {
            throw badRequest('سعر البيع المحدد للبند غير صالح');
          }
        }
        if (variant.reorderPoint !== undefined && variant.reorderPoint < 0n) {
          throw badRequest('حد إعادة الطلب غير صالح');
        }

        if (variant.quantity > 0n) {
          productPurchasedVariantCount += 1;
          preparedNewLines.push({
            productId: np.id,
            productName: normalizedName,
            productSku: normalizedProductSku,
            categoryId: np.categoryId ?? null,
            variantId: variant.id,
            sku: normalizedVariantSku,
            quantity: variant.quantity,
            unitCost: variant.unitCost,
            retailPrice: variant.retailPrice,
          });
        }
      }

      if (productPurchasedVariantCount === 0) {
        throw badRequest(`حدد كمية أكبر من صفر لتركيبة واحدة على الأقل للمنتج الجديد (${normalizedName})`);
      }
    }

    if (input.lines.length + preparedNewLines.length === 0) {
      throw badRequest('يجب إضافة صنف واحد على الأقل بكمية أكبر من صفر في الفاتورة');
    }

    const existingLinesTotal = input.lines.reduce((sum, line) => sum + line.unitCost.amount * line.quantity, 0n);
    const newLinesTotal = preparedNewLines.reduce((sum, line) => sum + line.unitCost.amount * line.quantity, 0n);
    const calculatedLinesTotal = existingLinesTotal + newLinesTotal;
    if (calculatedLinesTotal !== input.totalAmount.amount) throw badRequest('قيمة الفاتورة لازم تساوي مجموع أصنافها');

    return this.db.transaction().execute(async (trx) => {
      const replay = await trx.selectFrom('supplier_purchases').selectAll()
        .where('tenant_id', '=', ctx.tenantId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (replay) {
        const existingLinesRaw = await trx.selectFrom('supplier_purchase_items').selectAll()
          .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', replay.id).execute();
        const existingLines = [...existingLinesRaw].sort((a, b) => comparePurchaseItemIds(a.id, b.id));
        const existingInitialPayment = await trx.selectFrom('supplier_payments').selectAll()
          .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', replay.id)
          .where('idempotency_key', '=', `${input.idempotencyKey}:initial`).executeTakeFirst();
        const replayExpectedRetail = replay.expected_retail_total === null ? null : BigInt(replay.expected_retail_total);
        const sameInvoice = input.invoiceNumber?.trim()
          ? replay.invoice_number === input.invoiceNumber.trim()
          : input.autoGenerateInvoiceNumber
            ? Boolean(replay.invoice_number)
            : replay.invoice_number === null;
        const expectedTotalLineCount = input.lines.length + preparedNewLines.length;
        let linesMatch = existingLines.length === expectedTotalLineCount;
        if (linesMatch) {
          for (let i = 0; i < input.lines.length; i += 1) {
            const persisted = existingLines[i];
            const expected = input.lines[i];
            if (
              !persisted || !expected ||
              persisted.variant_id !== expected.variantId ||
              BigInt(persisted.quantity) !== expected.quantity ||
              BigInt(persisted.unit_cost) !== expected.unitCost.amount ||
              (persisted.retail_price === null ? null : BigInt(persisted.retail_price)) !== (expected.retailPrice?.amount ?? null)
            ) {
              linesMatch = false;
              break;
            }
          }
        }
        if (linesMatch && preparedNewLines.length > 0) {
          for (let j = 0; j < preparedNewLines.length; j += 1) {
            const persisted = existingLines[input.lines.length + j];
            const expected = preparedNewLines[j];
            if (
              !persisted || !expected ||
              persisted.sku.toUpperCase() !== expected.sku ||
              persisted.product_name !== expected.productName ||
              BigInt(persisted.quantity) !== expected.quantity ||
              BigInt(persisted.unit_cost) !== expected.unitCost.amount ||
              (persisted.retail_price === null ? null : BigInt(persisted.retail_price)) !== (expected.retailPrice?.amount ?? null)
            ) {
              linesMatch = false;
              break;
            }
          }
        }
        if (linesMatch && newProducts.length > 0) {
          for (const np of newProducts) {
            const persistedProduct = await trx
              .selectFrom('products')
              .select(['name', 'category_id', 'options_json'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('sku', '=', np.sku.trim().toUpperCase())
              .executeTakeFirst();
            if (
              !persistedProduct ||
              persistedProduct.name !== np.name.trim() ||
              (persistedProduct.category_id ?? null) !== (np.categoryId ?? null) ||
              persistedProduct.options_json !== JSON.stringify(np.options)
            ) {
              linesMatch = false;
              break;
            }
          }
        }
        const sameRequest = replay.supplier_id === input.supplierId && replay.store_id === input.storeId
          && sameInvoice
          && BigInt(replay.total_amount) === input.totalAmount.amount
          && replay.currency === input.totalAmount.currency.code
          && replayExpectedRetail === (input.expectedRetailTotal?.amount ?? null)
          && linesMatch
          && BigInt(existingInitialPayment?.amount ?? 0) === input.initialPayment.amount
          && (!existingInitialPayment || existingInitialPayment.payment_method === input.paymentMethod);
        if (!sameRequest) throw conflict('مفتاح العملية مستخدم لفاتورة مشتريات مختلفة');
        return replay.id;
      }
      const supplier = await trx.selectFrom('suppliers').select(['id', 'is_active']).where('id', '=', input.supplierId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      const store = await trx.selectFrom('stores').select('id').where('id', '=', input.storeId).where('tenant_id', '=', ctx.tenantId).executeTakeFirst();
      if (!supplier || supplier.is_active !== 1 || !store) throw badRequest('التاجر أو الفرع غير متاح لتسجيل فواتير شراء جديدة');

      const resolvedInvoiceNumber = input.invoiceNumber?.trim()
        ? input.invoiceNumber.trim()
        : input.autoGenerateInvoiceNumber
          ? await allocateDocumentNumberInTransaction(trx, {
              tenantId: ctx.tenantId,
              docType: 'PURCHASE',
              prefix: 'PUR-',
              existingTable: 'supplier_purchases',
              existingCol: 'invoice_number',
            })
          : null;

      await trx.insertInto('supplier_purchases').values({
        id: input.id,
        tenant_id: ctx.tenantId,
        store_id: input.storeId,
        supplier_id: input.supplierId,
        idempotency_key: input.idempotencyKey,
        invoice_number: resolvedInvoiceNumber,
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

      // Create inline new products & their variants atomically inside this same transaction.
      for (const np of newProducts) {
        const normalizedName = np.name.trim();
        const normalizedProductSku = np.sku.trim().toUpperCase();
        const normalizedProductBarcode = np.barcode?.trim() || null;

        if (np.categoryId) {
          const category = await trx
            .selectFrom('categories')
            .select('id')
            .where('id', '=', np.categoryId)
            .where('tenant_id', '=', ctx.tenantId)
            .executeTakeFirst();
          if (!category) throw badRequest('الفئة المحددة غير موجودة');
        }

        const duplicateProduct = await trx
          .selectFrom('products')
          .select('id')
          .where('tenant_id', '=', ctx.tenantId)
          .where('sku', '=', normalizedProductSku)
          .executeTakeFirst();
        if (duplicateProduct) throw conflict(`كود المنتج ${normalizedProductSku} مستخدم بالفعل`);

        if (normalizedProductBarcode) {
          const duplicateProductBarcode = await trx
            .selectFrom('products')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('barcode', '=', normalizedProductBarcode)
            .executeTakeFirst();
          if (duplicateProductBarcode) throw conflict(`باركود المنتج ${normalizedProductBarcode} مستخدم بالفعل`);
        }

        await trx.insertInto('products').values({
          id: np.id,
          tenant_id: ctx.tenantId,
          name: normalizedName,
          sku: normalizedProductSku,
          barcode: normalizedProductBarcode,
          category_id: np.categoryId ?? null,
          has_variants: np.options.length > 0 ? 1 : 0,
          item_kind: 'PRODUCT',
          description: np.description?.trim() || null,
          brand: np.brand?.trim() || null,
          image_path: np.imagePath?.trim() || null,
          options_json: JSON.stringify(np.options),
          is_active: 1,
        }).execute();

        for (const variant of np.variants) {
          const normalizedVariantSku = variant.sku.trim().toUpperCase();
          const normalizedVariantBarcode = variant.barcode?.trim() || null;

          const duplicateVariantSku = await trx
            .selectFrom('product_variants')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('sku', '=', normalizedVariantSku)
            .executeTakeFirst();
          if (duplicateVariantSku) throw conflict(`كود النسخة ${normalizedVariantSku} مستخدم بالفعل`);

          if (normalizedVariantBarcode) {
            const duplicateVariantBarcode = await trx
              .selectFrom('product_variants')
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('barcode', '=', normalizedVariantBarcode)
              .executeTakeFirst();
            if (duplicateVariantBarcode) throw conflict(`الباركود ${normalizedVariantBarcode} مستخدم بالفعل`);
          }

          await trx.insertInto('product_variants').values({
            id: variant.id,
            tenant_id: ctx.tenantId,
            product_id: np.id,
            sku: normalizedVariantSku,
            barcode: normalizedVariantBarcode,
            attributes_json: serializeAttributes(variant.attributes),
            retail_price: variant.retailPrice ? variant.retailPrice.amount : 0n,
            currency: input.totalAmount.currency.code,
            reorder_point: variant.reorderPoint ?? 0n,
            is_active: 1,
          }).execute();
        }
      }

      let lineIndex = 0;

      for (const line of input.lines) {
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
          id: `${input.id}:item:${lineIndex}`,
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
          id: `${input.id}:movement:${lineIndex}`,
          storeId: input.storeId,
          variantId: variant.variantId,
          currency: input.totalAmount.currency.code,
          movementType: 'PURCHASE_RECEIPT',
          quantityDelta: line.quantity,
          unitCost: line.unitCost,
          sourceType: 'PURCHASE',
          sourceId: input.id,
        });
        lineIndex += 1;
      }

      for (const newLine of preparedNewLines) {
        await trx.insertInto('supplier_purchase_items').values({
          id: `${input.id}:item:${lineIndex}`,
          tenant_id: ctx.tenantId,
          store_id: input.storeId,
          purchase_id: input.id,
          variant_id: newLine.variantId,
          product_id: newLine.productId,
          product_name: newLine.productName,
          sku: newLine.sku,
          quantity: newLine.quantity,
          unit_cost: newLine.unitCost.amount,
          retail_price: newLine.retailPrice?.amount ?? null,
          currency: input.totalAmount.currency.code,
        }).execute();

        await applyStockMovementInTransaction(trx, ctx, {
          id: `${input.id}:movement:${lineIndex}`,
          storeId: input.storeId,
          variantId: newLine.variantId,
          currency: input.totalAmount.currency.code,
          movementType: 'PURCHASE_RECEIPT',
          quantityDelta: newLine.quantity,
          unitCost: newLine.unitCost,
          sourceType: 'PURCHASE',
          sourceId: input.id,
        });
        lineIndex += 1;
      }

      await postJournalEntry(trx, ctx, {
        storeId: input.storeId,
        currency: input.totalAmount.currency.code,
        date: input.purchasedAt,
        sourceType: 'PURCHASE',
        sourceId: input.id,
        idempotencyKey: `purchase:${input.idempotencyKey}`,
        description: `فاتورة مشتريات ${resolvedInvoiceNumber ?? input.id}`,
        lines: [
          { accountCode: '1300', side: 'DEBIT', amount: calculatedLinesTotal, memo: 'إضافة أصناف للمخزون' },
          ...(input.initialPayment.amount > 0n ? [{ accountCode: cashAccount(input.paymentMethod), side: 'CREDIT' as const, amount: input.initialPayment.amount, memo: 'المدفوع عند استلام الفاتورة' }] : []),
          ...(input.totalAmount.amount > input.initialPayment.amount ? [{ accountCode: '2010', side: 'CREDIT' as const, amount: input.totalAmount.amount - input.initialPayment.amount, memo: 'رصيد مستحق للتاجر' }] : []),
        ],
      });
      return input.id;
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
      const payments = await trx.selectFrom('supplier_payments').select(['id', 'idempotency_key', 'amount', 'deleted_at'])
        .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', purchase.id).execute();
      // Supplier returns reduce the payable for this invoice, so the remaining
      // balance is total - paid - returned. Paying past that would over-settle
      // the invoice and distort the supplier ledger.
      // Legacy purchases may hold an upfront payment in `initial_paid_amount` without
      // a `:initial` row in `supplier_payments`; if an `:initial` payment row already
      // exists, count it only once via `supplier_payments`.
      const supplierReturns = await trx.selectFrom('supplier_returns').select('credit_amount')
        .where('tenant_id', '=', ctx.tenantId).where('purchase_id', '=', purchase.id).execute();
      const hasInitialPaymentRow = payments.some(
        (payment) =>
          payment.id === `${purchase.id}:payment:initial` ||
          payment.idempotency_key === `${purchase.idempotency_key}:initial`,
      );
      const legacyInitialPaid = hasInitialPaymentRow ? 0n : BigInt(purchase.initial_paid_amount);
      const paid = legacyInitialPaid + payments.filter((p) => !p.deleted_at).reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
      const returned = supplierReturns.reduce((sum, row) => sum + BigInt(row.credit_amount), 0n);
      const outstanding = BigInt(purchase.total_amount) - paid - returned;
      if (input.amount.amount > outstanding) {
        throw badRequest(returned > 0n ? 'المبلغ أكبر من المديونية المتبقية بعد خصم مرتجعات المورد' : 'المبلغ أكبر من المديونية المتبقية');
      }

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

  public async updateSupplierPayment(
    ctx: ExecutionContext,
    input: UpdateSupplierPaymentInput,
  ): Promise<{
    id: string;
    purchaseId: string;
    storeId: string;
    oldAmount: bigint;
    newAmount: bigint;
    oldMethod: string;
    newMethod: RecordPurchaseInput['paymentMethod'];
  }> {
    if (input.amount.amount <= 0n) throw badRequest('مبلغ السداد لازم يكون أكبر من صفر');
    return this.db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom('supplier_payments')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', input.purchaseId)
        .where('id', '=', input.paymentId)
        .executeTakeFirst();
      if (!payment) throw Object.assign(new Error('دفعة السداد غير موجودة'), { status: 404 });

      const purchase = await trx
        .selectFrom('supplier_purchases')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', input.purchaseId)
        .executeTakeFirst();
      if (!purchase || (ctx.storeId && ctx.storeId !== purchase.store_id)) {
        throw Object.assign(new Error('فاتورة التاجر غير متاحة'), { status: 404 });
      }
      if (input.amount.currency.code !== purchase.currency) {
        throw badRequest('عملة السداد لا تطابق عملة الفاتورة');
      }

      const oldAmount = BigInt(payment.amount);
      if (payment.deleted_at) {
        throw conflict('لا يمكن تعديل دفعة تم إلغاؤها بالفعل');
      }
      const oldMethod = payment.payment_method;
      const newAmount = input.amount.amount;
      const newMethod = input.paymentMethod;
      const newRef = input.referenceNumber?.trim() || null;

      // Idempotent replay check: if this edit key was already posted, return cleanly without double-posting
      const editKey = `supplier-payment-edit:${input.idempotencyKey}`;
      const existingEditJournal = await trx
        .selectFrom('journal_entries')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('idempotency_key', '=', editKey)
        .executeTakeFirst();
      if (existingEditJournal) {
        if (oldAmount !== newAmount || oldMethod !== newMethod || (payment.reference_number ?? null) !== newRef) {
          throw conflict('مفتاح التعديل مستخدم لعملية تعديل مختلفة');
        }
        return {
          id: payment.id,
          purchaseId: purchase.id,
          storeId: purchase.store_id,
          oldAmount,
          newAmount,
          oldMethod,
          newMethod,
        };
      }

      const allPayments = await trx
        .selectFrom('supplier_payments')
        .select(['id', 'idempotency_key', 'amount', 'deleted_at'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', purchase.id)
        .execute();
      const supplierReturns = await trx
        .selectFrom('supplier_returns')
        .select('credit_amount')
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', purchase.id)
        .execute();

      const hasInitialPaymentRow = allPayments.some(
        (row) =>
          row.id === `${purchase.id}:payment:initial` ||
          row.idempotency_key === `${purchase.idempotency_key}:initial`,
      );
      const legacyInitialPaid = hasInitialPaymentRow ? 0n : BigInt(purchase.initial_paid_amount);
      const otherPaid =
        legacyInitialPaid +
        allPayments
          .filter((row) => row.id !== payment.id && !row.deleted_at)
          .reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const returned = supplierReturns.reduce((sum, row) => sum + BigInt(row.credit_amount), 0n);
      const maxAllowed = BigInt(purchase.total_amount) - otherPaid - returned;
      if (newAmount > maxAllowed) {
        throw badRequest('المبلغ المعدّل أكبر من المديونية المتاحة على هذه الفاتورة');
      }

      if (oldAmount !== newAmount || oldMethod !== newMethod) {
        const invLabel = purchase.invoice_number ?? purchase.id;
        await postJournalEntry(trx, ctx, {
          storeId: purchase.store_id,
          currency: purchase.currency,
          date: input.updatedAt,
          sourceType: 'PURCHASE_PAYMENT',
          sourceId: payment.id,
          idempotencyKey: `supplier-payment-edit-rev:${input.idempotencyKey}`,
          description: `عكس سداد سابق لتعديل فاتورة ${invLabel}`,
          lines: [
            { accountCode: cashAccount(oldMethod), side: 'DEBIT', amount: oldAmount, memo: 'رد سداد سابق للتعديل' },
            { accountCode: '2010', side: 'CREDIT', amount: oldAmount, memo: 'إعادة رصيد التاجر قبل التعديل' },
          ],
        });

        await postJournalEntry(trx, ctx, {
          storeId: purchase.store_id,
          currency: purchase.currency,
          date: input.updatedAt,
          sourceType: 'PURCHASE_PAYMENT',
          sourceId: payment.id,
          idempotencyKey: editKey,
          description: `تعديل سداد فاتورة التاجر ${invLabel}`,
          lines: [
            { accountCode: '2010', side: 'DEBIT', amount: newAmount, memo: 'تخفيض مديونية التاجر بعد التعديل' },
            { accountCode: cashAccount(newMethod), side: 'CREDIT', amount: newAmount, memo: 'صرف الدفعة المعدّلة للتاجر' },
          ],
        });
      }

      await trx
        .updateTable('supplier_payments')
        .set({
          amount: newAmount,
          payment_method: newMethod,
          reference_number: newRef,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', purchase.id)
        .where('id', '=', payment.id)
        .execute();

      return {
        id: payment.id,
        purchaseId: purchase.id,
        storeId: purchase.store_id,
        oldAmount,
        newAmount,
        oldMethod,
        newMethod,
      };
    });
  }

  public async deleteSupplierPayment(
    ctx: ExecutionContext,
    input: DeleteSupplierPaymentInput,
  ): Promise<{
    id: string;
    purchaseId: string;
    storeId: string;
    deletedAmount: bigint;
    paymentMethod: string;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom('supplier_payments')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', input.purchaseId)
        .where('id', '=', input.paymentId)
        .executeTakeFirst();
      if (!payment) throw Object.assign(new Error('دفعة السداد غير موجودة'), { status: 404 });

      const purchase = await trx
        .selectFrom('supplier_purchases')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', input.purchaseId)
        .executeTakeFirst();
      if (!purchase || (ctx.storeId && ctx.storeId !== purchase.store_id)) {
        throw Object.assign(new Error('فاتورة التاجر غير متاحة'), { status: 404 });
      }

      const oldAmount = BigInt(payment.amount);
      if (payment.deleted_at) {
        throw conflict('تم إلغاء هذه الدفعة بالفعل');
      }
      const oldMethod = payment.payment_method;
      const invLabel = purchase.invoice_number ?? purchase.id;

      await postJournalEntry(trx, ctx, {
        storeId: purchase.store_id,
        currency: purchase.currency,
        date: input.deletedAt,
        sourceType: 'PURCHASE_PAYMENT',
        sourceId: payment.id,
        idempotencyKey: `supplier-payment-del:${input.idempotencyKey}`,
        description: `إلغاء وعكس دفعة سداد لفاتورة ${invLabel}`,
        lines: [
          { accountCode: cashAccount(oldMethod), side: 'DEBIT', amount: oldAmount, memo: 'رد دفعة سداد ملغاة' },
          { accountCode: '2010', side: 'CREDIT', amount: oldAmount, memo: 'إعادة المديونية للتاجر بعد إلغاء الدفعة' },
        ],
      });

      await trx
        .updateTable('supplier_payments')
        .set({ deleted_at: input.deletedAt.toISOString() })
        .where('tenant_id', '=', ctx.tenantId)
        .where('purchase_id', '=', purchase.id)
        .where('id', '=', payment.id)
        .where('deleted_at', 'is', null)
        .execute();

      if (
        payment.id === `${purchase.id}:payment:initial` ||
        payment.idempotency_key === `${purchase.idempotency_key}:initial`
      ) {
        await trx
          .updateTable('supplier_purchases')
          .set({ initial_paid_amount: 0n })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', purchase.id)
          .execute();
      }

      return {
        id: payment.id,
        purchaseId: purchase.id,
        storeId: purchase.store_id,
        deletedAmount: oldAmount,
        paymentMethod: oldMethod,
      };
    });
  }
}

function cashAccount(method: string): string {
  return method === 'CASH' ? '1010' : '1020';
}

function comparePurchaseItemIds(a: string, b: string): number {
  const matchA = /:item:(\d+)$/.exec(a);
  const matchB = /:item:(\d+)$/.exec(b);
  if (matchA?.[1] && matchB?.[1]) {
    const idxA = BigInt(matchA[1]);
    const idxB = BigInt(matchB[1]);
    if (idxA < idxB) return -1;
    if (idxA > idxB) return 1;
    return 0;
  }
  return a.localeCompare(b);
}
