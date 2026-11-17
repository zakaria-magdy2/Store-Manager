import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 027:
 * Append-only table for cash/safe/bank refunds collected back from suppliers
 * when supplier returns create an excess credit owed to the store.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE supplier_refunds (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      store_id TEXT NOT NULL REFERENCES stores(id),
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      idempotency_key TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'CASH_SAFE', 'BANK_TRANSFER')),
      reference_number TEXT,
      notes TEXT,
      journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
      refunded_at TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tenant_id, idempotency_key)
    );
  `.execute(db);

  await sql`CREATE INDEX idx_supplier_refunds_supplier ON supplier_refunds(tenant_id, store_id, supplier_id, refunded_at DESC);`.execute(db);

  await sql`CREATE TRIGGER trg_supplier_refunds_no_update BEFORE UPDATE ON supplier_refunds BEGIN SELECT RAISE(ABORT, 'Supplier financial history is append-only'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_refunds_no_delete BEFORE DELETE ON supplier_refunds BEGIN SELECT RAISE(ABORT, 'Supplier financial history is append-only'); END;`.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_refund_tenant_guard BEFORE INSERT ON supplier_refunds
    WHEN NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM suppliers v WHERE v.id = NEW.supplier_id AND v.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id = NEW.store_id))
    BEGIN
      SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid supplier refund scope');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_supplier_refund_tenant_guard;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_refunds_no_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_refunds_no_update;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_refunds_supplier;`.execute(db);
  await sql`DROP TABLE IF EXISTS supplier_refunds;`.execute(db);
}
