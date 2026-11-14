import { sql, type Kysely } from 'kysely';

/** Adds optional target profit percentage and per-line retail selling price to supplier purchases. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('supplier_purchases').addColumn('target_profit_percent', 'real').execute();
  await db.schema.alterTable('supplier_purchases').addColumn('expected_retail_total', 'integer').execute();
  await sql`ALTER TABLE supplier_purchase_items ADD COLUMN retail_price INTEGER CHECK (retail_price IS NULL OR retail_price >= 0);`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('supplier_purchase_items').dropColumn('retail_price').execute();
  await db.schema.alterTable('supplier_purchases').dropColumn('expected_retail_total').execute();
  await db.schema.alterTable('supplier_purchases').dropColumn('target_profit_percent').execute();
}
