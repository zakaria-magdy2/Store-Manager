import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Lets the catalog sell stock-tracked goods and non-stock services. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE products ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'PRODUCT'
    CHECK (item_kind IN ('PRODUCT', 'SERVICE'));`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE products DROP COLUMN item_kind;`.execute(db);
}
