import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ScopedExecutionContext } from '@retailos/application';
import { Permissions } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';
import { SqliteUnitOfWork } from '../src/database/unit-of-work.js';
import { SqliteAuditLogRepository } from '../src/database/repositories/sqlite-audit-log.repository.js';
import { SqliteUserRepository } from '../src/database/repositories/sqlite-user.repository.js';
import { User } from '@retailos/core';
import { up as employeeProfileMigration } from '../src/database/migrations/015_employee_profiles.js';
import { up as attendanceScheduleMigration } from '../src/database/migrations/020_attendance_schedule.js';

describe('SQLite Database & Migration Engine', () => {
  let dbManager: SqliteDatabaseManager;

  beforeEach(() => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('successfully executes initial migrations and verifies schema tables', async () => {
    // getDb() returns Kysely<RetailOSDatabase> which is assignable to Kysely<unknown>
    const migrator = new DatabaseMigrator(dbManager.getDb());
    const result = await migrator.migrateToLatest();

    expect(result.success).toBe(true);
    expect(result.executedMigrations).toContain('001_initial_foundation');

    const db = dbManager.getDb();

    // Insert test tenant
    const tenantId = '018f3a2c-0000-7000-8000-000000000001';
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: 'Main Retail Business',
        code: 'TENANT_01',
        currency: 'USD',
      })
      .execute();

    // Insert test store
    const storeId = '018f3a2c-0000-7000-8000-000000000002';
    await db
      .insertInto('stores')
      .values({
        id: storeId,
        tenant_id: tenantId,
        name: 'Downtown Flagship Branch',
        code: 'STORE_01',
      })
      .execute();

    // Query tenant and store
    const tenants = await db.selectFrom('tenants').selectAll().execute();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.name).toBe('Main Retail Business');
    expect(tenants[0]!.currency).toBe('USD');

    const stores = await db
      .selectFrom('stores')
      .where('tenant_id', '=', tenantId)
      .selectAll()
      .execute();
    expect(stores).toHaveLength(1);
    expect(stores[0]!.name).toBe('Downtown Flagship Branch');
  });

  it('backfills existing employee start dates from account creation dates', async () => {
    const db = dbManager.getDb();
    await db.schema.createTable('users')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .execute();
    await db.insertInto('users').values({ id: 'legacy-user', created_at: '2024-02-01 10:30:00' }).execute();

    await employeeProfileMigration(db);

    const user = await db.selectFrom('users').select(['phone', 'employment_start_date']).where('id', '=', 'legacy-user').executeTakeFirstOrThrow();
    expect(user.phone).toBeNull();
    expect(user.employment_start_date).toBe('2024-02-01');

    await attendanceScheduleMigration(db);
    const updatedUser = await db
      .selectFrom('users')
      .select(['shift_start_time', 'late_grace_minutes'])
      .where('id', '=', 'legacy-user')
      .executeTakeFirstOrThrow();
    expect(updatedUser.shift_start_time).toBeNull();
    expect(updatedUser.late_grace_minutes).toBe(0);
  });

  it('persists and retrieves employee shiftStartTime and lateGraceMinutes via SqliteUserRepository', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    await migrator.migrateToLatest();
    const db = dbManager.getDb();

    const tenantId = '018f3a2c-0000-7000-8000-000000000101';
    const storeId = '018f3a2c-0000-7000-8000-000000000102';
    const userId = '018f3a2c-0000-7000-8000-000000000103';
    await db.insertInto('tenants').values({ id: tenantId, name: 'Schedule Co', code: 'SCH_01', currency: 'EGP' }).execute();
    await db.insertInto('stores').values({ id: storeId, tenant_id: tenantId, name: 'Branch 1', code: 'BR_1' }).execute();

    const repo = new SqliteUserRepository(db);
    const ctx = new ScopedExecutionContext({
      tenantId,
      userId,
      roleId: 'OWNER',
      permissions: new Set([Permissions.USERS_MANAGE]),
      correlationId: 'test-corr-schedule',
    });

    const cashier = User.create({
      id: userId,
      tenantId,
      storeId,
      username: 'cashier_sched',
      passwordHash: 'hash_placeholder_value_123456',
      fullName: 'Scheduled Cashier',
      shiftStartTime: '09:30',
      lateGraceMinutes: 15,
      role: 'CASHIER',
    });
    await repo.save(ctx, cashier);

    const loaded = await repo.findById(ctx, userId);
    expect(loaded).not.toBeNull();
    expect(loaded?.shiftStartTime).toBe('09:30');
    expect(loaded?.lateGraceMinutes).toBe(15);
  });

  it('enforces foreign key constraints in SQLite', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    await migrator.migrateToLatest();

    const db = dbManager.getDb();

    // Attempting to insert a store referencing a non-existent tenant must throw
    await expect(
      db
        .insertInto('stores')
        .values({
          id: '018f3a2c-0000-7000-8000-000000000099',
          tenant_id: '018f3a2c-0000-7000-8000-999999999999', // Non-existent
          name: 'Orphan Branch',
          code: 'ORPHAN_01',
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces tenant ownership across identity, catalog, and inventory relationships', async () => {
    await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    const db = dbManager.getDb();
    await db.insertInto('tenants').values([
      { id: 'tenant-guard-a', name: 'A', code: 'GUARD_A', currency: 'USD' },
      { id: 'tenant-guard-b', name: 'B', code: 'GUARD_B', currency: 'USD' },
    ]).execute();
    await db.insertInto('stores').values([
      { id: 'store-guard-a', tenant_id: 'tenant-guard-a', name: 'A', code: 'A' },
      { id: 'store-guard-b', tenant_id: 'tenant-guard-b', name: 'B', code: 'B' },
    ]).execute();
    await db.insertInto('users').values({
      id: 'user-guard-a', tenant_id: 'tenant-guard-a', store_id: null,
      username: 'a', password_hash: 'hash', full_name: 'A', role: 'OWNER',
    }).execute();
    await db.insertInto('suppliers').values({
      id: 'supplier-guard-a', tenant_id: 'tenant-guard-a', name: 'Supplier A',
      phone: null, notes: null,
    }).execute();
    await db.insertInto('supplier_purchases').values({
      id: 'purchase-guard-a', tenant_id: 'tenant-guard-a', store_id: 'store-guard-a',
      idempotency_key: 'purchase-guard-a',
      supplier_id: 'supplier-guard-a', invoice_number: 'INV-A', purchased_at: '2026-11-04T10:00:00.000Z',
      total_amount: 5000n, initial_paid_amount: 1000n, currency: 'USD',
      notes: null, created_by_user_id: 'user-guard-a',
    }).execute();
    await db.insertInto('supplier_payments').values({
      id: 'supplier-payment-guard-a', tenant_id: 'tenant-guard-a', supplier_id: 'supplier-guard-a',
      idempotency_key: 'supplier-payment-guard-a',
      purchase_id: 'purchase-guard-a', amount: 500n, currency: 'USD', payment_method: 'CASH',
      reference_number: null, paid_at: '2026-11-04T11:00:00.000Z', created_by_user_id: 'user-guard-a',
    }).execute();

    await expect(db.updateTable('supplier_purchases').set({ total_amount: 4000n })
      .where('id', '=', 'purchase-guard-a').execute()).rejects.toThrow('append-only');
    await expect(db.deleteFrom('supplier_payments').where('id', '=', 'supplier-payment-guard-a')
      .execute()).rejects.toThrow('append-only');
    await expect(db.insertInto('supplier_purchases').values({
      id: 'purchase-guard-invalid', tenant_id: 'tenant-guard-b', store_id: 'store-guard-a',
      supplier_id: 'supplier-guard-a', invoice_number: null, purchased_at: '2026-11-04T10:00:00.000Z',
      total_amount: 5000n, initial_paid_amount: 0n, currency: 'USD',
      notes: null, created_by_user_id: 'user-guard-a',
    }).execute()).rejects.toThrow('TenantIsolationViolation');
    await db.insertInto('categories').values({
      id: 'category-guard-a', tenant_id: 'tenant-guard-a', parent_id: null,
      name: 'A', code: 'A',
    }).execute();
    await db.insertInto('products').values({
      id: 'product-guard-a', tenant_id: 'tenant-guard-a', name: 'A', sku: 'A',
      barcode: null, category_id: 'category-guard-a', has_variants: 1,
    }).execute();
    await db.insertInto('product_variants').values({
      id: 'variant-guard-a', tenant_id: 'tenant-guard-a', product_id: 'product-guard-a',
      sku: 'A-1', barcode: null, attributes_json: '{}', retail_price: 100n,
      currency: 'USD', reorder_point: 0n,
    }).execute();
    await db.insertInto('supplier_purchase_items').values({
      id: 'purchase-item-guard-a', tenant_id: 'tenant-guard-a', store_id: 'store-guard-a',
      purchase_id: 'purchase-guard-a', variant_id: 'variant-guard-a', product_id: 'product-guard-a',
      product_name: 'A', sku: 'A-1', quantity: 1n, unit_cost: 1000n, currency: 'USD',
    }).execute();
    await expect(db.updateTable('supplier_purchase_items').set({ quantity: 2n })
      .where('id', '=', 'purchase-item-guard-a').execute()).rejects.toThrow('append-only');

    await expect(db.insertInto('users').values({
      id: 'user-guard-invalid', tenant_id: 'tenant-guard-a', store_id: 'store-guard-b',
      username: 'invalid', password_hash: 'hash', full_name: 'Invalid', role: 'CASHIER',
    }).execute()).rejects.toThrow('TenantIsolationViolation');

    await expect(db.insertInto('products').values({
      id: 'product-guard-invalid', tenant_id: 'tenant-guard-b', name: 'Invalid', sku: 'INVALID',
      barcode: null, category_id: 'category-guard-a', has_variants: 0,
    }).execute()).rejects.toThrow('TenantIsolationViolation');

    await expect(db.insertInto('product_variants').values({
      id: 'variant-guard-invalid', tenant_id: 'tenant-guard-b', product_id: 'product-guard-a',
      sku: 'INVALID-1', barcode: null, attributes_json: '{}', retail_price: 100n,
      currency: 'USD', reorder_point: 0n,
    }).execute()).rejects.toThrow('TenantIsolationViolation');

    await expect(db.insertInto('inventory_items').values({
      id: 'inventory-guard-invalid', tenant_id: 'tenant-guard-a', store_id: 'store-guard-b',
      variant_id: 'variant-guard-a', quantity_on_hand: 0n, wac_cost: 0n, currency: 'USD',
    }).execute()).rejects.toThrow('TenantIsolationViolation');

    await db.insertInto('accounting_periods').values({
      id: 'period-guard-a', tenant_id: 'tenant-guard-a', name: '2026',
      start_date: '2026-01-01', end_date: '2026-12-31',
    }).execute();
    await db.insertInto('accounts').values({
      id: 'account-guard-b', tenant_id: 'tenant-guard-b', account_code: '1000',
      account_name: 'Cash', account_type: 'ASSET', normal_balance: 'DEBIT',
    }).execute();
    await db.insertInto('journal_entries').values({
      id: 'journal-guard-a', tenant_id: 'tenant-guard-a', store_id: null,
      period_id: 'period-guard-a', entry_number: 'J-1', entry_date: '2026-01-01',
      source_type: 'ADJUSTMENT', source_id: 'source-1', idempotency_key: 'key-1',
      status: 'POSTED', reversed_by_entry_id: null, created_by_user_id: 'user-guard-a',
    }).execute();
    await expect(db.insertInto('journal_lines').values({
      id: 'line-guard-invalid', journal_entry_id: 'journal-guard-a',
      account_id: 'account-guard-b', entry_type: 'DEBIT', amount: 100n,
      currency: 'USD', memo: null,
    }).execute()).rejects.toThrow('TenantIsolationViolation');

    await expect(db.insertInto('outbox_events').values({
      id: 'outbox-guard-invalid', tenant_id: 'tenant-guard-a', store_id: 'store-guard-b',
      aggregate_type: 'sale', aggregate_id: 'sale-1', event_type: 'created',
      payload: '{}', sequence_no: 1, idempotency_key: 'outbox-key', synced_at: null,
    }).execute()).rejects.toThrow('TenantIsolationViolation');
  });

  it('commits atomic work, rolls back on failure, and supports nested re-entrant transactions via SqliteUnitOfWork', async () => {
    await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    const uow = new SqliteUnitOfWork(dbManager);

    await uow.execute(async () => {
      await uow.getExecutor().insertInto('tenants').values({
        id: 'tenant-uow-1',
        name: 'UoW Primary Tenant',
        code: 'UOW_1',
        currency: 'USD',
      }).execute();

      await uow.execute(async () => {
        await uow.getExecutor().insertInto('stores').values({
          id: 'store-uow-1',
          tenant_id: 'tenant-uow-1',
          name: 'Nested Store',
          code: 'STORE_UOW_1',
        }).execute();
      });
    });

    await expect(
      uow.execute(async () => {
        await uow.getExecutor().insertInto('stores').values({
          id: 'store-uow-rollback',
          tenant_id: 'tenant-uow-1',
          name: 'Rolled Back Store',
          code: 'STORE_ROLLBACK',
        }).execute();
        throw new Error('Simulated transaction failure');
      }),
    ).rejects.toThrow('Simulated transaction failure');

    dbManager.checkpointPassive();

    const stores = await dbManager.getDb().selectFrom('stores').selectAll().execute();
    expect(stores).toHaveLength(1);
    expect(stores[0]?.id).toBe('store-uow-1');
  });

  it('maintains a tamper-evident hash chain in audit_logs, redacts secrets, and enforces append-only triggers', async () => {
    await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    const db = dbManager.getDb();

    await db.insertInto('tenants').values([
      { id: 'tenant-audit-a', name: 'Audit Co A', code: 'AUDIT_A', currency: 'EGP' },
      { id: 'tenant-audit-b', name: 'Audit Co B', code: 'AUDIT_B', currency: 'EGP' },
    ]).execute();
    await db.insertInto('stores').values([
      { id: 'store-audit-a', tenant_id: 'tenant-audit-a', name: 'Main A', code: 'MAIN_A' },
      { id: 'store-audit-b', tenant_id: 'tenant-audit-b', name: 'Main B', code: 'MAIN_B' },
    ]).execute();
    await db.insertInto('users').values({
      id: 'user-audit-a',
      tenant_id: 'tenant-audit-a',
      store_id: 'store-audit-a',
      username: 'owner_a',
      password_hash: 'hash',
      full_name: 'Owner A',
      role: 'OWNER',
    }).execute();

    const ownerCtx = new ScopedExecutionContext({
      tenantId: 'tenant-audit-a',
      storeId: 'store-audit-a',
      userId: 'user-audit-a',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-audit-1',
    });

    const cashierCtx = new ScopedExecutionContext({
      tenantId: 'tenant-audit-a',
      storeId: 'store-audit-a',
      userId: 'user-audit-a',
      roleId: 'CASHIER',
      permissions: new Set([Permissions.POS_CHECKOUT]),
      correlationId: 'corr-audit-2',
    });

    const auditRepo = new SqliteAuditLogRepository(db);

    const first = await auditRepo.record(ownerCtx, {
      actorUsername: 'owner_a',
      actorRole: 'OWNER',
      action: 'AUTH_LOGIN_SUCCESS',
      entityType: 'USER',
      entityId: 'user-audit-a',
      summary: 'Owner signed in',
      metadata: { password: 'should-never-be-stored', ip: '127.0.0.1' },
    });
    expect(first.previousHash).toBe('GENESIS');
    expect(first.metadata).toEqual({ ip: '127.0.0.1', password: '[REDACTED]' });

    const second = await auditRepo.record(ownerCtx, {
      actorUsername: 'owner_a',
      actorRole: 'OWNER',
      action: 'PRODUCT_CREATED',
      entityType: 'PRODUCT',
      entityId: 'prod-1',
      summary: 'Created product SKU-1',
      metadata: { retailPrice: 12500n },
    });
    expect(second.previousHash).toBe(first.entryHash);
    expect(second.metadata).toEqual({ retailPrice: '12500' });

    const verification = await auditRepo.verifyChain(ownerCtx);
    expect(verification.valid).toBe(true);
    expect(verification.checkedCount).toBe(2);
    expect(verification.headHash).toBe(second.entryHash);

    const listed = await auditRepo.list(ownerCtx);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe(second.id);
    expect(listed[1]?.id).toBe(first.id);

    await expect(auditRepo.list(cashierCtx)).rejects.toThrow('UnauthorizedError');

    await expect(
      db.updateTable('audit_logs').set({ summary: 'Tampered' }).where('id', '=', first.id).execute(),
    ).rejects.toThrow('append-only');

    await expect(
      db.deleteFrom('audit_logs').where('id', '=', first.id).execute(),
    ).rejects.toThrow('append-only');

    await expect(
      db.insertInto('audit_logs').values({
        id: 'cross-tenant-audit',
        tenant_id: 'tenant-audit-a',
        store_id: 'store-audit-b',
        actor_user_id: 'user-audit-a',
        actor_username: 'owner_a',
        actor_role: 'OWNER',
        action: 'TEST',
        entity_type: 'STORE',
        entity_id: 'store-audit-b',
        summary: 'Invalid cross-tenant store',
        metadata_json: '{}',
        previous_hash: 'GENESIS',
        entry_hash: 'hash',
        created_at: new Date().toISOString(),
      }).execute(),
    ).rejects.toThrow('TenantIsolationViolation');
  });

  it('enforces stocktake session tenant isolation and post-commit immutability', async () => {
    await new DatabaseMigrator(dbManager.getDb()).migrateToLatest();
    const db = dbManager.getDb();

    await db.insertInto('tenants').values([
      { id: 'tenant-stk-a', name: 'A', code: 'STK_A', currency: 'EGP' },
      { id: 'tenant-stk-b', name: 'B', code: 'STK_B', currency: 'EGP' },
    ]).execute();
    await db.insertInto('stores').values([
      { id: 'store-stk-a', tenant_id: 'tenant-stk-a', name: 'A', code: 'STK_S1' },
      { id: 'store-stk-b', tenant_id: 'tenant-stk-b', name: 'B', code: 'STK_S2' },
    ]).execute();
    await db.insertInto('users').values({
      id: 'user-stk-a', tenant_id: 'tenant-stk-a', store_id: 'store-stk-a',
      username: 'stk_owner', password_hash: 'hash', full_name: 'Owner', role: 'OWNER',
    }).execute();
    await db.insertInto('categories').values({
      id: 'cat-stk-a', tenant_id: 'tenant-stk-a', parent_id: null, name: 'Cat', code: 'CAT',
    }).execute();
    await db.insertInto('products').values({
      id: 'prod-stk-a', tenant_id: 'tenant-stk-a', name: 'Item', sku: 'SKU-1',
      barcode: null, category_id: 'cat-stk-a', has_variants: 0,
    }).execute();
    await db.insertInto('product_variants').values({
      id: 'var-stk-a', tenant_id: 'tenant-stk-a', product_id: 'prod-stk-a',
      sku: 'SKU-1', barcode: '6220001', attributes_json: '{}', retail_price: 5000n,
      currency: 'EGP', reorder_point: 0n,
    }).execute();

    const nowIso = new Date().toISOString();
    await expect(
      db.insertInto('stocktake_sessions').values({
        id: 'stk-cross-tenant',
        tenant_id: 'tenant-stk-a',
        store_id: 'store-stk-b',
        session_number: 'STK-999',
        title: 'Cross Tenant',
        scope: 'FULL',
        category_id: null,
        blind_mode: 0,
        include_zero_stock: 1,
        status: 'DRAFT',
        idempotency_key: null,
        uncounted_strategy: null,
        currency: 'EGP',
        notes: null,
        total_lines: 0,
        counted_lines: 0,
        total_variance_qty: 0,
        total_surplus_cost: 0,
        total_shortage_cost: 0,
        net_variance_cost: 0,
        net_variance_retail: 0,
        journal_entry_id: null,
        created_by_user_id: 'user-stk-a',
        committed_by_user_id: null,
        created_at: nowIso,
        updated_at: nowIso,
        committed_at: null,
        cancelled_at: null,
      }).execute(),
    ).rejects.toThrow('TenantIsolationViolation');

    await db.insertInto('stocktake_sessions').values({
      id: 'stk-session-1',
      tenant_id: 'tenant-stk-a',
      store_id: 'store-stk-a',
      session_number: 'STK-1001',
      title: 'Full Count',
      scope: 'FULL',
      category_id: null,
      blind_mode: 0,
      include_zero_stock: 1,
      status: 'DRAFT',
      idempotency_key: null,
      uncounted_strategy: null,
      currency: 'EGP',
      notes: null,
      total_lines: 1,
      counted_lines: 0,
      total_variance_qty: 0,
      total_surplus_cost: 0,
      total_shortage_cost: 0,
      net_variance_cost: 0,
      net_variance_retail: 0,
      journal_entry_id: null,
      created_by_user_id: 'user-stk-a',
      committed_by_user_id: null,
      created_at: nowIso,
      updated_at: nowIso,
      committed_at: null,
      cancelled_at: null,
    }).execute();

    await db.insertInto('stocktake_lines').values({
      id: 'stk-line-1',
      session_id: 'stk-session-1',
      tenant_id: 'tenant-stk-a',
      store_id: 'store-stk-a',
      variant_id: 'var-stk-a',
      product_id: 'prod-stk-a',
      product_name: 'Item',
      sku: 'SKU-1',
      barcode: '6220001',
      category_id: 'cat-stk-a',
      category_name: 'Cat',
      expected_quantity: 10,
      counted_quantity: null,
      unit_wac: 3000,
      retail_price: 5000,
      override_unit_cost: null,
      scanned_count: 0,
      reason: null,
      committed_expected_quantity: null,
      committed_variance_qty: null,
      committed_variance_cost: null,
      committed_unit_cost: null,
      last_counted_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    }).execute();

    await db.updateTable('stocktake_lines')
      .set({ counted_quantity: 9, updated_at: nowIso })
      .where('id', '=', 'stk-line-1')
      .execute();

    await db.updateTable('stocktake_sessions')
      .set({ status: 'COMMITTED', committed_by_user_id: 'user-stk-a', committed_at: nowIso, updated_at: nowIso })
      .where('id', '=', 'stk-session-1')
      .execute();

    await expect(
      db.updateTable('stocktake_sessions').set({ title: 'Edited' }).where('id', '=', 'stk-session-1').execute(),
    ).rejects.toThrow('immutable');

    await expect(
      db.updateTable('stocktake_lines').set({ counted_quantity: 10 }).where('id', '=', 'stk-line-1').execute(),
    ).rejects.toThrow('finalization');

    await expect(
      db.deleteFrom('stocktake_sessions').where('id', '=', 'stk-session-1').execute(),
    ).rejects.toThrow('cannot be deleted');
  });
});
