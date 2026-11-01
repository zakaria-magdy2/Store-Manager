import type { Category, Product, ProductVariant } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';

export interface ProductListFilter {
  categoryId?: string | undefined;
  search?: string | undefined;
  includeInactive?: boolean | undefined;
}

export interface CategoryRepository {
  findById(ctx: ExecutionContext, id: string): Promise<Category | null>;
  findByCode(ctx: ExecutionContext, code: string): Promise<Category | null>;
  listByTenant(ctx: ExecutionContext): Promise<Category[]>;
  save(ctx: ExecutionContext, category: Category): Promise<void>;
}

export interface ProductRepository {
  findById(ctx: ExecutionContext, id: string): Promise<Product | null>;
  findBySku(ctx: ExecutionContext, sku: string): Promise<Product | null>;
  listByTenant(ctx: ExecutionContext, filter?: ProductListFilter): Promise<Product[]>;
  save(ctx: ExecutionContext, product: Product): Promise<void>;
  /** Atomically persists a product together with its sellable variants. */
  saveWithVariants(
    ctx: ExecutionContext,
    product: Product,
    variants: readonly ProductVariant[],
  ): Promise<void>;
}

export interface ProductVariantRepository {
  findById(ctx: ExecutionContext, id: string): Promise<ProductVariant | null>;
  findBySku(ctx: ExecutionContext, sku: string): Promise<ProductVariant | null>;
  findByBarcode(ctx: ExecutionContext, barcode: string): Promise<ProductVariant | null>;
  listByProduct(ctx: ExecutionContext, productId: string): Promise<ProductVariant[]>;
  save(ctx: ExecutionContext, variant: ProductVariant): Promise<void>;
}
