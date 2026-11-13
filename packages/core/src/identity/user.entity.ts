import { Entity } from '../common/entity.base.js';
import type { Role } from './roles.js';

export interface UserProps {
  tenantId: string;
  username: string;
  passwordHash: string;
  fullName: string;
  phone: string | undefined;
  employmentStartDate: string;
  shiftStartTime: string | undefined;
  lateGraceMinutes: number;
  role: Role;
  storeId: string | undefined;
  isActive: boolean;
}

const SHIFT_START_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    phone?: string | undefined;
    employmentStartDate?: string | undefined;
    shiftStartTime?: string | undefined;
    lateGraceMinutes?: number | undefined;
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

    const normalizedShiftStart = params.shiftStartTime?.trim() || undefined;
    if (normalizedShiftStart && !SHIFT_START_TIME_REGEX.test(normalizedShiftStart)) {
      throw new Error('UserError: Invalid shiftStartTime format (expected HH:MM)');
    }
    const normalizedGrace = params.lateGraceMinutes ?? 0;
    if (!Number.isInteger(normalizedGrace) || normalizedGrace < 0 || normalizedGrace > 180) {
      throw new Error('UserError: lateGraceMinutes must be an integer between 0 and 180');
    }

    return new User(
      params.id,
      {
        tenantId: params.tenantId,
        username: params.username.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        fullName: params.fullName.trim(),
        phone: params.phone?.trim() || undefined,
        employmentStartDate: params.employmentStartDate ?? (params.createdAt ?? new Date()).toISOString().slice(0, 10),
        shiftStartTime: normalizedShiftStart,
        lateGraceMinutes: normalizedGrace,
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

  public get phone(): string | undefined {
    return this.props.phone;
  }

  public get employmentStartDate(): string {
    return this.props.employmentStartDate;
  }

  public get shiftStartTime(): string | undefined {
    return this.props.shiftStartTime;
  }

  public get lateGraceMinutes(): number {
    return this.props.lateGraceMinutes;
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
