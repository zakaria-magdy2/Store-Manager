import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 19. Sales (immutable checkout header)
  await db.schema
    .createTable('sales')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) =>
      col.notNull().references('stores.id').onDelete('restrict'),
    )
    .addColumn('sale_number', 'text', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('customer_name', 'text')
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('subtotal', 'integer', (col) => col.notNull())
    .addColumn('discount_total', 'integer', (col) => col.notNull())
    .addColumn('total', 'integer', (col) => col.notNull())
    .addColumn('paid_total', 'integer', (col) => col.notNull())
    .addColumn('change_given', 'integer', (col) => col.notNull())
    .addColumn('cashier_user_id', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('COMPLETED'))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_sales_tenant_number')
    .on('sales')
    .columns(['tenant_id', 'sale_number'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_sales_tenant_idempotency')
    .on('sales')
    .columns(['tenant_id', 'idempotency_key'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_sales_tenant_store_created')
    .on('sales')
    .columns(['tenant_id', 'store_id', 'created_at'])
    .execute();

  // 20. Sale items (immutable line snapshots with WAC cost at checkout)
  await db.schema
    .createTable('sale_items')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('sale_id', 'text', (col) =>
      col.notNull().references('sales.id').onDelete('restrict'),
    )
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) =>
      col.notNull().references('stores.id').onDelete('restrict'),
    )
    .addColumn('variant_id', 'text', (col) =>
      col.notNull().references('product_variants.id').onDelete('restrict'),
    )
    .addColumn('product_id', 'text', (col) =>
      col.notNull().references('products.id').onDelete('restrict'),
    )
    .addColumn('product_name', 'text', (col) => col.notNull())
    .addColumn('sku', 'text', (col) => col.notNull())
    .addColumn('item_type', 'text', (col) => col.notNull())
    .addColumn('quantity', 'integer', (col) => col.notNull())
    .addColumn('unit_price', 'integer', (col) => col.notNull())
    .addColumn('line_discount', 'integer', (col) => col.notNull())
    .addColumn('cart_discount_share', 'integer', (col) => col.notNull())
    .addColumn('net_revenue', 'integer', (col) => col.notNull())
    .addColumn('unit_cost_snapshot', 'integer', (col) => col.notNull())
    .addColumn('cost_of_goods_sold', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_sale_items_tenant_sale')
    .on('sale_items')
    .columns(['tenant_id', 'sale_id'])
    .execute();

  await db.schema
    .createIndex('idx_sale_items_tenant_variant_created')
    .on('sale_items')
    .columns(['tenant_id', 'variant_id', 'created_at'])
    .execute();

  // 21. Sale payments (immutable tenders; refund amounts are negative)
  await db.schema
    .createTable('sale_payments')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('sale_id', 'text', (col) =>
      col.notNull().references('sales.id').onDelete('restrict'),
    )
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('method', 'text', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_sale_payments_tenant_sale')
    .on('sale_payments')
    .columns(['tenant_id', 'sale_id'])
    .execute();

  // Financial sale records are append-only, exactly like the stock ledger.
  for (const table of ['sales', 'sale_items', 'sale_payments']) {
    await sql`
      CREATE TRIGGER ${sql.raw(`trg_${table}_no_update`)}
      BEFORE UPDATE ON ${sql.raw(table)}
      BEGIN
        SELECT RAISE(ABORT, '${sql.raw(table)} is append-only: corrections must be compensating entries');
      END;
    `.execute(db);
  }

  for (const table of ['sales', 'sale_items', 'sale_payments']) {
    await sql`
      CREATE TRIGGER ${sql.raw(`trg_${table}_no_delete`)}
      BEFORE DELETE ON ${sql.raw(table)}
      BEGIN
        SELECT RAISE(ABORT, '${sql.raw(table)} is append-only: corrections must be compensating entries');
      END;
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['sales', 'sale_items', 'sale_payments']) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(`trg_${table}_no_delete`)};`.execute(db);
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(`trg_${table}_no_update`)};`.execute(db);
  }

  await db.schema.dropTable('sale_payments').execute();
  await db.schema.dropTable('sale_items').execute();
  await db.schema.dropTable('sales').execute();
}
