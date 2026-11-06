import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Adds deterministic line/tender ordering required by the checkout repository. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('sale_items')
    .addColumn('line_number', 'integer', (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('sale_payments')
    .addColumn('tender_index', 'integer', (column) => column.notNull().defaultTo(0))
    .execute();

  // Preserve existing row order if this upgrade is applied after any manual or
  // pre-release checkout data has been written. Temporarily remove only these
  // two update guards while the migration backfills the new ordering columns.
  await sql`DROP TRIGGER IF EXISTS trg_sale_items_no_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_sale_payments_no_update;`.execute(db);
  await sql`
    UPDATE sale_items AS current
    SET line_number = (
      SELECT COUNT(*) - 1 FROM sale_items AS earlier
      WHERE earlier.sale_id = current.sale_id AND earlier.rowid <= current.rowid
    );
  `.execute(db);
  await sql`
    UPDATE sale_payments AS current
    SET tender_index = (
      SELECT COUNT(*) - 1 FROM sale_payments AS earlier
      WHERE earlier.sale_id = current.sale_id AND earlier.rowid <= current.rowid
    );
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_sale_items_no_update
    BEFORE UPDATE ON sale_items
    BEGIN
      SELECT RAISE(ABORT, 'sale_items is append-only: corrections must be compensating entries');
    END;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_sale_payments_no_update
    BEFORE UPDATE ON sale_payments
    BEGIN
      SELECT RAISE(ABORT, 'sale_payments is append-only: corrections must be compensating entries');
    END;
  `.execute(db);

  await db.schema
    .createIndex('idx_sale_items_sale_line')
    .on('sale_items')
    .columns(['sale_id', 'line_number'])
    .unique()
    .execute();
  await db.schema
    .createIndex('idx_sale_payments_sale_tender')
    .on('sale_payments')
    .columns(['sale_id', 'tender_index'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_sale_payments_sale_tender').execute();
  await db.schema.dropIndex('idx_sale_items_sale_line').execute();
  await db.schema.alterTable('sale_payments').dropColumn('tender_index').execute();
  await db.schema.alterTable('sale_items').dropColumn('line_number').execute();
}
