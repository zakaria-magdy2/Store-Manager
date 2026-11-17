import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 025:
 * Distinguish cross-shift variant exchange returns (`is_exchange = 1`) from
 * standalone customer refund returns so cross-shift exchanges do not mutate
 * closed historical shift reports while standalone returns still update their
 * originating invoice/shift metrics.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE customer_returns ADD COLUMN is_exchange INTEGER NOT NULL DEFAULT 0;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('customer_returns').dropColumn('is_exchange').execute();
}
