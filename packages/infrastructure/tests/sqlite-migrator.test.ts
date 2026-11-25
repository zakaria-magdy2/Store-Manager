import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ScopedExecutionContext } from '@retailos/application';
import { Permissions } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseDowngradeError, DatabaseMigrator, REGISTERED_MIGRATION_NAMES } from '../src/database/migrator.js';
import { SqliteUnitOfWork } from '../src/database/unit-of-work.js';
import { SqliteAuditLogRepository } from '../src/database/repositories/sqlite-audit-log.repository.js';
import { SqliteUserRepository } from '../src/database/repositories/sqlite-user.repository.js';
import { User } from '@retailos/core';
import { sql } from 'kysely';
import { up as employeeProfileMigration } from '../src/database/migrations/015_employee_profiles.js';
import { up as attendanceScheduleMigration } from '../src/database/migrations/020_attendance_schedule.js';
import { up as singleOpenShiftPerStoreMigration } from '../src/database/migrations/032_single_open_shift_per_store.js';
import { up as shiftReconciliationStatusMigration } from '../src/database/migrations/033_shift_reconciliation_status.js';

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

  it('fails Migration 024 cleanly when duplicate OPEN shifts exist and upgrades safely when clean', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    const pre = await migrator.migrateToLatest('023_business_timezone_shifts_sequences');
    expect(pre.success).toBe(true);

    const db = dbManager.getDb();
    await db.insertInto('tenants').values({ id: 'ten-shift-up', name: 'Shift Co', code: 'SH_UP', currency: 'EGP' }).execute();
    await db.insertInto('stores').values({ id: 'st-shift-up', tenant_id: 'ten-shift-up', name: 'S1', code: 'S1' }).execute();
    await db.insertInto('users').values({
      id: 'usr-shift-up', tenant_id: 'ten-shift-up', store_id: 'st-shift-up',
      username: 'cash1', password_hash: 'hash', full_name: 'Cashier', role: 'CASHIER',
    }).execute();

    await sql`
      INSERT INTO cashier_shifts (id, tenant_id, store_id, user_id, shift_number, status, opening_cash, started_at)
      VALUES
        ('sh-1', 'ten-shift-up', 'st-shift-up', 'usr-shift-up', 'SH-1001', 'OPEN', 0, '2026-11-10T09:00:00.000Z'),
        ('sh-2', 'ten-shift-up', 'st-shift-up', 'usr-shift-up', 'SH-1002', 'OPEN', 0, '2026-11-10T10:00:00.000Z');
    `.execute(db);

    const blocked = await migrator.migrateToLatest();
    expect(blocked.success).toBe(false);
    expect(blocked.error?.message).toMatch(/Migration024PreflightError/);

    await sql`UPDATE cashier_shifts SET status = 'CLOSED', ended_at = '2026-11-10T18:00:00.000Z' WHERE id = 'sh-1';`.execute(db);
    const recovered = await migrator.migrateToLatest();
    expect(recovered.success, recovered.error?.message).toBe(true);
  });

  it('Migration 026 scopes invoice uniqueness per supplier and reconciles unpaid legacy accruals to cash basis', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    const pre = await migrator.migrateToLatest('023_business_timezone_shifts_sequences');
    expect(pre.success).toBe(true);
    const db = dbManager.getDb();

    // Simulate an existing pre-fix 023 installation with the old tenant-wide invoice index
    await sql`DROP INDEX IF EXISTS idx_supplier_purchases_supplier_invoice;`.execute(db);
    await sql`
      CREATE UNIQUE INDEX idx_supplier_purchases_tenant_invoice
      ON supplier_purchases(tenant_id, invoice_number)
      WHERE invoice_number IS NOT NULL;
    `.execute(db);

    await db.insertInto('tenants').values({ id: 'ten-m26', name: 'M26', code: 'M26', currency: 'EGP' }).execute();
    await db.insertInto('stores').values({ id: 'st-m26', tenant_id: 'ten-m26', name: 'Main', code: 'M1' }).execute();
    await db.insertInto('users').values({
      id: 'usr-m26', tenant_id: 'ten-m26', store_id: null,
      username: 'owner26', password_hash: 'hash', full_name: 'Owner', role: 'OWNER',
    }).execute();
    await db.insertInto('suppliers').values([
      { id: 'sup-a', tenant_id: 'ten-m26', name: 'Supplier A', phone: null, notes: null },
      { id: 'sup-b', tenant_id: 'ten-m26', name: 'Supplier B', phone: null, notes: null },
    ]).execute();
    await db.insertInto('supplier_purchases').values({
      id: 'pur-a1', tenant_id: 'ten-m26', store_id: 'st-m26', supplier_id: 'sup-a',
      invoice_number: 'INV-888', purchased_at: '2026-11-05T10:00:00.000Z',
      total_amount: 10000n, initial_paid_amount: 0n, currency: 'EGP',
      notes: null, created_by_user_id: 'usr-m26', idempotency_key: 'pur-a1',
    }).execute();

    // Before 026, different supplier reusing INV-888 failed
    await expect(
      db.insertInto('supplier_purchases').values({
        id: 'pur-b1', tenant_id: 'ten-m26', store_id: 'st-m26', supplier_id: 'sup-b',
        invoice_number: 'INV-888', purchased_at: '2026-11-05T10:00:00.000Z',
        total_amount: 10000n, initial_paid_amount: 0n, currency: 'EGP',
        notes: null, created_by_user_id: 'usr-m26', idempotency_key: 'pur-b1',
      }).execute(),
    ).rejects.toThrow();

    // Seed legacy accrued monthly rent: 4000 EGP accrued, 133 EGP paid -> open period 2026-11
    await db.insertInto('accounts').values([
      { id: 'acc-1010', tenant_id: 'ten-m26', account_code: '1010', account_name: 'Cash', account_type: 'ASSET', normal_balance: 'DEBIT' },
      { id: 'acc-2020', tenant_id: 'ten-m26', account_code: '2020', account_name: 'Accrued', account_type: 'LIABILITY', normal_balance: 'CREDIT' },
      { id: 'acc-6090', tenant_id: 'ten-m26', account_code: '6090', account_name: 'Expense', account_type: 'EXPENSE', normal_balance: 'DEBIT' },
    ]).execute();
    await db.insertInto('accounting_periods').values({
      id: 'ten-m26:period:2026-11', tenant_id: 'ten-m26', name: '2026-11',
      start_date: '2026-11-01', end_date: '2026-11-30', status: 'OPEN', closed_at: null, closed_by_user_id: null,
    }).execute();
    await db.insertInto('expense_categories').values({
      id: 'cat-rent', tenant_id: 'ten-m26', code: 'MONTHLY_RENT', name: 'Rent', expense_type: 'MONTHLY_RECURRING', account_code: '6090',
    }).execute();
    await db.insertInto('recurring_expense_obligations').values({
      id: 'obl-rent', tenant_id: 'ten-m26', store_id: 'st-m26', category_id: 'cat-rent',
      name: 'Shop Rent', due_day_of_month: 1, currency: 'EGP', idempotency_key: 'obl-rent',
    }).execute();
    await db.insertInto('journal_entries').values([
      {
        id: 'je-accrual', tenant_id: 'ten-m26', store_id: 'st-m26', period_id: 'ten-m26:period:2026-11',
        entry_number: 'J-OLD-ACC', entry_date: '2026-11-01', source_type: 'EXPENSE',
        source_id: 'obl-rent:2026-11', idempotency_key: 'monthly-accrual:obl-rent:2026-11',
        status: 'POSTED', reversed_by_entry_id: null, created_at: '2026-11-01T12:00:00.000Z', created_by_user_id: 'usr-m26',
      },
      {
        id: 'je-pay-1', tenant_id: 'ten-m26', store_id: 'st-m26', period_id: 'ten-m26:period:2026-11',
        entry_number: 'J-OLD-PAY', entry_date: '2026-11-02', source_type: 'EXPENSE',
        source_id: 'oer-1', idempotency_key: 'monthly-payment:pay-1',
        status: 'POSTED', reversed_by_entry_id: null, created_at: '2026-11-02T12:00:00.000Z', created_by_user_id: 'usr-m26',
      },
    ]).execute();
    await db.insertInto('journal_lines').values([
      { id: 'jl-1', journal_entry_id: 'je-accrual', account_id: 'acc-6090', entry_type: 'DEBIT', amount: 400000n, currency: 'EGP', memo: 'Accrual DR' },
      { id: 'jl-2', journal_entry_id: 'je-accrual', account_id: 'acc-2020', entry_type: 'CREDIT', amount: 400000n, currency: 'EGP', memo: 'Accrual CR' },
      { id: 'jl-3', journal_entry_id: 'je-pay-1', account_id: 'acc-2020', entry_type: 'DEBIT', amount: 13300n, currency: 'EGP', memo: 'Pay DR' },
      { id: 'jl-4', journal_entry_id: 'je-pay-1', account_id: 'acc-1010', entry_type: 'CREDIT', amount: 13300n, currency: 'EGP', memo: 'Pay CR' },
    ]).execute();
    await db.insertInto('monthly_expense_actuals').values({
      id: 'act-rent', tenant_id: 'ten-m26', store_id: 'st-m26', obligation_id: 'obl-rent',
      period_id: 'ten-m26:period:2026-11', year: 2026, month: 11, days_in_month: 30,
      amount: 400000n, currency: 'EGP', status: 'PARTIALLY_PAID', paid_amount: 13300n,
      journal_entry_id: 'je-accrual', confirmed_by_user_id: 'usr-m26', confirmed_at: '2026-11-01T12:00:00.000Z',
    }).execute();

    // Run upgrade through 026
    const upgraded = await migrator.migrateToLatest();
    expect(upgraded.success).toBe(true);
    expect(upgraded.executedMigrations).toContain('026_accounting_cash_basis_and_supplier_invoice_index');

    // Different supplier MAY use the same invoice_number
    await db.insertInto('supplier_purchases').values({
      id: 'pur-b1', tenant_id: 'ten-m26', store_id: 'st-m26', supplier_id: 'sup-b',
      invoice_number: 'INV-888', purchased_at: '2026-11-05T10:00:00.000Z',
      total_amount: 10000n, initial_paid_amount: 0n, currency: 'EGP',
      notes: null, created_by_user_id: 'usr-m26', idempotency_key: 'pur-b1',
    }).execute();

    // Same supplier reusing INV-888 is still rejected
    await expect(
      db.insertInto('supplier_purchases').values({
        id: 'pur-a2', tenant_id: 'ten-m26', store_id: 'st-m26', supplier_id: 'sup-a',
        invoice_number: 'INV-888', purchased_at: '2026-11-06T10:00:00.000Z',
        total_amount: 5000n, initial_paid_amount: 0n, currency: 'EGP',
        notes: null, created_by_user_id: 'usr-m26', idempotency_key: 'pur-a2',
      }).execute(),
    ).rejects.toThrow();

    // General Ledger must show Account 6090 = 133.00 EGP (13300) and Account 2020 = 0
    const netRows = await sql<{ account_code: string; net: number | bigint }>`
      SELECT a.account_code, SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END) AS net
      FROM journal_lines jl
      INNER JOIN accounts a ON a.id = jl.account_id
      INNER JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.tenant_id = 'ten-m26'
      GROUP BY a.account_code;
    `.execute(db);
    const netMap = new Map(netRows.rows.map((r) => [r.account_code, BigInt(r.net)]));
    expect(netMap.get('6090')).toBe(13300n);
    expect(netMap.get('2020')).toBe(0n);
    expect(netMap.get('1010')).toBe(-13300n);
  });

  it('Migration 032: marks older duplicate OPEN shifts per store as UNVERIFIED_AUTO_CLOSED with exact expected_cash and enforces unique open shift per store', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    await migrator.migrateToLatest();
    const db = dbManager.getDb();

    // Simulate pre-032 state by dropping the unique index and inserting 2 overlapping OPEN shifts in the same store
    await sql`DROP INDEX IF EXISTS idx_cashier_shifts_one_open_per_store;`.execute(db);

    const tenantId = 'ten-m32';
    const storeId = 'st-m32';
    const cashier1Id = 'usr-m32-c1';
    const cashier2Id = 'usr-m32-c2';

    await db.insertInto('tenants').values({ id: tenantId, name: 'Shift Upgrade Co', code: 'SH32', currency: 'EGP' }).execute();
    await db.insertInto('stores').values({ id: storeId, tenant_id: tenantId, name: 'Main Branch', code: 'BR32' }).execute();
    await db.insertInto('users').values([
      { id: cashier1Id, tenant_id: tenantId, store_id: storeId, username: 'c1_m32', password_hash: 'h', full_name: 'Cashier 1', role: 'CASHIER', is_active: 1 },
      { id: cashier2Id, tenant_id: tenantId, store_id: storeId, username: 'c2_m32', password_hash: 'h', full_name: 'Cashier 2', role: 'CASHIER', is_active: 1 },
    ]).execute();
    await db.insertInto('accounts').values([
      { id: 'acc-32-1010', tenant_id: tenantId, account_code: '1010', account_name: 'Cash Drawer', account_type: 'ASSET', normal_balance: 'DEBIT' },
      { id: 'acc-32-6090', tenant_id: tenantId, account_code: '6090', account_name: 'Operating Expense', account_type: 'EXPENSE', normal_balance: 'DEBIT' },
    ]).execute();
    await db.insertInto('accounting_periods').values({
      id: 'ten-m32:period:2026-11',
      tenant_id: tenantId,
      name: '2026-11',
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      status: 'OPEN',
      closed_at: null,
      closed_by_user_id: null,
    }).execute();

    // Older shift: started at 08:00 with 1000.00 EGP (100000 piasters)
    // Newer shift: started at 16:00 with 1300.00 EGP (130000 piasters)
    // Schema defaults set expected_cash/actual_cash/variance/handover_cash to 0 while OPEN.
    await db.insertInto('cashier_shifts').values([
      {
        id: 'shift-old',
        shift_number: 'SH-001',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashier1Id,
        started_at: '2026-11-20T08:00:00.000Z',
        ended_at: null,
        opening_cash: 100000n,
        expected_cash: 0n,
        actual_cash: 0n,
        variance: 0n,
        handover_cash: 0n,
        status: 'OPEN',
        reconciliation_status: 'OPEN',
        notes: 'وردية صباحية',
      },
      {
        id: 'shift-new',
        shift_number: 'SH-002',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashier2Id,
        started_at: '2026-11-20T16:00:00.000Z',
        ended_at: null,
        opening_cash: 130000n,
        expected_cash: 0n,
        actual_cash: 0n,
        variance: 0n,
        handover_cash: 0n,
        status: 'OPEN',
        reconciliation_status: 'OPEN',
        notes: 'وردية مسائية',
      },
    ]).execute();

    // Activity during older shift [08:00, 16:00):
    // +500.00 EGP net cash sale (60000 paid - 10000 change = 50000)
    // -100.00 EGP cash customer return (10000)
    // -100.00 EGP cash drawer expense on account 1010 (10000)
    // Expected cash at 16:00 = 100000 + 50000 - 10000 - 10000 = 130000 piasters
    await db.insertInto('sales').values({
      id: 'sale-32-1',
      tenant_id: tenantId,
      store_id: storeId,
      sale_number: 'INV-32-1',
      idempotency_key: 'idem-sale-32-1',
      customer_name: null,
      currency: 'EGP',
      subtotal: 50000n,
      discount_total: 0n,
      total: 50000n,
      paid_total: 60000n,
      change_given: 10000n,
      cashier_user_id: cashier1Id,
      status: 'COMPLETED',
      created_at: '2026-11-20T10:00:00.000Z',
    }).execute();
    await db.insertInto('sale_payments').values({
      id: 'sp-32-1',
      sale_id: 'sale-32-1',
      tenant_id: tenantId,
      tender_index: 0,
      method: 'CASH',
      amount: 60000n,
      created_at: '2026-11-20T10:00:00.000Z',
    }).execute();

    await db.insertInto('journal_entries').values([
      {
        id: 'je-32-ret',
        tenant_id: tenantId,
        store_id: storeId,
        period_id: 'ten-m32:period:2026-11',
        entry_number: 'J-32-1',
        entry_date: '2026-11-20',
        source_type: 'RETURN',
        source_id: 'ret-32-1',
        idempotency_key: 'idem-je-32-ret',
        status: 'POSTED',
        reversed_by_entry_id: null,
        created_at: '2026-11-20T11:00:00.000Z',
        created_by_user_id: cashier1Id,
      },
      {
        id: 'je-32-exp',
        tenant_id: tenantId,
        store_id: storeId,
        period_id: 'ten-m32:period:2026-11',
        entry_number: 'J-32-2',
        entry_date: '2026-11-20',
        source_type: 'EXPENSE',
        source_id: 'exp-32-1',
        idempotency_key: 'idem-je-32-exp',
        status: 'POSTED',
        reversed_by_entry_id: null,
        created_at: '2026-11-20T12:00:00.000Z',
        created_by_user_id: cashier1Id,
      },
    ]).execute();
    await db.insertInto('journal_lines').values([
      { id: 'jl-32-1', journal_entry_id: 'je-32-exp', account_id: 'acc-32-6090', entry_type: 'DEBIT', amount: 10000n, currency: 'EGP', memo: 'Exp' },
      { id: 'jl-32-2', journal_entry_id: 'je-32-exp', account_id: 'acc-32-1010', entry_type: 'CREDIT', amount: 10000n, currency: 'EGP', memo: 'Drawer out' },
    ]).execute();
    await db.insertInto('customer_returns').values({
      id: 'ret-32-1',
      tenant_id: tenantId,
      store_id: storeId,
      original_sale_id: 'sale-32-1',
      return_number: 'RET-32-1',
      idempotency_key: 'idem-ret-32-1',
      refund_amount: 10000n,
      currency: 'EGP',
      payment_method: 'CASH',
      journal_entry_id: 'je-32-ret',
      created_by_user_id: cashier1Id,
      created_at: '2026-11-20T11:00:00.000Z',
    }).execute();

    // Run Migration 032
    await singleOpenShiftPerStoreMigration(db);

    const oldShift = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-old').executeTakeFirstOrThrow();
    const newShift = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-new').executeTakeFirstOrThrow();

    expect(oldShift.status).toBe('CLOSED');
    expect(oldShift.ended_at).toBe('2026-11-20T16:00:00.000Z');
    expect(oldShift.reconciliation_status).toBe('UNVERIFIED_AUTO_CLOSED');
    expect(BigInt(oldShift.expected_cash ?? -1)).toBe(130000n);
    expect(BigInt(oldShift.actual_cash ?? -1)).toBe(0n);
    expect(BigInt(oldShift.variance ?? -1)).toBe(0n);
    expect(BigInt(oldShift.handover_cash ?? -1)).toBe(0n);
    expect(oldShift.notes).toContain('غير متحقق نقديًا');

    expect(newShift.status).toBe('OPEN');
    expect(newShift.reconciliation_status).toBe('OPEN');
    expect(newShift.ended_at).toBeNull();

    // Unique index now rejects any second OPEN shift in the same store
    await expect(
      db.insertInto('cashier_shifts').values({
        id: 'shift-dup',
        shift_number: 'SH-003',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashier1Id,
        started_at: '2026-11-20T18:00:00.000Z',
        opening_cash: 50000n,
        status: 'OPEN',
      }).execute(),
    ).rejects.toThrow();
  });

  it('Migration 033: retroactively flags auto-closed shifts from both b787b5a and e9ce924 as UNVERIFIED_AUTO_CLOSED while preserving verified shifts', async () => {
    const migrator = new DatabaseMigrator(dbManager.getDb());
    await migrator.migrateToLatest('032_single_open_shift_per_store');
    const db = dbManager.getDb();

    const tenantId = 'ten-m33';
    const storeId = 'st-m33';
    const cashierId = 'usr-m33-c1';
    const ownerId = 'usr-m33-own';

    await db.insertInto('tenants').values({ id: tenantId, name: 'Legacy 032 Co', code: 'SH33', currency: 'EGP' }).execute();
    await db.insertInto('stores').values({ id: storeId, tenant_id: tenantId, name: 'Main Branch', code: 'BR33' }).execute();
    await db.insertInto('users').values([
      { id: cashierId, tenant_id: tenantId, store_id: storeId, username: 'c1_m33', password_hash: 'h', full_name: 'Cashier', role: 'CASHIER', is_active: 1 },
      { id: ownerId, tenant_id: tenantId, store_id: null, username: 'own_m33', password_hash: 'h', full_name: 'Owner', role: 'OWNER', is_active: 1 },
    ]).execute();

    // Seed:
    // 1. e9ce924-style auto-closed shift (has note 'تسوية وإغلاق تلقائي عند الترقية' and fabricated actual_cash = 130000)
    // 2. b787b5a-style auto-closed shift (expected_cash = 0, actual_cash = 0, handover_cash = 0, no note, no SHIFT_CLOSED audit log) + a cash sale of 50000 during its window
    // 3. Verified manually closed shift (with SHIFT_CLOSED audit log)
    // 4. Current active OPEN shift
    await db.insertInto('cashier_shifts').values([
      {
        id: 'shift-e9ce',
        shift_number: 'SH-101',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashierId,
        started_at: '2026-11-18T08:00:00.000Z',
        ended_at: '2026-11-18T16:00:00.000Z',
        opening_cash: 100000n,
        expected_cash: 130000n,
        actual_cash: 130000n,
        variance: 0n,
        handover_cash: 130000n,
        status: 'CLOSED',
        notes: 'وردية صباحية — تسوية وإغلاق تلقائي عند الترقية (032) لمنع تعدد الشيفتات المفتوحة بالفرع',
      },
      {
        id: 'shift-b787',
        shift_number: 'SH-102',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashierId,
        started_at: '2026-11-19T08:00:00.000Z',
        ended_at: '2026-11-19T16:00:00.000Z',
        opening_cash: 100000n,
        expected_cash: 0n,
        actual_cash: 0n,
        variance: 0n,
        handover_cash: 0n,
        status: 'CLOSED',
        notes: 'وردية قديمة بفرع',
      },
      {
        id: 'shift-verified',
        shift_number: 'SH-103',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: cashierId,
        started_at: '2026-11-20T08:00:00.000Z',
        ended_at: '2026-11-20T16:00:00.000Z',
        opening_cash: 100000n,
        expected_cash: 120000n,
        actual_cash: 120000n,
        variance: 0n,
        handover_cash: 120000n,
        status: 'CLOSED',
        notes: 'تقفيل يدوي',
      },
      {
        id: 'shift-open-m33',
        shift_number: 'SH-104',
        tenant_id: tenantId,
        store_id: storeId,
        user_id: ownerId,
        started_at: '2026-11-21T08:00:00.000Z',
        ended_at: null,
        opening_cash: 50000n,
        expected_cash: 0n,
        actual_cash: 0n,
        variance: 0n,
        handover_cash: 0n,
        status: 'OPEN',
        notes: 'وردية حالية',
      },
    ]).execute();

    // Cash sale during shift-b787 window (+50000 -> expected = 100000 + 50000 = 150000)
    await db.insertInto('sales').values({
      id: 'sale-m33-b787',
      tenant_id: tenantId,
      store_id: storeId,
      sale_number: 'INV-33-1',
      idempotency_key: 'idem-sale-m33-1',
      customer_name: null,
      currency: 'EGP',
      subtotal: 50000n,
      discount_total: 0n,
      total: 50000n,
      paid_total: 50000n,
      change_given: 0n,
      cashier_user_id: cashierId,
      status: 'COMPLETED',
      created_at: '2026-11-19T12:00:00.000Z',
    }).execute();
    await db.insertInto('sale_payments').values({
      id: 'sp-m33-1',
      sale_id: 'sale-m33-b787',
      tenant_id: tenantId,
      tender_index: 0,
      method: 'CASH',
      amount: 50000n,
      created_at: '2026-11-19T12:00:00.000Z',
    }).execute();

    // SHIFT_CLOSED audit log for shift-verified
    const auditRepo = new SqliteAuditLogRepository(db);
    await auditRepo.record(
      new ScopedExecutionContext({
        tenantId,
        storeId,
        userId: cashierId,
        roleId: 'CASHIER',
        permissions: new Set([Permissions.POS_CHECKOUT]),
        correlationId: 'corr-m33',
      }),
      {
        storeId,
        actorUserId: cashierId,
        actorUsername: 'c1_m33',
        actorRole: 'CASHIER',
        action: 'SHIFT_CLOSED',
        entityType: 'SHIFT',
        entityId: 'shift-verified',
        summary: 'تقفيل يدوي',
      },
    );

    // Run Migration 033
    await shiftReconciliationStatusMigration(db);

    const e9ce = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-e9ce').executeTakeFirstOrThrow();
    const b787 = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-b787').executeTakeFirstOrThrow();
    const verified = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-verified').executeTakeFirstOrThrow();
    const openRow = await db.selectFrom('cashier_shifts').selectAll().where('id', '=', 'shift-open-m33').executeTakeFirstOrThrow();

    expect(e9ce.reconciliation_status).toBe('UNVERIFIED_AUTO_CLOSED');
    expect(BigInt(e9ce.expected_cash)).toBe(130000n);
    expect(BigInt(e9ce.actual_cash)).toBe(0n);
    expect(BigInt(e9ce.variance)).toBe(0n);
    expect(BigInt(e9ce.handover_cash)).toBe(0n);

    expect(b787.reconciliation_status).toBe('UNVERIFIED_AUTO_CLOSED');
    expect(BigInt(b787.expected_cash)).toBe(150000n);
    expect(BigInt(b787.actual_cash)).toBe(0n);
    expect(BigInt(b787.variance)).toBe(0n);
    expect(BigInt(b787.handover_cash)).toBe(0n);
    expect(b787.notes).toContain('غير متحقق نقديًا');

    expect(verified.reconciliation_status).toBe('VERIFIED');
    expect(BigInt(verified.actual_cash)).toBe(120000n);

    expect(openRow.reconciliation_status).toBe('OPEN');
  });

  it('tracks pending migrations, ensures 034_clock_reset_recovery idempotency, and blocks downgrades with DatabaseDowngradeError', async () => {
    const db = dbManager.getDb();
    const migrator = new DatabaseMigrator(db);

    // Before first run, all registered migrations including 034 and 035 are pending
    const pendingBefore = await migrator.getPendingMigrationNames();
    expect(pendingBefore.length).toBe(REGISTERED_MIGRATION_NAMES.length);
    expect(pendingBefore).toContain('034_clock_reset_recovery');
    expect(pendingBefore).toContain('035_supplier_opening_debt');

    const first = await migrator.migrateToLatest();
    expect(first.success).toBe(true);
    expect(await migrator.getPendingMigrationNames()).toEqual([]);

    // Re-running migrateToLatest is idempotent
    const second = await migrator.migrateToLatest();
    expect(second.success).toBe(true);
    expect(second.executedMigrations).toEqual([]);

    // Verify 034 and 035 schema additions
    const licensingCols = (dbManager.getRawDatabase().pragma('table_info(system_licensing)') as { name: string }[]).map((c) => c.name);
    expect(licensingCols).toContain('ignored_sales_rowid');
    expect(licensingCols).toContain('ignored_shifts_rowid');
    expect(licensingCols).toContain('ignored_audit_rowid');
    const purchaseCols = (dbManager.getRawDatabase().pragma('table_info(supplier_purchases)') as { name: string }[]).map((c) => c.name);
    expect(purchaseCols).toContain('entry_kind');
    const resetTable = dbManager
      .getRawDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'used_clock_reset_tokens'")
      .get() as { name?: string } | undefined;
    expect(resetTable?.name).toBe('used_clock_reset_tokens');

    // Simulate opening a database migrated by a newer version of RetailOS
    await sql`
      INSERT INTO kysely_migration (name, timestamp)
      VALUES ('999_future_schema', '2099-01-01T00:00:00.000Z')
    `.execute(db);

    await expect(migrator.assertNoDowngrade()).rejects.toBeInstanceOf(DatabaseDowngradeError);
    await expect(migrator.migrateToLatest()).rejects.toMatchObject({
      name: 'DatabaseDowngradeError',
      code: 'DATABASE_DOWNGRADE_UNSUPPORTED',
      unknownMigrations: ['999_future_schema'],
    });
  });
});
