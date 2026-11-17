import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 023:
 * 1. Add business IANA `timezone` column on `tenants` (defaults to 'Africa/Cairo')
 *    so accounting entry dates, periods, and daily reports align cleanly across midnights.
 * 2. Move runtime-created `cashier_shifts` and `auth_rate_limits` under formal migrations
 *    with tenant/store/user relationship triggers.
 * 3. Add `document_sequences` table and unique supplier invoice index for atomic transactional
 *    document numbering across concurrent requests.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE tenants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Cairo';
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id TEXT PRIMARY KEY,
      shift_number TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      opening_cash INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
      expected_cash INTEGER NOT NULL DEFAULT 0,
      actual_cash INTEGER NOT NULL DEFAULT 0,
      variance INTEGER NOT NULL DEFAULT 0,
      handover_cash INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_tenant_store ON cashier_shifts(tenant_id, store_id, started_at);
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_user_status ON cashier_shifts(tenant_id, user_id, status);
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_tenant_number ON cashier_shifts(tenant_id, shift_number);
  `.execute(db);

  await sql`
    CREATE TRIGGER IF NOT EXISTS trg_cashier_shifts_scope_insert
    BEFORE INSERT ON cashier_shifts
    FOR EACH ROW
    WHEN (
      NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.tenant_id = NEW.tenant_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid cashier_shifts store or user relationship');
    END;
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS document_sequences (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 1000,
      PRIMARY KEY (tenant_id, doc_type)
    );
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_purchases_supplier_invoice
    ON supplier_purchases(tenant_id, supplier_id, invoice_number)
    WHERE invoice_number IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_supplier_invoice;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_tenant_invoice;`.execute(db);
  await sql`DROP TABLE IF EXISTS document_sequences;`.execute(db);
  await sql`DROP TABLE IF EXISTS auth_rate_limits;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_cashier_shifts_scope_insert;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_tenant_number;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_user_status;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_tenant_store;`.execute(db);
  await sql`DROP TABLE IF EXISTS cashier_shifts;`.execute(db);
  await db.schema.alterTable('tenants').dropColumn('timezone').execute();
}
