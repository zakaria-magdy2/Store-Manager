/**
 * System roles in RetailOS.
 * - OWNER: Full administrative access across all stores and financial settings.
 * - STORE_MANAGER: Full operational management within assigned store(s).
 * - CASHIER: Fast checkout, refunds, and cash drawer management within assigned store.
 * - AUDITOR: Read-only access to financial ledgers, inventory, and audit reports.
 */
export type Role = 'OWNER' | 'STORE_MANAGER' | 'CASHIER' | 'AUDITOR';

export const Roles: Record<Role, Role> = {
  OWNER: 'OWNER',
  STORE_MANAGER: 'STORE_MANAGER',
  CASHIER: 'CASHIER',
  AUDITOR: 'AUDITOR',
};

/**
 * Fine-grained permissions governing system operations.
 */
export const Permissions = {
  // POS Operations
  POS_CHECKOUT: 'pos:checkout',
  POS_DISCOUNT: 'pos:discount',
  POS_REFUND: 'pos:refund',
  POS_DRAWER_OPEN: 'pos:drawer:open',

  // Inventory Operations
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_ADJUST: 'inventory:adjust',
  INVENTORY_RECEIVE: 'inventory:receive',
  INVENTORY_TRANSFER: 'inventory:transfer',

  // Product Catalog
  CATALOG_MANAGE: 'catalog:manage',

  // Financial & Reporting
  REPORTS_DAILY_VIEW: 'reports:daily:view',
  REPORTS_MONTHLY_VIEW: 'reports:monthly:view',
  REPORTS_FINANCIAL_VIEW: 'reports:financial:view',
  REPORTS_COGS_VIEW: 'reports:cogs:view',

  // Operating Expenses
  EXPENSES_DIRECT_CREATE: 'expenses:direct:create',
  EXPENSES_MONTHLY_CONFIRM: 'expenses:monthly:confirm',
  EXPENSES_MONTHLY_PAY: 'expenses:monthly:pay',

  // Administration & Tenant Governance
  USERS_MANAGE: 'users:manage',
  STORES_MANAGE: 'stores:manage',
  SETTINGS_MANAGE: 'settings:manage',
  AUDIT_LOG_VIEW: 'audit_log:view',
  SYSTEM_BACKUP_MANAGE: 'system:backup:manage',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

/**
 * Canonical mapping from System Role to granted Permissions.
 */
export const RolePermissions: Record<Role, ReadonlySet<string>> = {
  OWNER: new Set(['*']), // Wildcard: full tenant-level clearance

  STORE_MANAGER: new Set([
    Permissions.POS_CHECKOUT,
    Permissions.POS_DISCOUNT,
    Permissions.POS_REFUND,
    Permissions.POS_DRAWER_OPEN,
    Permissions.INVENTORY_VIEW,
    Permissions.INVENTORY_ADJUST,
    Permissions.INVENTORY_RECEIVE,
    Permissions.INVENTORY_TRANSFER,
    Permissions.CATALOG_MANAGE,
    Permissions.REPORTS_DAILY_VIEW,
    Permissions.REPORTS_MONTHLY_VIEW,
    Permissions.EXPENSES_DIRECT_CREATE,
    Permissions.EXPENSES_MONTHLY_CONFIRM,
    Permissions.EXPENSES_MONTHLY_PAY,
    Permissions.USERS_MANAGE,
  ]),

  CASHIER: new Set([
    Permissions.POS_CHECKOUT,
    // Cashiers can browse sellable items and complete checkout only.
    Permissions.INVENTORY_VIEW,
  ]),

  AUDITOR: new Set([
    Permissions.INVENTORY_VIEW,
    Permissions.REPORTS_DAILY_VIEW,
    Permissions.REPORTS_MONTHLY_VIEW,
    Permissions.REPORTS_FINANCIAL_VIEW,
    Permissions.REPORTS_COGS_VIEW,
    Permissions.AUDIT_LOG_VIEW,
  ]),
};

/**
 * Resolve the effective set of permissions for a role.
 */
export function getPermissionsForRole(role: Role): ReadonlySet<string> {
  const perms = RolePermissions[role];
  if (!perms) {
    throw new Error(`UnknownRoleError: Unrecognized role '${role}'`);
  }
  return perms;
}
