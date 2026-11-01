import { z } from 'zod';

const MinorUnitsSchema = z.string().regex(/^\d+$/, 'Amount must be an integer minor-units string');
const QuantitySchema = z.string().regex(/^\d+$/, 'Quantity must be a non-negative integer string');

export const ReceiveStockSchema = z.object({
  storeId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: QuantitySchema,
  unitCost: MinorUnitsSchema,
  currency: z.string().length(3),
  sourceType: z.string().min(1).max(32).optional(),
  sourceId: z.string().min(1).max(128).optional(),
});

export type ReceiveStockInput = z.infer<typeof ReceiveStockSchema>;

export const RecordSaleSchema = z.object({
  storeId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: QuantitySchema,
  sourceId: z.string().min(1).max(128),
});

export type RecordSaleInput = z.infer<typeof RecordSaleSchema>;

export const AdjustStockSchema = z.object({
  storeId: z.string().uuid(),
  variantId: z.string().uuid(),
  targetQuantity: QuantitySchema,
  unitCost: MinorUnitsSchema.optional(),
  currency: z.string().length(3),
  reason: z.string().min(1).max(500).optional(),
});

export type AdjustStockInput = z.infer<typeof AdjustStockSchema>;

export const TransferStockSchema = z
  .object({
    fromStoreId: z.string().uuid(),
    toStoreId: z.string().uuid(),
    variantId: z.string().uuid(),
    quantity: QuantitySchema,
    currency: z.string().length(3),
  })
  .refine((data) => data.fromStoreId !== data.toStoreId, {
    message: 'Source and destination stores must differ',
    path: ['toStoreId'],
  });

export type TransferStockInput = z.infer<typeof TransferStockSchema>;
