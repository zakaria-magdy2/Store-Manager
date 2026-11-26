import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 036:
 * 1. Guarantees at the schema level that each supplier may have at most one
 *    `OPENING_DEBT` entry per store. Opening debts are a one-time setup per store
 *    and are edited in place afterwards.
 * 2. Relaxes `trg_supplier_purchases_locked_financials` ONLY for rows whose
 *    `entry_kind = 'OPENING_DEBT'` so authorized edits via `updateSupplierOpeningDebt`
 *    (which atomically posts balanced 3010 <-> 2010 delta journal entries) can update
 *    `total_amount` and `purchased_at`, while keeping regular `PURCHASE` invoices locked.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_opening_debt_unique
    ON supplier_purchases(tenant_id, store_id, supplier_id)
    WHERE entry_kind = 'OPENING_DEBT';
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchases_locked_financials;`.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_purchases_locked_financials
    BEFORE UPDATE ON supplier_purchases
    WHEN
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.store_id != OLD.store_id OR
      NEW.supplier_id != OLD.supplier_id OR
      NEW.idempotency_key != OLD.idempotency_key OR
      NEW.currency != OLD.currency OR
      NEW.created_by_user_id != OLD.created_by_user_id OR
      NEW.entry_kind != OLD.entry_kind OR
      (OLD.entry_kind != 'OPENING_DEBT' AND (
        NEW.purchased_at != OLD.purchased_at OR
        NEW.total_amount != OLD.total_amount
      ))
    BEGIN
      SELECT RAISE(ABORT, 'Core financial fields on supplier_purchases are append-only');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchases_locked_financials;`.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_purchases_locked_financials
    BEFORE UPDATE ON supplier_purchases
    WHEN
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.store_id != OLD.store_id OR
      NEW.supplier_id != OLD.supplier_id OR
      NEW.idempotency_key != OLD.idempotency_key OR
      NEW.purchased_at != OLD.purchased_at OR
      NEW.total_amount != OLD.total_amount OR
      NEW.currency != OLD.currency OR
      NEW.created_by_user_id != OLD.created_by_user_id
    BEGIN
      SELECT RAISE(ABORT, 'Core financial fields on supplier_purchases are append-only');
    END;
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_opening_debt_unique;`.execute(db);
}
