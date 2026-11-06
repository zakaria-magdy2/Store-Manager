import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE recurring_expense_obligations ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';`.execute(db);
  await sql`UPDATE recurring_expense_obligations SET idempotency_key = 'legacy-obligation:' || id WHERE idempotency_key = '';`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_recurring_obligations_idempotency ON recurring_expense_obligations(tenant_id, idempotency_key);`.execute(db);
  for (const table of ['monthly_expense_actuals', 'operating_expense_records']) {
    for (const operation of ['UPDATE', 'DELETE'] as const) {
      if (table === 'monthly_expense_actuals' && operation === 'UPDATE') continue;
      await sql`CREATE TRIGGER ${sql.raw(`trg_${table}_immutable_${operation.toLowerCase()}`)} BEFORE ${sql.raw(operation)} ON ${sql.raw(table)} BEGIN SELECT RAISE(ABORT, '${sql.raw(table)} is append-only'); END;`.execute(db);
    }
  }
  await sql`CREATE TRIGGER trg_monthly_actuals_locked_fields BEFORE UPDATE ON monthly_expense_actuals FOR EACH ROW WHEN (
    NEW.tenant_id <> OLD.tenant_id OR NEW.store_id IS NOT OLD.store_id OR NEW.obligation_id <> OLD.obligation_id
    OR NEW.period_id <> OLD.period_id OR NEW.year <> OLD.year OR NEW.month <> OLD.month
    OR NEW.days_in_month <> OLD.days_in_month OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
    OR NEW.journal_entry_id IS NOT OLD.journal_entry_id OR NEW.confirmed_by_user_id <> OLD.confirmed_by_user_id
    OR NEW.confirmed_at <> OLD.confirmed_at OR NEW.paid_amount < OLD.paid_amount OR NEW.paid_amount > NEW.amount
    OR NEW.status <> CASE WHEN NEW.paid_amount = 0 THEN 'DUE' WHEN NEW.paid_amount = NEW.amount THEN 'PAID' ELSE 'PARTIALLY_PAID' END
  ) BEGIN SELECT RAISE(ABORT, 'MonthlyExpenseInvariant: accrued amount is immutable and paid amount is monotonic'); END;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_monthly_actuals_locked_fields;`.execute(db);
  for (const table of ['monthly_expense_actuals', 'operating_expense_records']) {
    for (const operation of ['update', 'delete'] as const) {
      await sql`DROP TRIGGER IF EXISTS ${sql.raw(`trg_${table}_immutable_${operation}`)};`.execute(db);
    }
  }
  await sql`DROP INDEX IF EXISTS idx_recurring_obligations_idempotency;`.execute(db);
  await db.schema.alterTable('recurring_expense_obligations').dropColumn('idempotency_key').execute();
}
