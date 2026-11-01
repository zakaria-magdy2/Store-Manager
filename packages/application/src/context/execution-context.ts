/**
 * Carries the identity and authorization scope of the current operation.
 * Every command and query handler receives an ExecutionContext and must
 * verify permissions before performing tenant- or store-scoped work.
 */
export interface ExecutionContext {
  readonly tenantId: string;
  /** Present for store-level operations; absent for tenant-wide operations. */
  readonly storeId?: string | undefined;
  readonly userId: string;
  readonly roleId: string;
  readonly permissions: ReadonlySet<string>;
  readonly correlationId: string;
}

export class ScopedExecutionContext implements ExecutionContext {
  public readonly tenantId: string;
  public readonly userId: string;
  public readonly roleId: string;
  public readonly permissions: ReadonlySet<string>;
  public readonly correlationId: string;
  public readonly storeId: string | undefined;

  constructor(params: {
    tenantId: string;
    userId: string;
    roleId: string;
    permissions: ReadonlySet<string>;
    correlationId: string;
    storeId?: string | undefined;
  }) {
    if (!params.tenantId) {
      throw new Error('ExecutionContextError: tenantId is mandatory for every operation');
    }
    if (!params.userId) {
      throw new Error('ExecutionContextError: userId is mandatory');
    }

    this.tenantId = params.tenantId;
    this.userId = params.userId;
    this.roleId = params.roleId;
    this.permissions = params.permissions;
    this.correlationId = params.correlationId;
    this.storeId = params.storeId;
  }

  public hasPermission(permission: string): boolean {
    return this.permissions.has(permission) || this.permissions.has('*');
  }

  public assertPermission(permission: string): void {
    if (!this.hasPermission(permission)) {
      throw new Error(
        `UnauthorizedError: User ${this.userId} lacks required permission: ${permission}`,
      );
    }
  }
}
