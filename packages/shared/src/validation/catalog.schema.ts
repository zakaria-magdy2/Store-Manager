import { z } from 'zod';

const AttributeValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const ProductAttributesSchema = z.record(
  z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/,
      "Attribute keys must start with a letter and contain only letters, numbers, '_' or '-'",
    ),
  AttributeValueSchema,
);

export const CreateCategorySchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  code: z
    .string()
    .min(2, 'Code must be at least 2 characters')
    .max(32, 'Code maximum 32 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Code can only contain letters, numbers, hyphens, and underscores')
    .trim(),
  parentId: z.string().uuid().optional(),
});

export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;

export const CreateVariantSchema = z.object({
  sku: z.string().min(1, 'SKU is required').max(64).trim(),
  barcode: z.string().min(1).max(64).trim().optional(),
  attributes: ProductAttributesSchema.optional(),
  retailPrice: z.string().regex(/^\d+$/, 'Retail price must be an integer minor-units string'),
  reorderPoint: z.string().regex(/^\d+$/, 'Reorder point must be an integer string').optional(),
});

export type CreateVariantInput = z.infer<typeof CreateVariantSchema>;

export const CreateProductSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  sku: z.string().min(1, 'SKU is required').max(64).trim(),
  barcode: z.string().min(1).max(64).trim().optional(),
  categoryId: z.string().uuid().optional(),
  hasVariants: z.boolean().optional(),
  variants: z.array(CreateVariantSchema).min(1, 'At least one sellable variant is required'),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
