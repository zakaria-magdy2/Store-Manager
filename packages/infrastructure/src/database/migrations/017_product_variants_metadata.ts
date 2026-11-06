import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export async function up(db: Kysely<RetailOSDatabase>): Promise<void> {
  await db.schema.alterTable('products').addColumn('description', 'text').execute();
  await db.schema.alterTable('products').addColumn('brand', 'text').execute();
  await db.schema.alterTable('products').addColumn('image_path', 'text').execute();
  await db.schema.alterTable('products').addColumn('options_json', 'text', (column) => column.notNull().defaultTo('[]')).execute();
  await db.schema.alterTable('sale_items').addColumn('variant_attributes_json', 'text').execute();
}

export async function down(db: Kysely<RetailOSDatabase>): Promise<void> {
  await db.schema.alterTable('sale_items').dropColumn('variant_attributes_json').execute();
  await db.schema.alterTable('products').dropColumn('options_json').execute();
  await db.schema.alterTable('products').dropColumn('image_path').execute();
  await db.schema.alterTable('products').dropColumn('brand').execute();
  await db.schema.alterTable('products').dropColumn('description').execute();
}
