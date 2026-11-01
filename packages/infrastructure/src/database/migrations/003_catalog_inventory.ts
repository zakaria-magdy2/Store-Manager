import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Tenant-level negative stock override (ADR-009: strict prohibition by default).
  await db.schema
    .alterTable('tenants')
    .addColumn('allow_negative_stock', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  // 14. Product Categories (nested)
  await db.schema
    .createTable('categories')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('parent_id', 'text', (col) => col.references('categories.id').onDelete('set null'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('code', 'text', (col) => col.notNull())
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_categories_tenant_code')
    .on('categories')
    .columns(['tenant_id', 'code'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_categories_tenant_parent')
    .on('categories')
    .columns(['tenant_id', 'parent_id'])
    .execute();

  // 15. Products
  await db.schema
    .createTable('products')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('barcode', 'text')
    .addColumn('category_id', 'text', (col) =>
      col.references('categories.id').onDelete('set null'),
    )
    .addColumn('has_variants', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_products_tenant_sku')
    .on('products')
    .columns(['tenant_id', 'sku'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_products_tenant_barcode')
    .on('products')
    .columns(['tenant_id', 'barcode'])
    .execute();

  await db.schema
    .createIndex('idx_products_tenant_category')
    .on('products')
    .columns(['tenant_id', 'category_id'])
    .execute();

  // 16. Product Variants (sellable units + dynamic JSON attributes)
  await db.schema
    .createTable('product_variants')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('product_id', 'text', (col) =>
      col.notNull().references('products.id').onDelete('restrict'),
    )
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('barcode', 'text')
    .addColumn('attributes_json', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('retail_price', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('reorder_point', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_variants_tenant_sku')
    .on('product_variants')
    .columns(['tenant_id', 'sku'])
    .unique()
    .execute();

  // SQLite unique indexes allow multiple NULL barcodes while enforcing
  // uniqueness for every real barcode.
  await db.schema
    .createIndex('idx_variants_tenant_barcode')
    .on('product_variants')
    .columns(['tenant_id', 'barcode'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_variants_tenant_product')
    .on('product_variants')
    .columns(['tenant_id', 'product_id'])
    .execute();

  // 17. Inventory Items (partitioned per store + variant, ADR-005)
  await db.schema
    .createTable('inventory_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) =>
      col.notNull().references('stores.id').onDelete('restrict'),
    )
    .addColumn('variant_id', 'text', (col) =>
      col.notNull().references('product_variants.id').onDelete('restrict'),
    )
    .addColumn('quantity_on_hand', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('wac_cost', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_inventory_store_variant')
    .on('inventory_items')
    .columns(['tenant_id', 'store_id', 'variant_id'])
    .unique()
    .execute();

  // 18. Stock Movements (immutable append-only ledger)
  await db.schema
    .createTable('stock_movements')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) =>
      col.notNull().references('stores.id').onDelete('restrict'),
    )
    .addColumn('variant_id', 'text', (col) =>
      col.notNull().references('product_variants.id').onDelete('restrict'),
    )
    .addColumn('movement_type', 'text', (col) => col.notNull())
    .addColumn('quantity_delta', 'integer', (col) => col.notNull())
    .addColumn('unit_cost', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('resulting_quantity', 'integer', (col) => col.notNull())
    .addColumn('resulting_wac', 'integer', (col) => col.notNull())
    .addColumn('source_type', 'text', (col) => col.notNull())
    .addColumn('source_id', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_movements_tenant_store_variant')
    .on('stock_movements')
    .columns(['tenant_id', 'store_id', 'variant_id', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_movements_tenant_source')
    .on('stock_movements')
    .columns(['tenant_id', 'source_type', 'source_id'])
    .execute();

  // Enforce append-only semantics at the database level, not only in code.
  await sql`
    CREATE TRIGGER trg_stock_movements_no_update
    BEFORE UPDATE ON stock_movements
    BEGIN
      SELECT RAISE(ABORT, 'stock_movements is append-only: corrections must be compensating entries');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_stock_movements_no_delete
    BEFORE DELETE ON stock_movements
    BEGIN
      SELECT RAISE(ABORT, 'stock_movements is append-only: corrections must be compensating entries');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_stock_movements_no_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stock_movements_no_update;`.execute(db);
  await db.schema.dropTable('stock_movements').execute();
  await db.schema.dropTable('inventory_items').execute();
  await db.schema.dropTable('product_variants').execute();
  await db.schema.dropTable('products').execute();
  await db.schema.dropTable('categories').execute();
  await db.schema.alterTable('tenants').dropColumn('allow_negative_stock').execute();
}
