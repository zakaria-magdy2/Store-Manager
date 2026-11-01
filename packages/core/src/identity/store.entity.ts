import { Entity } from '../common/entity.base.js';

export interface StoreProps {
  tenantId: string;
  name: string;
  code: string;
  address: string | undefined;
  phone: string | undefined;
  isActive: boolean;
}

export class Store extends Entity<StoreProps> {
  private constructor(id: string, props: StoreProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    address?: string | undefined;
    phone?: string | undefined;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): Store {
    if (!params.tenantId.trim()) {
      throw new Error('StoreError: Store must belong to a tenantId');
    }
    if (!params.name.trim()) {
      throw new Error('StoreError: Store name cannot be empty');
    }
    if (!params.code.trim()) {
      throw new Error('StoreError: Store code cannot be empty');
    }

    return new Store(
      params.id,
      {
        tenantId: params.tenantId,
        name: params.name.trim(),
        code: params.code.trim().toUpperCase(),
        address: params.address?.trim(),
        phone: params.phone?.trim(),
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

  public get address(): string | undefined {
    return this.props.address;
  }

  public get phone(): string | undefined {
    return this.props.phone;
  }

  public get isActive(): boolean {
    return this.props.isActive;
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
