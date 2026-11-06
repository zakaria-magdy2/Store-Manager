import { Entity } from '../common/entity.base.js';
import { InvalidCatalogError } from '../common/errors.js';

export interface ProductProps {
  tenantId: string;
  name: string;
  sku: string;
  barcode: string | undefined;
  categoryId: string | undefined;
  hasVariants: boolean;
  itemKind: ProductKind;
  isActive: boolean;
  description: string | undefined;
  brand: string | undefined;
  imagePath: string | undefined;
  options: readonly ProductOption[];
}

export interface ProductOption {
  key: string;
  name: string;
  values: readonly string[];
}

export const ProductKinds = { PRODUCT: 'PRODUCT', SERVICE: 'SERVICE' } as const;
export type ProductKind = keyof typeof ProductKinds;

export class Product extends Entity<ProductProps> {
  private constructor(id: string, props: ProductProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    name: string;
    sku: string;
    barcode?: string | undefined;
    categoryId?: string | undefined;
    hasVariants?: boolean;
    itemKind?: ProductKind;
    isActive?: boolean;
    description?: string | undefined;
    brand?: string | undefined;
    imagePath?: string | undefined;
    options?: readonly ProductOption[] | undefined;
    createdAt?: Date;
    updatedAt?: Date;
  }): Product {
    if (!params.tenantId.trim()) {
      throw new InvalidCatalogError('Product must belong to a tenantId');
    }
    if (!params.name.trim()) {
      throw new InvalidCatalogError('Product name cannot be empty');
    }
    if (!params.sku.trim()) {
      throw new InvalidCatalogError('Product SKU cannot be empty');
    }

    const barcode = params.barcode?.trim();

    return new Product(
      params.id,
      {
        tenantId: params.tenantId,
        name: params.name.trim(),
        sku: params.sku.trim().toUpperCase(),
        barcode: barcode ? barcode : undefined,
        categoryId: params.categoryId?.trim() || undefined,
        hasVariants: params.hasVariants ?? false,
        itemKind: params.itemKind ?? 'PRODUCT',
        isActive: params.isActive ?? true,
        description: params.description?.trim() || undefined,
        brand: params.brand?.trim() || undefined,
        imagePath: params.imagePath?.trim() || undefined,
        options: params.options ?? [],
      },
      params.createdAt,
      params.updatedAt,
    );
  }

  public get tenantId(): string {
    return this.props.tenantId;
  }

  public get name(): string {
    return this.props.name;
  }

  public get sku(): string {
    return this.props.sku;
  }

  public get barcode(): string | undefined {
    return this.props.barcode;
  }

  public get categoryId(): string | undefined {
    return this.props.categoryId;
  }

  public get hasVariants(): boolean {
    return this.props.hasVariants;
  }

  public get itemKind(): ProductKind {
    return this.props.itemKind;
  }

  public get isActive(): boolean {
    return this.props.isActive;
  }

  public get description(): string | undefined { return this.props.description; }
  public get brand(): string | undefined { return this.props.brand; }
  public get imagePath(): string | undefined { return this.props.imagePath; }
  public get options(): readonly ProductOption[] { return this.props.options; }

  public rename(name: string): void {
    if (!name.trim()) {
      throw new InvalidCatalogError('Product name cannot be empty');
    }
    this.props.name = name.trim();
    this._updatedAt = new Date();
  }

  public assignCategory(categoryId: string | undefined): void {
    this.props.categoryId = categoryId?.trim() || undefined;
    this._updatedAt = new Date();
  }

  public updateBarcode(barcode: string | undefined): void {
    const trimmed = barcode?.trim();
    this.props.barcode = trimmed ? trimmed : undefined;
    this._updatedAt = new Date();
  }

  public activate(): void {
    this.props.isActive = true;
    this._updatedAt = new Date();
  }

  public deactivate(): void {
    this.props.isActive = false;
    this._updatedAt = new Date();
  }
}
