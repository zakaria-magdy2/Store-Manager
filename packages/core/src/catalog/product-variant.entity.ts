import { Entity } from '../common/entity.base.js';
import { InvalidCatalogError } from '../common/errors.js';
import type { Money } from '../money/money.js';
import type { AttributeValue, ProductAttributes } from './attributes.js';
import { normalizeAttributes } from './attributes.js';

export interface ProductVariantProps {
  tenantId: string;
  productId: string;
  sku: string;
  barcode: string | undefined;
  attributes: ProductAttributes;
  retailPrice: Money;
  reorderPoint: bigint;
  isActive: boolean;
}

export class ProductVariant extends Entity<ProductVariantProps> {
  private constructor(id: string, props: ProductVariantProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    productId: string;
    sku: string;
    barcode?: string | undefined;
    attributes?: Record<string, AttributeValue> | undefined;
    retailPrice: Money;
    reorderPoint?: bigint | undefined;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): ProductVariant {
    if (!params.tenantId.trim()) {
      throw new InvalidCatalogError('Variant must belong to a tenantId');
    }
    if (!params.productId.trim()) {
      throw new InvalidCatalogError('Variant must belong to a productId');
    }
    if (!params.sku.trim()) {
      throw new InvalidCatalogError('Variant SKU cannot be empty');
    }
    if (!params.retailPrice.isPositive() && !params.retailPrice.isZero()) {
      throw new InvalidCatalogError('Variant retail price cannot be negative');
    }

    const reorderPoint = params.reorderPoint ?? 0n;
    if (reorderPoint < 0n) {
      throw new InvalidCatalogError('Variant reorder point cannot be negative');
    }

    const barcode = params.barcode?.trim();

    return new ProductVariant(
      params.id,
      {
        tenantId: params.tenantId,
        productId: params.productId.trim(),
        sku: params.sku.trim().toUpperCase(),
        barcode: barcode ? barcode : undefined,
        attributes: normalizeAttributes(params.attributes),
        retailPrice: params.retailPrice,
        reorderPoint,
        isActive: params.isActive ?? true,
      },
      params.createdAt,
      params.updatedAt,
    );
  }

  public get tenantId(): string {
    return this.props.tenantId;
  }

  public get productId(): string {
    return this.props.productId;
  }

  public get sku(): string {
    return this.props.sku;
  }

  public get barcode(): string | undefined {
    return this.props.barcode;
  }

  public get attributes(): ProductAttributes {
    return this.props.attributes;
  }

  public get retailPrice(): Money {
    return this.props.retailPrice;
  }

  public get reorderPoint(): bigint {
    return this.props.reorderPoint;
  }

  public get isActive(): boolean {
    return this.props.isActive;
  }

  public changePrice(newPrice: Money): void {
    if (newPrice.currency.code !== this.props.retailPrice.currency.code) {
      throw new InvalidCatalogError('Variant retail price currency cannot change');
    }
    if (newPrice.isNegative()) {
      throw new InvalidCatalogError('Variant retail price cannot be negative');
    }
    this.props.retailPrice = newPrice;
    this._updatedAt = new Date();
  }

  public updateBarcode(barcode: string | undefined): void {
    const trimmed = barcode?.trim();
    this.props.barcode = trimmed ? trimmed : undefined;
    this._updatedAt = new Date();
  }

  public setReorderPoint(reorderPoint: bigint): void {
    if (reorderPoint < 0n) {
      throw new InvalidCatalogError('Variant reorder point cannot be negative');
    }
    this.props.reorderPoint = reorderPoint;
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
