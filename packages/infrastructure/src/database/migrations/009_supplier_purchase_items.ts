import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Immutable lines tie each vendor invoice to the stock and WAC it received. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE supplier_purchase_items (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    purchase_id TEXT NOT NULL REFERENCES supplier_purchases(id),
    variant_id TEXT NOT NULL REFERENCES product_variants(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0),
    currency TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id, purchase_id) REFERENCES supplier_purchases(tenant_id, id)
  );`.execute(db);
  await sql`CREATE INDEX idx_supplier_purchase_items_purchase ON supplier_purchase_items(tenant_id, purchase_id);`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_purchase_items_scope BEFORE INSERT ON supplier_purchase_items
    WHEN NOT EXISTS (SELECT 1 FROM supplier_purchases p WHERE p.id = NEW.purchase_id AND p.tenant_id = NEW.tenant_id AND p.store_id = NEW.store_id AND p.currency = NEW.currency)
      OR NOT EXISTS (SELECT 1 FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id AND p.item_kind = 'PRODUCT' AND v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id AND v.currency = NEW.currency)
    BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid purchase item scope'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_purchase_items_no_update BEFORE UPDATE ON supplier_purchase_items BEGIN SELECT RAISE(ABORT, 'Supplier purchase history is append-only'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_purchase_items_no_delete BEFORE DELETE ON supplier_purchase_items BEGIN SELECT RAISE(ABORT, 'Supplier purchase history is append-only'); END;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchase_items_no_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchase_items_no_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchase_items_scope;`.execute(db);
  await sql`DROP TABLE IF EXISTS supplier_purchase_items;`.execute(db);
}
