import { describe, it, expect } from 'vitest';
import {
  Tenant,
  Store,
  User,
  Roles,
  Permissions,
  getPermissionsForRole,
} from '../src/identity/index.js';

describe('Identity & RBAC Domain Entities', () => {
  it('creates a Tenant and handles activation/deactivation', () => {
    const tenant = Tenant.create({
      id: 'tenant-1',
      name: 'Retail MegaCorp',
      code: 'megacorp',
      currency: 'usd',
    });

    expect(tenant.id).toBe('tenant-1');
    expect(tenant.name).toBe('Retail MegaCorp');
    expect(tenant.code).toBe('MEGACORP'); // Upper-cased
    expect(tenant.currency).toBe('USD');
    expect(tenant.isActive).toBe(true);

    tenant.deactivate();
    expect(tenant.isActive).toBe(false);

    tenant.activate();
    expect(tenant.isActive).toBe(true);
  });

  it('rejects invalid Tenant creation', () => {
    expect(() =>
      Tenant.create({ id: 't1', name: '', code: 'C', currency: 'USD' }),
    ).toThrow('TenantError');
    expect(() =>
      Tenant.create({ id: 't1', name: 'N', code: '', currency: 'USD' }),
    ).toThrow('TenantError');
  });

  it('creates a Store belonging to a tenant', () => {
    const store = Store.create({
      id: 'store-1',
      tenantId: 'tenant-1',
      name: 'Downtown Branch',
      code: 'dt-01',
      address: '123 Main St',
      phone: '+1-555-0100',
    });

    expect(store.tenantId).toBe('tenant-1');
    expect(store.name).toBe('Downtown Branch');
    expect(store.code).toBe('DT-01');
    expect(store.address).toBe('123 Main St');
    expect(store.phone).toBe('+1-555-0100');
    expect(store.isActive).toBe(true);
  });

  it('creates a User and enforces Cashier store assignment constraint', () => {
    // CASHIER without storeId must throw
    expect(() =>
      User.create({
        id: 'u1',
        tenantId: 't1',
        username: 'john_cashier',
        passwordHash: 'argon2_hashed_value',
        fullName: 'John Cashier',
        role: Roles.CASHIER,
      }),
    ).toThrow('Cashier must be assigned to a specific store');

    // CASHIER with storeId succeeds
    const cashier = User.create({
      id: 'u1',
      tenantId: 't1',
      username: 'john_cashier',
      passwordHash: 'argon2_hashed_value',
      fullName: 'John Cashier',
      role: Roles.CASHIER,
      storeId: 'store-1',
    });

    expect(cashier.username).toBe('john_cashier');
    expect(cashier.role).toBe('CASHIER');
    expect(cashier.storeId).toBe('store-1');

    // OWNER can be unassigned to any specific store (has tenant-wide scope)
    const owner = User.create({
      id: 'u2',
      tenantId: 't1',
      username: 'boss',
      passwordHash: 'hash',
      fullName: 'Store Owner',
      role: Roles.OWNER,
    });
    expect(owner.storeId).toBeUndefined();
  });

  it('verifies RBAC permissions across system roles', () => {
    const ownerPerms = getPermissionsForRole(Roles.OWNER);
    expect(ownerPerms.has('*')).toBe(true);

    const cashierPerms = getPermissionsForRole(Roles.CASHIER);
    expect(cashierPerms.has(Permissions.POS_CHECKOUT)).toBe(true);
    expect(cashierPerms.has(Permissions.INVENTORY_VIEW)).toBe(true);
    expect(cashierPerms.has(Permissions.POS_REFUND)).toBe(false);
    expect(cashierPerms.has(Permissions.POS_DISCOUNT)).toBe(false);
    expect(cashierPerms.has(Permissions.EXPENSES_DIRECT_CREATE)).toBe(false);
    expect(cashierPerms.has(Permissions.REPORTS_DAILY_VIEW)).toBe(false);
    expect(cashierPerms.has(Permissions.REPORTS_FINANCIAL_VIEW)).toBe(false);
    expect(cashierPerms.has(Permissions.USERS_MANAGE)).toBe(false);

    const managerPerms = getPermissionsForRole(Roles.STORE_MANAGER);
    expect(managerPerms.has(Permissions.POS_CHECKOUT)).toBe(true);
    expect(managerPerms.has(Permissions.INVENTORY_ADJUST)).toBe(true);
    expect(managerPerms.has(Permissions.EXPENSES_DIRECT_CREATE)).toBe(true);
    expect(managerPerms.has(Permissions.REPORTS_FINANCIAL_VIEW)).toBe(false); // Only Auditor or Owner
    expect(managerPerms.has(Permissions.SYSTEM_BACKUP_MANAGE)).toBe(false);

    const auditorPerms = getPermissionsForRole(Roles.AUDITOR);
    expect(auditorPerms.has(Permissions.REPORTS_FINANCIAL_VIEW)).toBe(true);
    expect(auditorPerms.has(Permissions.REPORTS_COGS_VIEW)).toBe(true);
    expect(auditorPerms.has(Permissions.POS_CHECKOUT)).toBe(false);
  });
});
