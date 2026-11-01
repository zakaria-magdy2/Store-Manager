import { Entity } from '../common/entity.base.js';
import { InvalidCatalogError } from '../common/errors.js';

export interface CategoryProps {
  tenantId: string;
  name: string;
  code: string;
  parentId: string | undefined;
  isActive: boolean;
}

export class Category extends Entity<CategoryProps> {
  private constructor(id: string, props: CategoryProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    parentId?: string | undefined;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): Category {
    if (!params.tenantId.trim()) {
      throw new InvalidCatalogError('Category must belong to a tenantId');
    }
    if (!params.name.trim()) {
      throw new InvalidCatalogError('Category name cannot be empty');
    }
    if (!params.code.trim()) {
      throw new InvalidCatalogError('Category code cannot be empty');
    }
    if (params.parentId !== undefined && params.parentId.trim() === params.id) {
      throw new InvalidCatalogError('Category cannot be its own parent');
    }

    return new Category(
      params.id,
      {
        tenantId: params.tenantId,
        name: params.name.trim(),
        code: params.code.trim().toUpperCase(),
        parentId: params.parentId?.trim() || undefined,
        isActive: params.isActive ?? true,
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

  public get code(): string {
    return this.props.code;
  }

  public get parentId(): string | undefined {
    return this.props.parentId;
  }

  public get isActive(): boolean {
    return this.props.isActive;
  }

  public rename(name: string): void {
    if (!name.trim()) {
      throw new InvalidCatalogError('Category name cannot be empty');
    }
    this.props.name = name.trim();
    this._updatedAt = new Date();
  }

  public moveTo(parentId: string | undefined): void {
    if (parentId !== undefined && parentId.trim() === this.id) {
      throw new InvalidCatalogError('Category cannot be its own parent');
    }
    this.props.parentId = parentId?.trim() || undefined;
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
