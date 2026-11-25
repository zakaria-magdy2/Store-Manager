import type { Kysely } from 'kysely';
import { sql } from 'kysely';

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db);
  return result.rows.some((row) => row.name === columnName);
}

/**
 * Migration 034:
 * Add watermark ledger rowid cutoffs on `system_licensing` and create
 * `used_clock_reset_tokens` so vendor-issued one-time `ROSCLK1` tokens can
 * safely recover a store after accidental forward clock jumps without allowing replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, 'system_licensing', 'ignored_sales_rowid'))) {
    await sql`
      ALTER TABLE system_licensing
      ADD COLUMN ignored_sales_rowid INTEGER NOT NULL DEFAULT 0;
    `.execute(db);
  }
  if (!(await hasColumn(db, 'system_licensing', 'ignored_shifts_rowid'))) {
    await sql`
      ALTER TABLE system_licensing
      ADD COLUMN ignored_shifts_rowid INTEGER NOT NULL DEFAULT 0;
    `.execute(db);
  }
  if (!(await hasColumn(db, 'system_licensing', 'ignored_audit_rowid'))) {
    await sql`
      ALTER TABLE system_licensing
      ADD COLUMN ignored_audit_rowid INTEGER NOT NULL DEFAULT 0;
    `.execute(db);
  }

  await db.schema
    .createTable('used_clock_reset_tokens')
    .ifNotExists()
    .addColumn('reset_id', 'text', (col) => col.primaryKey())
    .addColumn('machine_id', 'text', (col) => col.notNull())
    .addColumn('issued_at', 'text', (col) => col.notNull())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .addColumn('previous_watermark_ms', 'integer', (col) => col.notNull())
    .addColumn('new_watermark_ms', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('used_clock_reset_tokens').ifExists().execute();
}
