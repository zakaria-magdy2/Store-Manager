import type { Kysely } from 'kysely';
import { sql } from 'kysely';

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db);
  return result.rows.some((row) => row.name === columnName);
}

/**
 * Migration 035:
 * Distinguish invoice-less supplier opening debt entries (`OPENING_DEBT`) from
 * regular merchandise purchase invoices (`PURCHASE`) in `supplier_purchases`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, 'supplier_purchases', 'entry_kind'))) {
    await sql`
      ALTER TABLE supplier_purchases
      ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'PURCHASE'
      CHECK (entry_kind IN ('PURCHASE', 'OPENING_DEBT'));
    `.execute(db);
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // SQLite does not drop columns safely in place without table rebuilds; keep forward-only column.
}
