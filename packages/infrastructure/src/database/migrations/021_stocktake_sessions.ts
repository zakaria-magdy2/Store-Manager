import { sql, type Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export async function up(db: Kysely<RetailOSDatabase>): Promise<void> {
  await db.schema
    .createTable('stocktake_sessions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('store_id', 'text', (col) => col.notNull().references('stores.id').onDelete('restrict'))
    .addColumn('session_number', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('scope', 'text', (col) => col.notNull())
    .addColumn('category_id', 'text', (col) => col.references('categories.id').onDelete('set null'))
    .addColumn('blind_mode', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('include_zero_stock', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('DRAFT'))
    .addColumn('idempotency_key', 'text')
    .addColumn('uncounted_strategy', 'text')
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('notes', 'text')
    .addColumn('total_lines', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('counted_lines', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_variance_qty', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_surplus_cost', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_shortage_cost', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('net_variance_cost', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('net_variance_retail', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('journal_entry_id', 'text', (col) => col.references('journal_entries.id').onDelete('restrict'))
    .addColumn('created_by_user_id', 'text', (col) => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('committed_by_user_id', 'text', (col) => col.references('users.id').onDelete('restrict'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addColumn('committed_at', 'text')
    .addColumn('cancelled_at', 'text')
    .execute();

  await db.schema
    .createTable('stocktake_lines')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('session_id', 'text', (col) => col.notNull().references('stocktake_sessions.id').onDelete('cascade'))
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id').onDelete('restrict'))
    .addColumn('store_id', 'text', (col) => col.notNull().references('stores.id').onDelete('restrict'))
    .addColumn('variant_id', 'text', (col) => col.notNull().references('product_variants.id').onDelete('restrict'))
    .addColumn('product_id', 'text', (col) => col.notNull().references('products.id').onDelete('restrict'))
    .addColumn('product_name', 'text', (col) => col.notNull())
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('barcode', 'text')
    .addColumn('category_id', 'text')
    .addColumn('category_name', 'text')
    .addColumn('expected_quantity', 'integer', (col) => col.notNull())
    .addColumn('counted_quantity', 'integer')
    .addColumn('unit_wac', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('retail_price', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('override_unit_cost', 'integer')
    .addColumn('scanned_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('reason', 'text')
    .addColumn('committed_expected_quantity', 'integer')
    .addColumn('committed_variance_qty', 'integer')
    .addColumn('committed_variance_cost', 'integer')
    .addColumn('committed_unit_cost', 'integer')
    .addColumn('last_counted_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_stocktake_sessions_number')
    .on('stocktake_sessions')
    .columns(['tenant_id', 'session_number'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_stocktake_sessions_store_status')
    .on('stocktake_sessions')
    .columns(['tenant_id', 'store_id', 'status', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_stocktake_sessions_idempotency')
    .on('stocktake_sessions')
    .columns(['tenant_id', 'idempotency_key'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_stocktake_lines_unique_variant')
    .on('stocktake_lines')
    .columns(['session_id', 'variant_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_stocktake_lines_session')
    .on('stocktake_lines')
    .columns(['session_id', 'tenant_id', 'product_name'])
    .execute();

  await sql`
    CREATE TRIGGER trg_stocktake_sessions_scope_insert
    BEFORE INSERT ON stocktake_sessions
    FOR EACH ROW
    WHEN (
      NEW.status NOT IN ('DRAFT', 'COMMITTED', 'CANCELLED')
      OR NEW.scope NOT IN ('FULL', 'CATEGORY', 'PARTIAL')
      OR NOT EXISTS (SELECT 1 FROM stores st WHERE st.id = NEW.store_id AND st.tenant_id = NEW.tenant_id)
      OR (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id))
      OR (NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id AND j.store_id = NEW.store_id))
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id)
      OR (NEW.committed_by_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.committed_by_user_id AND u.tenant_id = NEW.tenant_id))
    )
    BEGIN
      SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid stocktake session relationship');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stocktake_lines_scope_insert
    BEFORE INSERT ON stocktake_lines
    FOR EACH ROW
    WHEN (
      NEW.expected_quantity < 0
      OR (NEW.counted_quantity IS NOT NULL AND NEW.counted_quantity < 0)
      OR NOT EXISTS (SELECT 1 FROM stocktake_sessions s WHERE s.id = NEW.session_id AND s.tenant_id = NEW.tenant_id AND s.store_id = NEW.store_id)
      OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id AND v.product_id = NEW.product_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'TenantIsolationViolation: invalid stocktake line relationship');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stocktake_sessions_immutable_update
    BEFORE UPDATE ON stocktake_sessions
    FOR EACH ROW
    WHEN (OLD.status IN ('COMMITTED', 'CANCELLED'))
    BEGIN
      SELECT RAISE(ABORT, 'stocktake_sessions is immutable once committed or cancelled');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stocktake_sessions_immutable_delete
    BEFORE DELETE ON stocktake_sessions
    FOR EACH ROW
    WHEN (OLD.status = 'COMMITTED')
    BEGIN
      SELECT RAISE(ABORT, 'committed stocktake_sessions cannot be deleted');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stocktake_lines_immutable_update
    BEFORE UPDATE ON stocktake_lines
    FOR EACH ROW
    WHEN (
      (NEW.counted_quantity IS NOT NULL AND NEW.counted_quantity < 0)
      OR EXISTS (SELECT 1 FROM stocktake_sessions s WHERE s.id = OLD.session_id AND s.status IN ('COMMITTED', 'CANCELLED'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'stocktake_lines cannot be modified after session finalization or set negative');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stocktake_lines_immutable_delete
    BEFORE DELETE ON stocktake_lines
    FOR EACH ROW
    WHEN (EXISTS (SELECT 1 FROM stocktake_sessions s WHERE s.id = OLD.session_id AND s.status IN ('COMMITTED', 'CANCELLED')))
    BEGIN
      SELECT RAISE(ABORT, 'stocktake_lines cannot be deleted after session finalization');
    END;
  `.execute(db);
}

export async function down(db: Kysely<RetailOSDatabase>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_lines_immutable_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_lines_immutable_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_sessions_immutable_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_sessions_immutable_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_lines_scope_insert;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stocktake_sessions_scope_insert;`.execute(db);
  await db.schema.dropTable('stocktake_lines').execute();
  await db.schema.dropTable('stocktake_sessions').execute();
}
