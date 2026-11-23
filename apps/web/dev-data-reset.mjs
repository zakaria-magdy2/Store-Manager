import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const RESET_TABLES_IN_DELETE_ORDER = [
  'stocktake_lines',
  'customer_return_items',
  'customer_returns',
  'supplier_return_items',
  'supplier_returns',
  'supplier_refunds',
  'supplier_purchase_items',
  'supplier_payments',
  'sale_items',
  'sale_payments',
  'operating_expense_records',
  'monthly_expense_actuals',
  'recurring_expense_obligations',
  'expense_categories',
  'stock_movements',
  'inventory_items',
  'stocktake_sessions',
  'cashier_shifts',
  'supplier_purchases',
  'sales',
  'journal_lines',
  'journal_entries',
  'accounting_periods',
  'product_variants',
  'products',
  'categories',
  'suppliers',
  'document_sequences',
  'auth_rate_limits',
  'outbox_events',
];

const RESET_TABLE_SET = new Set(RESET_TABLES_IN_DELETE_ORDER);

export function isPreviewResetConfiguration({ previewMarkerExists, dataDir, databasePath, electronRuntime }) {
  if (!previewMarkerExists || !electronRuntime || !dataDir || !databasePath) return false;
  const pathApi = win32.isAbsolute(dataDir) ? win32 : { isAbsolute, relative, resolve, sep };
  const resolvedDataDir = pathApi.resolve(dataDir);
  const resolvedDatabasePath = pathApi.resolve(databasePath);
  const relativeDatabasePath = pathApi.relative(resolvedDataDir, resolvedDatabasePath);
  return pathApi.isAbsolute(dataDir)
    && relativeDatabasePath !== ''
    && relativeDatabasePath !== '..'
    && !relativeDatabasePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativeDatabasePath);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** Clears synthetic operational data without changing the schema, owner, license, audit chain, or backup files. */
export function resetDevelopmentOperationalData(rawDatabase) {
  if (!rawDatabase || typeof rawDatabase.prepare !== 'function' || typeof rawDatabase.transaction !== 'function') {
    throw new TypeError('A live SQLite database handle is required');
  }

  const tables = new Set(rawDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const triggers = rawDatabase.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all()
    .filter((trigger) => RESET_TABLE_SET.has(trigger.tbl_name));
  const deleteTables = RESET_TABLES_IN_DELETE_ORDER.filter((table) => tables.has(table));

  const runReset = rawDatabase.transaction(() => {
    for (const trigger of triggers) rawDatabase.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);

    const deleted = {};
    for (const table of deleteTables) {
      const count = rawDatabase.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
      rawDatabase.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
      deleted[table] = Number(count);
    }

    for (const trigger of triggers) rawDatabase.exec(trigger.sql);

    const foreignKeyErrors = rawDatabase.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) {
      throw new Error(`Development reset left ${foreignKeyErrors.length} foreign-key violations`);
    }

    return { deleted, preserved: ['tenants', 'stores', 'users', 'sessions', 'accounts', 'system_licensing', 'audit logs', 'migration history', 'backup files'] };
  });

  return runReset();
}
