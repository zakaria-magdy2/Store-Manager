import type { Kysely } from 'kysely';
import { sql } from 'kysely';

interface Guard {
  table: string;
  name: string;
  invalidNewRow: string;
}

// SQLite cannot add composite foreign keys to existing tables without rebuilding
// them. These database triggers enforce the equivalent tenant ownership and
// parent-child invariants for inserts and updates, including direct SQL writes.
const guards: readonly Guard[] = [
  { table: 'users', name: 'user_store', invalidNewRow: `(NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores st WHERE st.id = NEW.store_id AND st.tenant_id = NEW.tenant_id)) OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = NEW.id AND s.is_revoked = 0 AND (s.tenant_id <> NEW.tenant_id OR s.store_id IS NOT NEW.store_id))` },
  { table: 'sessions', name: 'session_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.tenant_id = NEW.tenant_id AND u.store_id IS NEW.store_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id))` },
  { table: 'categories', name: 'category_parent', invalidNewRow: `NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories p WHERE p.id = NEW.parent_id AND p.tenant_id = NEW.tenant_id)` },
  { table: 'products', name: 'product_category', invalidNewRow: `NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id)` },
  { table: 'product_variants', name: 'variant_product', invalidNewRow: `NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id)` },
  { table: 'inventory_items', name: 'inventory_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id)` },
  { table: 'stock_movements', name: 'movement_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id = NEW.store_id))` },
  { table: 'recurring_expense_obligations', name: 'obligation_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id))` },
  { table: 'monthly_expense_actuals', name: 'monthly_actual_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM recurring_expense_obligations o WHERE o.id = NEW.obligation_id AND o.tenant_id = NEW.tenant_id AND (o.store_id IS NULL OR o.store_id IS NEW.store_id)) OR NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.id = NEW.period_id AND p.tenant_id = NEW.tenant_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id))` },
  { table: 'operating_expense_records', name: 'expense_record_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id)) OR (NEW.monthly_actual_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM monthly_expense_actuals m WHERE m.id = NEW.monthly_actual_id AND m.tenant_id = NEW.tenant_id AND (m.store_id IS NULL OR m.store_id IS NEW.store_id))) OR (NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.tenant_id = NEW.tenant_id)) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id IS NEW.store_id))` },
  { table: 'journal_entries', name: 'journal_entry_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.id = NEW.period_id AND p.tenant_id = NEW.tenant_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id)) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.created_by_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id IS NEW.store_id))` },
  { table: 'journal_lines', name: 'journal_line_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM journal_entries j JOIN accounts a ON a.id = NEW.account_id AND a.tenant_id = j.tenant_id WHERE j.id = NEW.journal_entry_id)` },
  { table: 'outbox_events', name: 'outbox_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id) OR (NEW.store_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id))` },
  { table: 'sales', name: 'sale_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = NEW.store_id AND s.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.cashier_user_id AND u.tenant_id = NEW.tenant_id AND (u.store_id IS NULL OR u.store_id = NEW.store_id))` },
  { table: 'sale_items', name: 'sale_item_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = NEW.sale_id AND s.tenant_id = NEW.tenant_id AND s.store_id = NEW.store_id) OR NOT EXISTS (SELECT 1 FROM stores st WHERE st.id = NEW.store_id AND st.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.tenant_id = NEW.tenant_id) OR NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.id = NEW.variant_id AND v.tenant_id = NEW.tenant_id AND v.product_id = NEW.product_id)` },
  { table: 'sale_payments', name: 'sale_payment_scope', invalidNewRow: `NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = NEW.sale_id AND s.tenant_id = NEW.tenant_id)` },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const guard of guards) {
    const triggerBase = `trg_${guard.table}_${guard.name}_tenant_guard`;
    const validation = await sql<{ has_violation: number }>`
      SELECT EXISTS (SELECT 1 FROM ${sql.raw(guard.table)} AS candidate
      WHERE ${sql.raw(guard.invalidNewRow.replaceAll('NEW.', 'candidate.'))}
      ) AS has_violation
    `.execute(db);
    if (validation.rows[0]?.has_violation === 1) {
      throw new Error(`Migration 006 refused: existing tenant relationship violations in ${guard.table}`);
    }

    for (const operation of ['INSERT', 'UPDATE'] as const) {
      await sql`
        CREATE TRIGGER ${sql.raw(`${triggerBase}_${operation.toLowerCase()}`)}
        BEFORE ${sql.raw(operation)} ON ${sql.raw(guard.table)}
        FOR EACH ROW WHEN (${sql.raw(guard.invalidNewRow)})
        BEGIN
          SELECT RAISE(ABORT, ${sql.lit(`TenantIsolationViolation: invalid ${guard.name} relationship`)});
        END;
      `.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const guard of guards) {
    const triggerBase = `trg_${guard.table}_${guard.name}_tenant_guard`;
    for (const operation of ['insert', 'update'] as const) {
      await sql`DROP TRIGGER IF EXISTS ${sql.raw(`${triggerBase}_${operation}`)};`.execute(db);
    }
  }
}
