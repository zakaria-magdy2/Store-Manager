import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Supplier directory, purchase invoices, and append-only supplier payment ledger. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE suppliers (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant_id, id)
  );`.execute(db);
  await sql`CREATE TABLE supplier_purchases (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    invoice_number TEXT,
    purchased_at TEXT NOT NULL,
    total_amount INTEGER NOT NULL CHECK (total_amount > 0),
    initial_paid_amount INTEGER NOT NULL DEFAULT 0 CHECK (initial_paid_amount >= 0 AND initial_paid_amount <= total_amount),
    currency TEXT NOT NULL,
    notes TEXT,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tenant_id, id)
  );`.execute(db);
  await sql`CREATE TABLE supplier_payments (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    purchase_id TEXT NOT NULL REFERENCES supplier_purchases(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE')),
    reference_number TEXT,
    paid_at TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`.execute(db);
  await sql`CREATE INDEX idx_suppliers_tenant_name ON suppliers(tenant_id, name);`.execute(db);
  await sql`CREATE INDEX idx_supplier_purchases_tenant_date ON supplier_purchases(tenant_id, purchased_at DESC);`.execute(db);
  await sql`CREATE INDEX idx_supplier_payments_purchase ON supplier_payments(tenant_id, purchase_id, paid_at);`.execute(db);
  for (const table of ['supplier_purchases', 'supplier_payments']) {
    await sql`CREATE TRIGGER ${sql.raw(`trg_${table}_no_update`)} BEFORE UPDATE ON ${sql.raw(table)} BEGIN SELECT RAISE(ABORT, 'Supplier financial history is append-only'); END;`.execute(db);
    await sql`CREATE TRIGGER ${sql.raw(`trg_${table}_no_delete`)} BEFORE DELETE ON ${sql.raw(table)} BEGIN SELECT RAISE(ABORT, 'Supplier financial history is append-only'); END;`.execute(db);
  }
  await sql`CREATE TRIGGER trg_supplier_purchase_tenant_guard BEFORE INSERT ON supplier_purchases
    WHEN NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM suppliers v WHERE v.id = NEW.supplier_id AND v.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id)
    BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid supplier purchase scope'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_payment_tenant_guard BEFORE INSERT ON supplier_payments
    WHEN NOT EXISTS (SELECT 1 FROM supplier_purchases p WHERE p.id = NEW.purchase_id AND p.supplier_id = NEW.supplier_id AND p.tenant_id = NEW.tenant_id AND p.currency = NEW.currency)
      OR NOT EXISTS (SELECT 1 FROM suppliers v WHERE v.id = NEW.supplier_id AND v.tenant_id = NEW.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id)
    BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid supplier payment scope'); END;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_supplier_payment_tenant_guard;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchase_tenant_guard;`.execute(db);
  await sql`DROP TABLE IF EXISTS supplier_payments;`.execute(db);
  await sql`DROP TABLE IF EXISTS supplier_purchases;`.execute(db);
  await sql`DROP TABLE IF EXISTS suppliers;`.execute(db);
}
