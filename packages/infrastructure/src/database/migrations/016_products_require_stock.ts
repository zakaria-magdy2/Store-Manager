import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export async function up(db: Kysely<RetailOSDatabase>): Promise<void> {
  await db.updateTable('products').set({ item_kind: 'PRODUCT' }).where('item_kind', '=', 'SERVICE').execute();
}

export function down(_db: Kysely<RetailOSDatabase>): Promise<void> {
  return Promise.reject(new Error('The stock-only catalog migration cannot restore prior service classifications.'));
}
