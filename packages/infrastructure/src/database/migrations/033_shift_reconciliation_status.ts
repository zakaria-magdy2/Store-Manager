import { sql, type Kysely } from 'kysely';

interface ShiftRowForBackfill {
  id: string;
  tenant_id: string;
  store_id: string;
  started_at: string;
  ended_at: string | null;
  opening_cash: string | number | bigint | null;
  expected_cash: string | number | bigint | null;
  notes: string | null;
}

async function hasColumn(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const info = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return info.rows.some((row) => row.name === column);
}

/**
 * Migration 033: Distinguish verified manual cash counts from auto-closed shifts.
 *
 * Adds `reconciliation_status` ('OPEN' | 'VERIFIED' | 'UNVERIFIED_AUTO_CLOSED') to
 * `cashier_shifts`, preserves existing verified shifts, and retroactively marks any shifts
 * auto-closed by prior versions of Migration 032 (`b787b5a` or `e9ce924`) as
 * `UNVERIFIED_AUTO_CLOSED` with `actual_cash = 0`, `variance = 0`, `handover_cash = 0`
 * (and recomputed `expected_cash` if missing) so financial reports never mistake an
 * uncounted auto-closed shift for a zero-variance physical cash count.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, 'cashier_shifts', 'reconciliation_status'))) {
    await sql`
      ALTER TABLE cashier_shifts
      ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'VERIFIED'
      CHECK (reconciliation_status IN ('OPEN', 'VERIFIED', 'UNVERIFIED_AUTO_CLOSED'));
    `.execute(db);
  }

  await sql`
    UPDATE cashier_shifts
    SET reconciliation_status = 'OPEN'
    WHERE status = 'OPEN';
  `.execute(db);

  const candidateRows = await sql<ShiftRowForBackfill>`
    SELECT id, tenant_id, store_id, started_at, ended_at, opening_cash, expected_cash, notes
    FROM cashier_shifts
    WHERE status = 'CLOSED'
      AND (
        notes LIKE '%تسوية وإغلاق تلقائي عند الترقية%'
        OR notes LIKE '%إغلاق آلي عند الترقية%'
        OR (
          close_idempotency_key IS NULL
          AND expected_cash = 0
          AND actual_cash = 0
          AND handover_cash = 0
          AND variance = 0
          AND opening_cash > 0
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.tenant_id = cashier_shifts.tenant_id
              AND al.entity_id = cashier_shifts.id
              AND al.action = 'SHIFT_CLOSED'
          )
        )
      );
  `.execute(db);

  for (const row of candidateRows.rows) {
    let expectedCash = BigInt(row.expected_cash ?? 0);
    const openingCash = BigInt(row.opening_cash ?? 0);
    if (expectedCash === 0n && openingCash > 0n) {
      const endWindow = row.ended_at ?? new Date().toISOString();
      const salesResult = await sql<{ net_cash_sales: string | number | bigint }>`
        SELECT COALESCE(SUM(
          COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method = 'CASH'), 0)
          - COALESCE(s.change_given, 0)
        ), 0) AS net_cash_sales
        FROM sales s
        WHERE s.tenant_id = ${row.tenant_id}
          AND s.store_id = ${row.store_id}
          AND s.status = 'COMPLETED'
          AND replace(s.created_at, ' ', 'T') >= replace(${row.started_at}, ' ', 'T')
          AND replace(s.created_at, ' ', 'T') < replace(${endWindow}, ' ', 'T')
      `.execute(db);

      const returnsResult = await sql<{ cash_returns: string | number | bigint }>`
        SELECT COALESCE(SUM(cr.refund_amount), 0) AS cash_returns
        FROM customer_returns cr
        WHERE cr.tenant_id = ${row.tenant_id}
          AND cr.store_id = ${row.store_id}
          AND cr.payment_method = 'CASH'
          AND replace(cr.created_at, ' ', 'T') >= replace(${row.started_at}, ' ', 'T')
          AND replace(cr.created_at, ' ', 'T') < replace(${endWindow}, ' ', 'T')
      `.execute(db);

      const drawerResult = await sql<{ net_delta: string | number | bigint }>`
        SELECT COALESCE(SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS net_delta
        FROM journal_entries je
        INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
        INNER JOIN accounts a ON a.id = jl.account_id
        WHERE je.tenant_id = ${row.tenant_id}
          AND je.store_id = ${row.store_id}
          AND a.account_code = '1010'
          AND je.source_type NOT IN ('SALE', 'RETURN', 'SESSION_CLOSING')
          AND replace(je.created_at, ' ', 'T') >= replace(${row.started_at}, ' ', 'T')
          AND replace(je.created_at, ' ', 'T') < replace(${endWindow}, ' ', 'T')
      `.execute(db);

      expectedCash =
        openingCash +
        BigInt(salesResult.rows[0]?.net_cash_sales ?? 0) -
        BigInt(returnsResult.rows[0]?.cash_returns ?? 0) +
        BigInt(drawerResult.rows[0]?.net_delta ?? 0);
    }

    const existingNotes = (row.notes ?? '').trim();
    const updatedNotes = existingNotes.includes('غير متحقق نقديًا')
      ? existingNotes
      : existingNotes
        ? `${existingNotes} — إغلاق آلي عند الترقية — غير متحقق نقديًا`
        : 'إغلاق آلي عند الترقية — غير متحقق نقديًا';

    await sql`
      UPDATE cashier_shifts
      SET reconciliation_status = 'UNVERIFIED_AUTO_CLOSED',
          expected_cash = ${expectedCash.toString()},
          actual_cash = 0,
          variance = 0,
          handover_cash = 0,
          notes = ${updatedNotes},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${row.id}
        AND tenant_id = ${row.tenant_id};
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (await hasColumn(db, 'cashier_shifts', 'reconciliation_status')) {
    await sql`ALTER TABLE cashier_shifts DROP COLUMN reconciliation_status;`.execute(db);
  }
}
