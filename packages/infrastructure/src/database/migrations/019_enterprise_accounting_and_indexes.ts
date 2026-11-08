import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Enforce append-only immutability on journal_lines (Rule 5)
  await sql`
    CREATE TRIGGER trg_journal_lines_immutable_update
    BEFORE UPDATE ON journal_lines
    BEGIN
      SELECT RAISE(ABORT, 'AccountingInvariant: journal_lines is append-only; corrections must be reversing entries');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_journal_lines_immutable_delete
    BEFORE DELETE ON journal_lines
    BEGIN
      SELECT RAISE(ABORT, 'AccountingInvariant: journal_lines is append-only; corrections must be reversing entries');
    END;
  `.execute(db);

  // 2. Enforce append-only immutability on journal_entries (only reversal link allowed)
  await sql`
    CREATE TRIGGER trg_journal_entries_immutable_update
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW
    WHEN (
      NEW.id <> OLD.id
      OR NEW.tenant_id <> OLD.tenant_id
      OR NEW.store_id IS NOT OLD.store_id
      OR NEW.period_id <> OLD.period_id
      OR NEW.entry_number <> OLD.entry_number
      OR NEW.entry_date <> OLD.entry_date
      OR NEW.source_type <> OLD.source_type
      OR NEW.source_id <> OLD.source_id
      OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.created_at <> OLD.created_at
      OR NEW.created_by_user_id <> OLD.created_by_user_id
      OR OLD.status = 'REVERSED'
    )
    BEGIN
      SELECT RAISE(ABORT, 'AccountingInvariant: journal_entries is append-only; corrections must be reversing entries');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_journal_entries_immutable_delete
    BEFORE DELETE ON journal_entries
    BEGIN
      SELECT RAISE(ABORT, 'AccountingInvariant: journal_entries is append-only; corrections must be reversing entries');
    END;
  `.execute(db);

  // 3. Enforce closed accounting period lock on journal_entries & accounting_periods
  await sql`
    CREATE TRIGGER trg_journal_entries_closed_period_guard
    BEFORE INSERT ON journal_entries
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM accounting_periods p
      WHERE p.id = NEW.period_id
        AND p.tenant_id = NEW.tenant_id
        AND p.status <> 'OPEN'
    )
    BEGIN
      SELECT RAISE(ABORT, 'AccountingPeriodClosed: cannot post journal entries to a closed accounting period');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_accounting_periods_closed_update
    BEFORE UPDATE ON accounting_periods
    FOR EACH ROW
    WHEN OLD.status = 'CLOSED'
    BEGIN
      SELECT RAISE(ABORT, 'AccountingPeriodClosed: closed accounting periods are immutable');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_accounting_periods_closed_delete
    BEFORE DELETE ON accounting_periods
    FOR EACH ROW
    WHEN OLD.status = 'CLOSED'
    BEGIN
      SELECT RAISE(ABORT, 'AccountingPeriodClosed: closed accounting periods are immutable');
    END;
  `.execute(db);

  // 4. Composite performance indexes for hot operational and reporting queries
  await sql`CREATE INDEX IF NOT EXISTS idx_sales_tenant_store_created ON sales(tenant_id, store_id, created_at);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_store_date ON journal_entries(tenant_id, store_id, entry_date);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_entry_id ON journal_lines(journal_entry_id);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id ON journal_lines(account_id);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_supplier_purchases_tenant_store_date ON supplier_purchases(tenant_id, store_id, purchased_at);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_operating_expenses_tenant_store_date ON operating_expense_records(tenant_id, store_id, expense_date);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_product_variants_tenant_product ON product_variants(tenant_id, product_id);`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_product_variants_tenant_product;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_operating_expenses_tenant_store_date;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_tenant_store_date;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_journal_lines_account_id;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_journal_lines_entry_id;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_journal_entries_tenant_store_date;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_sales_tenant_store_created;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_accounting_periods_closed_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_accounting_periods_closed_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_journal_entries_closed_period_guard;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_journal_entries_immutable_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_journal_entries_immutable_update;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_journal_lines_immutable_delete;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_journal_lines_immutable_update;`.execute(db);
}
