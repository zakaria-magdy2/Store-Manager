import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Stable request keys prevent a retry from duplicating a purchase or payment. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE supplier_purchases ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';`.execute(db);
  await sql`UPDATE supplier_purchases SET idempotency_key = 'legacy-purchase:' || id WHERE idempotency_key = '';`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_supplier_purchases_idempotency ON supplier_purchases(tenant_id, idempotency_key);`.execute(db);
  await sql`ALTER TABLE supplier_payments ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';`.execute(db);
  await sql`UPDATE supplier_payments SET idempotency_key = 'legacy-payment:' || id WHERE idempotency_key = '';`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_supplier_payments_idempotency ON supplier_payments(tenant_id, idempotency_key);`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_supplier_payments_idempotency;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_idempotency;`.execute(db);
  await db.schema.alterTable('supplier_payments').dropColumn('idempotency_key').execute();
  await db.schema.alterTable('supplier_purchases').dropColumn('idempotency_key').execute();
}
