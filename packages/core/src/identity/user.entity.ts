import { Entity } from '../common/entity.base.js';
import type { Role } from './roles.js';

export interface UserProps {
  tenantId: string;
  username: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  storeId: string | undefined;
  isActive: boolean;
}

export class User extends Entity<UserProps> {
  private constructor(id: string, props: UserProps, createdAt?: Date, updatedAt?: Date) {
    super(id, props, createdAt, updatedAt);
  }

  public static create(params: {
    id: string;
    tenantId: string;
    username: string;
    passwordHash: string;
    fullName: string;
    role: Role;
    storeId?: string | undefined;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): User {
    if (!params.tenantId.trim()) {
      throw new Error('UserError: User must belong to a tenantId');
    }
    if (!params.username.trim()) {
      throw new Error('UserError: Username cannot be empty');
    }
    if (!params.passwordHash.trim()) {
      throw new Error('UserError: Password hash cannot be empty');
    }
    if (!params.fullName.trim()) {
      throw new Error('UserError: Full name cannot be empty');
    }

    // Role-Store constraint: Cashiers must be assigned to a specific store
    if (params.role === 'CASHIER' && !params.storeId?.trim()) {
      throw new Error('UserError: Cashier must be assigned to a specific store');
    }

    return new User(
      params.id,
      {
        tenantId: params.tenantId,
        username: params.username.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        fullName: params.fullName.trim(),
        role: params.role,
        storeId: params.storeId?.trim(),
        isActive: params.isActive ?? true,
      },
      params.createdAt,
      params.updatedAt,
    );
  }

  public get tenantId(): string {
    return this.props.tenantId;
  }

  public get username(): string {
    return this.props.username;
  }

  public get passwordHash(): string {
    return this.props.passwordHash;
  }

  public get fullName(): string {
    return this.props.fullName;
  }

  public get role(): Role {
    return this.props.role;
  }

  public get storeId(): string | undefined {
    return this.props.storeId;
  }

  public get isActive(): boolean {
    return this.props.isActive;
  }

  public updatePassword(newPasswordHash: string): void {
    if (!newPasswordHash.trim()) {
      throw new Error('UserError: New password hash cannot be empty');
    }
    this.props.passwordHash = newPasswordHash;
    this._updatedAt = new Date();
  }

  public assignStore(storeId: string | undefined): void {
    if (this.props.role === 'CASHIER' && !storeId) {
      throw new Error('UserError: Cashier must be assigned to a store');
    }
    this.props.storeId = storeId;
    this._updatedAt = new Date();
  }

  public changeRole(newRole: Role): void {
    if (newRole === 'CASHIER' && !this.props.storeId) {
      throw new Error('UserError: Cannot change role to CASHIER without an assigned store');
    }
    this.props.role = newRole;
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
