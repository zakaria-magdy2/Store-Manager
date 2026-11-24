import { sql, type Kysely } from 'kysely';

interface LegacyOpenShiftRow {
  id: string;
  tenant_id: string;
  store_id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  opening_cash: string | number | bigint | null;
  notes: string | null;
}

/**
 * Migration 032: Enforce at most one OPEN shift per (tenant_id, store_id).
 *
 * Accounting-safe legacy upgrade policy:
 * If a legacy database has >1 OPEN shift in the same store, we keep the most recently
 * started shift OPEN, and for each older duplicate OPEN shift we compute its exact
 * expected drawer cash over its effective window `[started_at, next_shift_started_at)`:
 *   expected_cash = opening_cash + cash_sales - cash_returns + net_other_drawer_1010_movements
 * Because no physical cash count occurred for auto-closed shifts, we record the computed
 * `expected_cash`, keep `actual_cash = 0`, `variance = 0`, `handover_cash = 0`, mark
 * `reconciliation_status = 'UNVERIFIED_AUTO_CLOSED'` (when present), and record an explicit
 * unverified auto-close note in `notes` before creating the unique index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableInfo = await sql<{ name: string }>`PRAGMA table_info(cashier_shifts)`.execute(db);
  const hasReconciliationStatus = tableInfo.rows.some((r) => r.name === 'reconciliation_status');

  const openShiftsResult = await sql<LegacyOpenShiftRow>`
    SELECT id, tenant_id, store_id, user_id, started_at, ended_at, opening_cash, notes
    FROM cashier_shifts
    WHERE status = 'OPEN'
    ORDER BY tenant_id ASC, store_id ASC, started_at DESC, id DESC
  `.execute(db);

  const groupedByStore = new Map<string, LegacyOpenShiftRow[]>();
  for (const row of openShiftsResult.rows) {
    const key = `${row.tenant_id}::${row.store_id}`;
    const list = groupedByStore.get(key) ?? [];
    list.push(row);
    groupedByStore.set(key, list);
  }

  for (const shifts of groupedByStore.values()) {
    if (shifts.length <= 1) continue;
    // shifts[0] is the most recently started shift (kept OPEN).
    // shifts[i] (i >= 1) are older duplicate OPEN shifts that must be reconciled and closed.
    for (let i = 1; i < shifts.length; i += 1) {
      const olderShift = shifts[i]!;
      const newerShift = shifts[i - 1]!;
      const endIso = olderShift.ended_at ?? newerShift.started_at;

      const salesResult = await sql<{ net_cash_sales: string | number | bigint }>`
        SELECT COALESCE(SUM(
          COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id AND sp.sale_id = s.id AND sp.method = 'CASH'), 0)
          - COALESCE(s.change_given, 0)
        ), 0) AS net_cash_sales
        FROM sales s
        WHERE s.tenant_id = ${olderShift.tenant_id}
          AND s.store_id = ${olderShift.store_id}
          AND s.status = 'COMPLETED'
          AND replace(s.created_at, ' ', 'T') >= replace(${olderShift.started_at}, ' ', 'T')
          AND replace(s.created_at, ' ', 'T') < replace(${endIso}, ' ', 'T')
      `.execute(db);

      const returnsResult = await sql<{ cash_returns: string | number | bigint }>`
        SELECT COALESCE(SUM(cr.refund_amount), 0) AS cash_returns
        FROM customer_returns cr
        WHERE cr.tenant_id = ${olderShift.tenant_id}
          AND cr.store_id = ${olderShift.store_id}
          AND cr.payment_method = 'CASH'
          AND replace(cr.created_at, ' ', 'T') >= replace(${olderShift.started_at}, ' ', 'T')
          AND replace(cr.created_at, ' ', 'T') < replace(${endIso}, ' ', 'T')
      `.execute(db);

      const drawerResult = await sql<{ net_delta: string | number | bigint }>`
        SELECT COALESCE(SUM(CASE WHEN jl.entry_type = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS net_delta
        FROM journal_entries je
        INNER JOIN journal_lines jl ON jl.journal_entry_id = je.id
        INNER JOIN accounts a ON a.id = jl.account_id
        WHERE je.tenant_id = ${olderShift.tenant_id}
          AND je.store_id = ${olderShift.store_id}
          AND a.account_code = '1010'
          AND je.source_type NOT IN ('SALE', 'RETURN', 'SESSION_CLOSING')
          AND replace(je.created_at, ' ', 'T') >= replace(${olderShift.started_at}, ' ', 'T')
          AND replace(je.created_at, ' ', 'T') < replace(${endIso}, ' ', 'T')
      `.execute(db);

      const openingCash = BigInt(olderShift.opening_cash ?? 0);
      const cashSales = BigInt(salesResult.rows[0]?.net_cash_sales ?? 0);
      const cashReturns = BigInt(returnsResult.rows[0]?.cash_returns ?? 0);
      const otherDrawerDelta = BigInt(drawerResult.rows[0]?.net_delta ?? 0);
      const expectedCash = openingCash + cashSales - cashReturns + otherDrawerDelta;
      const reconciliationNote = 'إغلاق آلي عند الترقية (032) — غير متحقق نقديًا (لم يتم جرد الدرج فعليًا)';
      const existingNotes = (olderShift.notes ?? '').trim();
      const mergedNotes = existingNotes ? `${existingNotes} — ${reconciliationNote}` : reconciliationNote;

      if (hasReconciliationStatus) {
        await sql`
          UPDATE cashier_shifts
          SET status = 'CLOSED',
              ended_at = ${endIso},
              expected_cash = ${expectedCash.toString()},
              actual_cash = 0,
              variance = 0,
              handover_cash = 0,
              reconciliation_status = 'UNVERIFIED_AUTO_CLOSED',
              notes = ${mergedNotes},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${olderShift.id}
            AND tenant_id = ${olderShift.tenant_id}
        `.execute(db);
      } else {
        await sql`
          UPDATE cashier_shifts
          SET status = 'CLOSED',
              ended_at = ${endIso},
              expected_cash = ${expectedCash.toString()},
              actual_cash = 0,
              variance = 0,
              handover_cash = 0,
              notes = ${mergedNotes},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${olderShift.id}
            AND tenant_id = ${olderShift.tenant_id}
        `.execute(db);
      }
    }
  }

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_one_open_per_store
    ON cashier_shifts(tenant_id, store_id)
    WHERE status = 'OPEN';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_one_open_per_store;`.execute(db);
}
