import { Entity } from '../common/entity.base.js';

export interface TenantProps {
  name: string;
  code: string;
  currency: string;
  isActive: boolean;
}

export class Tenant extends Entity<TenantProps> {
  private constructor(id: string, props: TenantProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    name: string;
    code: string;
    currency: string;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): Tenant {
    if (!params.name.trim()) {
      throw new Error('TenantError: Tenant name cannot be empty');
    }
    if (!params.code.trim()) {
      throw new Error('TenantError: Tenant code cannot be empty');
    }
    if (!params.currency.trim()) {
      throw new Error('TenantError: Tenant currency cannot be empty');
    }

    return new Tenant(
      params.id,
      {
        name: params.name.trim(),
        code: params.code.trim().toUpperCase(),
        currency: params.currency.trim().toUpperCase(),
        isActive: params.isActive ?? true,
      },
      params.createdAt,
      params.updatedAt,
    );
  }

  public get name(): string {
    return this.props.name;
  }

  public get code(): string {
    return this.props.code;
  }

  public get currency(): string {
    return this.props.currency;
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
