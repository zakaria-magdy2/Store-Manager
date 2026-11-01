import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';

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
});
