import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 026:
 * 1. Scope supplier invoice number uniqueness to `(tenant_id, supplier_id, invoice_number)`
 *    so different suppliers can share invoice numbers while duplicate invoices from the
 *    same supplier remain blocked, with an explicit preflight check for legacy duplicates.
 * 2. Reconcile legacy open-period monthly recurring accrual entries (`6090 DR / 2020 CR`)
 *    onto the pure cash-basis policy by reversing any unpaid accrual portion (`amount - paid_amount`)
 *    via a balanced adjustment (`2020 DR / 6090 CR`), ensuring GL Expense 6090 equals cash paid.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const duplicateInvoices = await sql<{
    tenant_id: string;
    supplier_id: string;
    invoice_number: string;
    cnt: number | bigint;
  }>`
    SELECT tenant_id, supplier_id, invoice_number, COUNT(*) AS cnt
    FROM supplier_purchases
    WHERE invoice_number IS NOT NULL
    GROUP BY tenant_id, supplier_id, invoice_number
    HAVING COUNT(*) > 1
    LIMIT 10;
  `.execute(db);

  if (duplicateInvoices.rows.length > 0) {
    const details = duplicateInvoices.rows
      .map(
        (r) =>
          `tenant=${r.tenant_id} supplier=${r.supplier_id} invoice=${r.invoice_number} count=${String(r.cnt)}`,
      )
      .join('; ');
    throw new Error(
      `Migration026PreflightError: Duplicate invoice_number values exist within the same supplier (${details}). Resolve same-supplier duplicates before upgrading.`,
    );
  }

  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_tenant_invoice;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_supplier_invoice;`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_supplier_purchases_supplier_invoice
    ON supplier_purchases(tenant_id, supplier_id, invoice_number)
    WHERE invoice_number IS NOT NULL;
  `.execute(db);

  const legacyOpenAccruals = await sql<{
    id: string;
    tenant_id: string;
    store_id: string | null;
    obligation_id: string;
    period_id: string;
    year: number | bigint;
    month: number | bigint;
    amount: number | bigint;
    paid_amount: number | bigint;
    currency: string;
    accrual_date: string;
    created_by_user_id: string;
  }>`
    SELECT
      m.id,
      m.tenant_id,
      COALESCE(je.store_id, m.store_id) AS store_id,
      m.obligation_id,
      m.period_id,
      m.year,
      m.month,
      m.amount,
      m.paid_amount,
      m.currency,
      je.entry_date AS accrual_date,
      je.created_by_user_id AS created_by_user_id
    FROM monthly_expense_actuals m
    INNER JOIN accounting_periods p
      ON p.id = m.period_id AND p.tenant_id = m.tenant_id
    INNER JOIN journal_entries je
      ON je.id = m.journal_entry_id AND je.tenant_id = m.tenant_id
    WHERE m.journal_entry_id IS NOT NULL
      AND m.amount > m.paid_amount
      AND p.status = 'OPEN'
      AND je.idempotency_key = ('monthly-accrual:' || m.obligation_id || ':' || printf('%04d-%02d', m.year, m.month))
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries existing_adj
        WHERE existing_adj.tenant_id = m.tenant_id
          AND existing_adj.idempotency_key = ('migration-026:cash-basis:' || m.id)
      );
  `.execute(db);

  const nowIso = new Date().toISOString();
  for (const row of legacyOpenAccruals.rows) {
    const unpaid = BigInt(row.amount) - BigInt(row.paid_amount);
    if (unpaid <= 0n) continue;

    const accountsRes = await sql<{ id: string; account_code: string }>`
      SELECT id, account_code
      FROM accounts
      WHERE tenant_id = ${row.tenant_id}
        AND account_code IN ('2020', '6090');
    `.execute(db);
    const byCode = new Map(accountsRes.rows.map((a) => [a.account_code, a.id]));
    const acc2020 = byCode.get('2020');
    const acc6090 = byCode.get('6090');
    if (!acc2020 || !acc6090) continue;

    const journalId = randomUUID();
    const entryNumber = `J-MIG026-${row.id.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const idempotencyKey = `migration-026:cash-basis:${row.id}`;
    const ym = `${String(row.year)}-${String(row.month).padStart(2, '0')}`;

    await sql`
      INSERT INTO journal_entries (
        id, tenant_id, store_id, period_id, entry_number, entry_date,
        source_type, source_id, idempotency_key, status, reversed_by_entry_id,
        created_at, created_by_user_id
      ) VALUES (
        ${journalId}, ${row.tenant_id}, ${row.store_id}, ${row.period_id}, ${entryNumber}, ${row.accrual_date},
        'ADJUSTMENT', ${row.id}, ${idempotencyKey}, 'POSTED', NULL,
        ${nowIso}, ${row.created_by_user_id}
      );
    `.execute(db);

    await sql`
      INSERT INTO journal_lines (id, journal_entry_id, account_id, entry_type, amount, currency, memo)
      VALUES
        (${randomUUID()}, ${journalId}, ${acc2020}, 'DEBIT', ${unpaid}, ${row.currency}, ${`تسوية الأساس النقدي للالتزام (${ym}) — عكس مستحق غير مسدد`}),
        (${randomUUID()}, ${journalId}, ${acc6090}, 'CREDIT', ${unpaid}, ${row.currency}, ${`تسوية الأساس النقدي للالتزام (${ym}) — قصر المصروف على المسدد فعليًا`});
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_supplier_purchases_supplier_invoice;`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_purchases_tenant_invoice
    ON supplier_purchases(tenant_id, invoice_number)
    WHERE invoice_number IS NOT NULL;
  `.execute(db);
}
