import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE operating_expense_records ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';`.execute(db);
  await sql`UPDATE operating_expense_records SET idempotency_key = 'legacy-expense:' || id WHERE idempotency_key = '';`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_expenses_tenant_idempotency ON operating_expense_records(tenant_id, idempotency_key);`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_expenses_tenant_idempotency;`.execute(db);
  await db.schema.alterTable('operating_expense_records').dropColumn('idempotency_key').execute();
}
