import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 030:
 * Relaxes full-row immutability triggers on `supplier_purchases`, `supplier_payments`,
 * and `operating_expense_records` to field-scoped guards so authorized owners/managers
 * can edit purchase metadata, edit/void supplier payments (append-only, never hard-deleted),
 * and edit direct daily expenses while every financial mutation is paired atomically with
 * balanced reversal & repost journal entries inside the repository transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchases_no_update;`.execute(db);
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

  await db.schema
    .alterTable('supplier_payments')
    .addColumn('deleted_at', 'text')
    .execute();

  await sql`DROP TRIGGER IF EXISTS trg_supplier_payments_no_update;`.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_payments_locked_identity
    BEFORE UPDATE ON supplier_payments
    WHEN
      OLD.deleted_at IS NOT NULL OR
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.supplier_id != OLD.supplier_id OR
      NEW.purchase_id != OLD.purchase_id OR
      NEW.currency != OLD.currency OR
      NEW.idempotency_key != OLD.idempotency_key OR
      NEW.created_by_user_id != OLD.created_by_user_id
    BEGIN
      SELECT RAISE(ABORT, 'Identity or voided fields on supplier_payments are append-only');
    END;
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS trg_operating_expense_records_locked_fields;`.execute(db);
  await sql`
    CREATE TRIGGER trg_operating_expense_records_locked_identity
    BEFORE UPDATE ON operating_expense_records
    WHEN
      OLD.deleted_at IS NOT NULL OR
      NEW.id != OLD.id OR
      NEW.tenant_id != OLD.tenant_id OR
      NEW.store_id IS NOT OLD.store_id OR
      NEW.expense_type != OLD.expense_type OR
      NEW.currency != OLD.currency OR
      NEW.idempotency_key != OLD.idempotency_key OR
      NEW.created_by_user_id != OLD.created_by_user_id
    BEGIN
      SELECT RAISE(ABORT, 'Deleted or identity fields on operating_expense_records are immutable');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_operating_expense_records_locked_identity;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_payments_locked_identity;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_supplier_purchases_locked_financials;`.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_purchases_no_update
    BEFORE UPDATE ON supplier_purchases
    BEGIN SELECT RAISE(ABORT, 'supplier_purchases records are append-only'); END;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_supplier_payments_no_update
    BEFORE UPDATE ON supplier_payments
    BEGIN SELECT RAISE(ABORT, 'supplier_payments records are append-only'); END;
  `.execute(db);
}
