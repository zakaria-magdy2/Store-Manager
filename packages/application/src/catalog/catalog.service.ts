import {
  Category,
  Permissions,
  Product,
  ProductVariant,
} from '@retailos/core';
import type { AttributeValue, Money } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';
import type {
  CategoryRepository,
  ProductRepository,
  ProductVariantRepository,
} from '../ports/catalog-repositories.interface.js';

export interface CreateVariantParams {
  id: string;
  sku: string;
  barcode?: string | undefined;
  attributes?: Record<string, AttributeValue> | undefined;
  retailPrice: Money;
  reorderPoint?: bigint | undefined;
}

export interface CreateProductParams {
  id: string;
  name: string;
  sku: string;
  barcode?: string | undefined;
  categoryId?: string | undefined;
  hasVariants?: boolean | undefined;
  variants: CreateVariantParams[];
}

export class CatalogService {
  constructor(
    private readonly categoryRepo: CategoryRepository,
    private readonly productRepo: ProductRepository,
    private readonly variantRepo: ProductVariantRepository,
  ) {}

  public async createCategory(
    ctx: ExecutionContext,
    params: {
      id: string;
      name: string;
      code: string;
      parentId?: string | undefined;
    },
  ): Promise<Category> {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);

    const duplicate = await this.categoryRepo.findByCode(ctx, params.code);
    if (duplicate) {
      throw new Error(`CatalogError: Category code '${params.code}' already exists`);
    }

    if (params.parentId !== undefined) {
      const parent = await this.categoryRepo.findById(ctx, params.parentId);
      if (!parent) {
        throw new Error(`CatalogError: Parent category '${params.parentId}' not found`);
      }
    }

    const category = Category.create({
      id: params.id,
      tenantId: ctx.tenantId,
      name: params.name,
      code: params.code,
      parentId: params.parentId,
    });

    await this.categoryRepo.save(ctx, category);
    return category;
  }

  /**
   * Creates a product and its sellable variants atomically.
   *
   * Every product must expose at least one variant: inventory, pricing and
   * barcode lookup always operate on a variant, so simple products receive a
   * single default variant instead of a special code path.
   */
  public async createProduct(
    ctx: ExecutionContext,
    params: CreateProductParams,
  ): Promise<{ product: Product; variants: ProductVariant[] }> {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);

    if (params.variants.length === 0) {
      throw new Error('CatalogError: A product requires at least one sellable variant');
    }

    const hasVariants = params.hasVariants ?? params.variants.length > 1;
    if (!hasVariants && params.variants.length !== 1) {
      throw new Error('CatalogError: A product without variants must have exactly one variant');
    }

    const duplicateSku = await this.productRepo.findBySku(ctx, params.sku);
    if (duplicateSku) {
      throw new Error(`CatalogError: Product SKU '${params.sku}' already exists`);
    }

    if (params.categoryId !== undefined) {
      const category = await this.categoryRepo.findById(ctx, params.categoryId);
      if (!category) {
        throw new Error(`CatalogError: Category '${params.categoryId}' not found`);
      }
    }

    await this.assertVariantSkusAndBarcodesAvailable(ctx, params.variants);

    const product = Product.create({
      id: params.id,
      tenantId: ctx.tenantId,
      name: params.name,
      sku: params.sku,
      barcode: params.barcode,
      categoryId: params.categoryId,
      hasVariants,
    });

    const variants = params.variants.map((variant) =>
      ProductVariant.create({
        id: variant.id,
        tenantId: ctx.tenantId,
        productId: product.id,
        sku: variant.sku,
        barcode: variant.barcode,
        attributes: variant.attributes,
        retailPrice: variant.retailPrice,
        reorderPoint: variant.reorderPoint,
      }),
    );

    await this.productRepo.saveWithVariants(ctx, product, variants);
    return { product, variants };
  }

  public async addVariant(
    ctx: ExecutionContext,
    params: CreateVariantParams & { productId: string },
  ): Promise<ProductVariant> {
    ctx.assertPermission(Permissions.CATALOG_MANAGE);

    const product = await this.productRepo.findById(ctx, params.productId);
    if (!product) {
      throw new Error(`CatalogError: Product '${params.productId}' not found`);
    }
    if (!product.hasVariants) {
      throw new Error(
        'CatalogError: This product does not support variants; create a new product line instead',
      );
    }

    await this.assertVariantSkusAndBarcodesAvailable(ctx, [params]);

    const variant = ProductVariant.create({
      id: params.id,
      tenantId: ctx.tenantId,
      productId: product.id,
      sku: params.sku,
      barcode: params.barcode,
      attributes: params.attributes,
      retailPrice: params.retailPrice,
      reorderPoint: params.reorderPoint,
    });

    await this.variantRepo.save(ctx, variant);
    return variant;
  }

  public async getProduct(
    ctx: ExecutionContext,
    productId: string,
  ): Promise<{ product: Product; variants: ProductVariant[] } | null> {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    const product = await this.productRepo.findById(ctx, productId);
    if (!product) {
      return null;
    }
    const variants = await this.variantRepo.listByProduct(ctx, product.id);
    return { product, variants };
  }

  public async listProducts(ctx: ExecutionContext): Promise<Product[]> {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    return this.productRepo.listByTenant(ctx);
  }

  public async findByBarcode(
    ctx: ExecutionContext,
    barcode: string,
  ): Promise<{ product: Product; variant: ProductVariant } | null> {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    if (!barcode.trim()) {
      return null;
    }

    const variant = await this.variantRepo.findByBarcode(ctx, barcode.trim());
    if (!variant) {
      return null;
    }

    const product = await this.productRepo.findById(ctx, variant.productId);
    if (!product) {
      return null;
    }

    return { product, variant };
  }

  private async assertVariantSkusAndBarcodesAvailable(
    ctx: ExecutionContext,
    variants: readonly CreateVariantParams[],
  ): Promise<void> {
    const seenSkus = new Set<string>();
    const seenBarcodes = new Set<string>();

    for (const variant of variants) {
      const normalizedSku = variant.sku.trim().toUpperCase();
      if (!normalizedSku) {
        throw new Error('CatalogError: Variant SKU cannot be empty');
      }
      if (seenSkus.has(normalizedSku)) {
        throw new Error(`CatalogError: Duplicate variant SKU '${variant.sku}' in request`);
      }
      seenSkus.add(normalizedSku);

      const existingSku = await this.variantRepo.findBySku(ctx, normalizedSku);
      if (existingSku) {
        throw new Error(`CatalogError: Variant SKU '${variant.sku}' already exists`);
      }

      const barcode = variant.barcode?.trim();
      if (barcode) {
        if (seenBarcodes.has(barcode)) {
          throw new Error(`CatalogError: Duplicate barcode '${barcode}' in request`);
        }
        seenBarcodes.add(barcode);

        const existingBarcode = await this.variantRepo.findByBarcode(ctx, barcode);
        if (existingBarcode) {
          throw new Error(`CatalogError: Barcode '${barcode}' is already assigned`);
        }
      }
    }
  }
}
