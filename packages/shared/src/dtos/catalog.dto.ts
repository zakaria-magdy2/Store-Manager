import type { MoneyDTO } from './money.dto.js';

export type ProductAttributeDTO = string | number | boolean;

export interface CategoryDTO {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  parentId?: string | undefined;
  isActive: boolean;
  createdAt: string;
}

export interface ProductVariantDTO {
  id: string;
  tenantId: string;
  productId: string;
  sku: string;
  barcode?: string | undefined;
  attributes: Record<string, ProductAttributeDTO>;
  retailPrice: MoneyDTO;
  reorderPoint: string; // BigInt string
  isActive: boolean;
  createdAt: string;
}

export interface ProductDTO {
  id: string;
  tenantId: string;
  name: string;
  sku: string;
  barcode?: string | undefined;
  categoryId?: string | undefined;
  hasVariants: boolean;
  isActive: boolean;
  createdAt: string;
  variants: ProductVariantDTO[];
}

export interface ProductLookupResultDTO {
  product: ProductDTO;
  variant: ProductVariantDTO;
}
