import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 024:
 * 1. Enforce at most one OPEN shift per (tenant_id, user_id) and add idempotency
 *    columns/indexes for race-safe shift start and close.
 * 2. Support audited one-time soft-voiding (`deleted_at`, `deleted_by_user_id`,
 *    `reversal_journal_entry_id`) on direct operating expenses while locking all
 *    other financial columns via an immutable update trigger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE cashier_shifts ADD COLUMN start_idempotency_key TEXT;`.execute(db);
  await sql`ALTER TABLE cashier_shifts ADD COLUMN close_idempotency_key TEXT;`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_one_open
    ON cashier_shifts(tenant_id, user_id)
    WHERE status = 'OPEN';
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_start_idemp
    ON cashier_shifts(tenant_id, start_idempotency_key)
    WHERE start_idempotency_key IS NOT NULL;
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_close_idemp
    ON cashier_shifts(tenant_id, close_idempotency_key)
    WHERE close_idempotency_key IS NOT NULL;
  `.execute(db);

  await sql`ALTER TABLE operating_expense_records ADD COLUMN deleted_at TEXT;`.execute(db);
  await sql`ALTER TABLE operating_expense_records ADD COLUMN deleted_by_user_id TEXT;`.execute(db);
  await sql`ALTER TABLE operating_expense_records ADD COLUMN reversal_journal_entry_id TEXT;`.execute(db);

  await sql`DROP TRIGGER IF EXISTS trg_operating_expense_records_immutable_update;`.execute(db);
  await sql`
    CREATE TRIGGER trg_operating_expense_records_locked_fields
    BEFORE UPDATE ON operating_expense_records
    FOR EACH ROW
    WHEN (
      NEW.id <> OLD.id
      OR NEW.tenant_id <> OLD.tenant_id
      OR NEW.store_id IS NOT OLD.store_id
      OR NEW.category_id <> OLD.category_id
      OR NEW.expense_type <> OLD.expense_type
      OR NEW.monthly_actual_id IS NOT OLD.monthly_actual_id
      OR NEW.expense_date <> OLD.expense_date
      OR NEW.amount <> OLD.amount
      OR NEW.currency <> OLD.currency
      OR NEW.payment_method <> OLD.payment_method
      OR NEW.source_account_code <> OLD.source_account_code
      OR NEW.notes IS NOT OLD.notes
      OR NEW.reference_number IS NOT OLD.reference_number
      OR NEW.attachment_path IS NOT OLD.attachment_path
      OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.created_by_user_id <> OLD.created_by_user_id
      OR NEW.idempotency_key <> OLD.idempotency_key
      OR OLD.deleted_at IS NOT NULL
      OR NEW.deleted_at IS NULL
      OR NEW.deleted_by_user_id IS NULL
      OR NEW.reversal_journal_entry_id IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'operating_expense_records is immutable: only one-time audited voiding is permitted');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_operating_expense_records_locked_fields;`.execute(db);
  await sql`
    CREATE TRIGGER trg_operating_expense_records_immutable_update
    BEFORE UPDATE ON operating_expense_records
    BEGIN
      SELECT RAISE(ABORT, 'operating_expense_records is append-only');
    END;
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_close_idemp;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_start_idemp;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_one_open;`.execute(db);
  await db.schema.alterTable('operating_expense_records').dropColumn('reversal_journal_entry_id').execute();
  await db.schema.alterTable('operating_expense_records').dropColumn('deleted_by_user_id').execute();
  await db.schema.alterTable('operating_expense_records').dropColumn('deleted_at').execute();
  await db.schema.alterTable('cashier_shifts').dropColumn('close_idempotency_key').execute();
  await db.schema.alterTable('cashier_shifts').dropColumn('start_idempotency_key').execute();
}
