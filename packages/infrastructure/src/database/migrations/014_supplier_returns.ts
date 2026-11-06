import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('supplier_returns')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('store_id', 'text', (col) => col.notNull().references('stores.id').onDelete('restrict'))
    .addColumn('supplier_id', 'text', (col) => col.notNull().references('suppliers.id').onDelete('restrict'))
    .addColumn('purchase_id', 'text', (col) => col.notNull().references('supplier_purchases.id').onDelete('restrict'))
    .addColumn('return_number', 'text', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('credit_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('journal_entry_id', 'text', (col) => col.references('journal_entries.id').onDelete('restrict'))
    .addColumn('created_by_user_id', 'text', (col) => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();
  await db.schema.createTable('supplier_return_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('return_id', 'text', (col) => col.notNull().references('supplier_returns.id').onDelete('restrict'))
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('purchase_item_id', 'text', (col) => col.notNull().references('supplier_purchase_items.id').onDelete('restrict'))
    .addColumn('variant_id', 'text', (col) => col.notNull().references('product_variants.id').onDelete('restrict'))
    .addColumn('quantity', 'integer', (col) => col.notNull())
    .addColumn('credit_amount', 'integer', (col) => col.notNull())
    .addColumn('inventory_cost', 'integer', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_supplier_returns_idempotency').on('supplier_returns').columns(['tenant_id', 'idempotency_key']).unique().execute();
  await db.schema.createIndex('idx_supplier_returns_number').on('supplier_returns').columns(['tenant_id', 'return_number']).unique().execute();
  await db.schema.createIndex('idx_supplier_return_items_source').on('supplier_return_items').columns(['tenant_id', 'purchase_item_id']).execute();
  await db.schema.createIndex('idx_supplier_return_items_unique').on('supplier_return_items').columns(['return_id', 'purchase_item_id']).unique().execute();
  await sql`CREATE TRIGGER trg_supplier_returns_scope_insert BEFORE INSERT ON supplier_returns FOR EACH ROW WHEN (
    NEW.credit_amount < 0 OR NOT EXISTS (SELECT 1 FROM supplier_purchases p WHERE p.id = NEW.purchase_id AND p.tenant_id = NEW.tenant_id AND p.store_id = NEW.store_id AND p.supplier_id = NEW.supplier_id AND p.currency = NEW.currency)
    OR NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id AND j.store_id = NEW.store_id)
    OR (NEW.journal_entry_id IS NULL AND NEW.credit_amount <> 0)
    OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id = NEW.store_id))
  ) BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid supplier return'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_supplier_return_items_scope_insert BEFORE INSERT ON supplier_return_items FOR EACH ROW WHEN (
    NEW.quantity <= 0 OR NEW.credit_amount < 0 OR NEW.inventory_cost < 0
    OR NOT EXISTS (SELECT 1 FROM supplier_returns r JOIN supplier_purchase_items p ON p.id = NEW.purchase_item_id AND p.purchase_id = r.purchase_id AND p.tenant_id = r.tenant_id AND p.variant_id = NEW.variant_id WHERE r.id = NEW.return_id AND r.tenant_id = NEW.tenant_id)
  ) BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid supplier return item'); END;`.execute(db);
  for (const table of ['supplier_returns', 'supplier_return_items']) {
    for (const operation of ['UPDATE', 'DELETE'] as const) await sql`CREATE TRIGGER ${sql.raw(`trg_${table}_immutable_${operation.toLowerCase()}`)} BEFORE ${sql.raw(operation)} ON ${sql.raw(table)} BEGIN SELECT RAISE(ABORT, 'Supplier return history is append-only'); END;`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['supplier_returns', 'supplier_return_items']) for (const operation of ['update', 'delete'] as const) await sql`DROP TRIGGER IF EXISTS ${sql.raw(`trg_${table}_immutable_${operation}`)};`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_returns_scope_insert;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_return_items_scope_insert;`.execute(db);
  await db.schema.dropTable('supplier_return_items').execute();
  await db.schema.dropTable('supplier_returns').execute();
}
