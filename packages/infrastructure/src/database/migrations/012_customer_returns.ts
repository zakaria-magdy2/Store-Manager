import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('customer_returns')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('store_id', 'text', (col) => col.notNull().references('stores.id').onDelete('restrict'))
    .addColumn('original_sale_id', 'text', (col) => col.notNull().references('sales.id').onDelete('restrict'))
    .addColumn('return_number', 'text', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('refund_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('payment_method', 'text', (col) => col.notNull())
    .addColumn('journal_entry_id', 'text', (col) => col.notNull().references('journal_entries.id').onDelete('restrict'))
    .addColumn('created_by_user_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();
  await db.schema.createTable('customer_return_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('return_id', 'text', (col) => col.notNull().references('customer_returns.id').onDelete('restrict'))
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('original_sale_item_id', 'text', (col) => col.notNull().references('sale_items.id').onDelete('restrict'))
    .addColumn('variant_id', 'text', (col) => col.notNull().references('product_variants.id').onDelete('restrict'))
    .addColumn('quantity', 'integer', (col) => col.notNull())
    .addColumn('refund_amount', 'integer', (col) => col.notNull())
    .addColumn('cost_amount', 'integer', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_customer_returns_idempotency').on('customer_returns').columns(['tenant_id', 'idempotency_key']).unique().execute();
  await db.schema.createIndex('idx_customer_returns_number').on('customer_returns').columns(['tenant_id', 'return_number']).unique().execute();
  await db.schema.createIndex('idx_customer_return_items_original').on('customer_return_items').columns(['tenant_id', 'original_sale_item_id']).execute();
  await db.schema.createIndex('idx_customer_return_items_unique_line').on('customer_return_items').columns(['return_id', 'original_sale_item_id']).unique().execute();
  await sql`CREATE TRIGGER trg_customer_returns_scope_insert BEFORE INSERT ON customer_returns FOR EACH ROW WHEN (
    NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = NEW.original_sale_id AND s.tenant_id = NEW.tenant_id AND s.store_id = NEW.store_id AND s.currency = NEW.currency)
    OR NOT EXISTS (SELECT 1 FROM stores st WHERE st.id = NEW.store_id AND st.tenant_id = NEW.tenant_id)
    OR NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id AND j.store_id = NEW.store_id)
    OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id = NEW.store_id))
  ) BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid customer return relationship'); END;`.execute(db);
  await sql`CREATE TRIGGER trg_customer_return_items_scope_insert BEFORE INSERT ON customer_return_items FOR EACH ROW WHEN (
    NEW.quantity <= 0 OR NOT EXISTS (SELECT 1 FROM customer_returns r JOIN sale_items si ON si.id = NEW.original_sale_item_id AND si.sale_id = r.original_sale_id AND si.tenant_id = r.tenant_id AND si.variant_id = NEW.variant_id WHERE r.id = NEW.return_id AND r.tenant_id = NEW.tenant_id)
    OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id)
  ) BEGIN SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid customer return item relationship'); END;`.execute(db);
  for (const table of ['customer_returns', 'customer_return_items']) {
    for (const operation of ['UPDATE', 'DELETE'] as const) {
      await sql`CREATE TRIGGER ${sql.raw(`trg_${table}_immutable_${operation.toLowerCase()}`)} BEFORE ${sql.raw(operation)} ON ${sql.raw(table)} BEGIN SELECT RAISE(ABORT, 'customer returns are append-only'); END;`.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['customer_returns', 'customer_return_items']) {
    for (const operation of ['update', 'delete'] as const) await sql`DROP TRIGGER IF EXISTS ${sql.raw(`trg_${table}_immutable_${operation}`)};`.execute(db);
  }
  await sql`DROP TRIGGER IF EXISTS trg_customer_returns_scope_insert;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_customer_return_items_scope_insert;`.execute(db);
  await db.schema.dropTable('customer_return_items').execute();
  await db.schema.dropTable('customer_returns').execute();
}
