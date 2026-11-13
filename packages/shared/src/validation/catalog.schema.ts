import { z } from 'zod';

const AttributeValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export const ProductOptionSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  name: z.string().min(1).max(64).trim(),
  values: z.array(z.string().min(1).max(64).trim()).min(1).max(50),
});

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

const PRODUCT_IMAGE_PATTERN = /^(?:https?:\/\/\S+|\/[^\s<>"]+|data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+)$/i;

export const ProductImagePathSchema = z
  .string()
  .trim()
  .max(250_000, 'Product image data exceeds 250KB limit')
  .refine((val) => val === '' || PRODUCT_IMAGE_PATTERN.test(val), {
    message: 'Product image must be a valid image upload (PNG/JPEG/WebP/GIF) or URL',
  });

export const CreateProductSchema = z.object({
  itemKind: z.enum(['PRODUCT', 'SERVICE']).default('PRODUCT'),
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  sku: z.string().min(1, 'SKU is required').max(64).trim(),
  barcode: z.string().min(1).max(64).trim().optional(),
  categoryId: z.string().uuid().optional(),
  description: z.string().max(2000).trim().optional(),
  brand: z.string().max(100).trim().optional(),
  imagePath: ProductImagePathSchema.optional(),
  options: z.array(ProductOptionSchema).max(8).default([]),
  hasVariants: z.boolean().optional(),
  variants: z.array(CreateVariantSchema).min(1, 'At least one sellable variant is required').max(200, 'A product can have at most 200 sellable variants'),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  sku: z.string().min(1, 'SKU is required').max(64).trim(),
  categoryId: z.string().uuid().nullable(),
  description: z.string().max(2000).trim().nullable().optional(),
  brand: z.string().max(100).trim().nullable().optional(),
  imagePath: ProductImagePathSchema.nullable().optional(),
  options: z.array(ProductOptionSchema).max(8),
  variants: z.array(z.object({
    id: z.string().uuid().optional(),
    sku: z.string().min(1, 'SKU is required').max(64).trim(),
    barcode: z.string().max(64).trim().nullable().optional(),
    attributes: ProductAttributesSchema.optional(),
    retailPrice: z.string().regex(/^\d+$/, 'Retail price must be an integer minor-units string'),
    reorderPoint: z.string().regex(/^\d+$/, 'Reorder point must be an integer string'),
  })).min(1).max(200),
});

export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
