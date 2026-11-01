import type { Generated } from 'kysely';

export interface TenantsTable {
  id: string;
  name: string;
  code: string;
  currency: string;
  is_active: Generated<number>; // SQLite stores booleans as 0/1
  created_at: Generated<string>;
}

export interface StoresTable {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface UsersTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  username: string;
  password_hash: string;
  full_name: string;
  role: string;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface AccountsTable {
  id: string;
  tenant_id: string;
  account_code: string;
  account_name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normal_balance: 'DEBIT' | 'CREDIT';
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface AccountingPeriodsTable {
  id: string;
  tenant_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: Generated<'OPEN' | 'CLOSING' | 'CLOSED'>;
  closed_at: string | null;
  closed_by_user_id: string | null;
  created_at: Generated<string>;
}

export interface JournalEntriesTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  period_id: string;
  entry_number: string;
  entry_date: string;
  source_type: 'SALE' | 'PURCHASE' | 'RETURN' | 'TRANSFER' | 'EXPENSE' | 'ADJUSTMENT' | 'SESSION_CLOSING';
  source_id: string;
  idempotency_key: string;
  status: Generated<'POSTED' | 'REVERSED'>;
  reversed_by_entry_id: string | null;
  created_at: Generated<string>;
  created_by_user_id: string;
}

export interface JournalLinesTable {
  id: string;
  journal_entry_id: string;
  account_id: string;
  entry_type: 'DEBIT' | 'CREDIT';
  amount: bigint; // Minor units
  currency: string;
  memo: string | null;
  created_at: Generated<string>;
}

export interface ExpenseCategoriesTable {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  expense_type: 'DIRECT_DAILY' | 'MONTHLY_RECURRING';
  account_code: string;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface RecurringExpenseObligationsTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  category_id: string;
  name: string;
  due_day_of_month: number;
  currency: string;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface MonthlyExpenseActualsTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  obligation_id: string;
  period_id: string;
  year: number;
  month: number;
  days_in_month: number;
  amount: bigint;
  currency: string;
  status: Generated<'DUE' | 'PARTIALLY_PAID' | 'PAID'>;
  paid_amount: Generated<bigint>;
  journal_entry_id: string | null;
  confirmed_at: Generated<string>;
  confirmed_by_user_id: string;
  created_at: Generated<string>;
}

export interface OperatingExpenseRecordsTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  category_id: string;
  expense_type: 'DIRECT_DAILY' | 'MONTHLY_RECURRING_PAYMENT';
  monthly_actual_id: string | null;
  expense_date: string;
  amount: bigint;
  currency: string;
  payment_method: 'CASH_DRAWER' | 'CASH_SAFE' | 'BANK_TRANSFER';
  source_account_code: string;
  notes: string | null;
  reference_number: string | null;
  attachment_path: string | null;
  journal_entry_id: string | null;
  created_at: Generated<string>;
  created_by_user_id: string;
}

export interface OutboxEventsTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: string; // JSON string in SQLite
  sequence_no: number; // Monotonically increasing, set by application (SQLite AUTOINCREMENT only works on INTEGER PRIMARY KEY)
  idempotency_key: string;
  synced_at: string | null;
  created_at: Generated<string>;
}

export interface SessionsTable {
  id: string;
  tenant_id: string;
  store_id: string | null;
  user_id: string;
  token_hash: string;
  expires_at: string;
  is_revoked: Generated<number>;
  created_at: Generated<string>;
}

export interface RetailOSDatabase {
  tenants: TenantsTable;
  stores: StoresTable;
  users: UsersTable;
  sessions: SessionsTable;
  accounts: AccountsTable;
  accounting_periods: AccountingPeriodsTable;
  journal_entries: JournalEntriesTable;
  journal_lines: JournalLinesTable;
  expense_categories: ExpenseCategoriesTable;
  recurring_expense_obligations: RecurringExpenseObligationsTable;
  monthly_expense_actuals: MonthlyExpenseActualsTable;
  operating_expense_records: OperatingExpenseRecordsTable;
  outbox_events: OutboxEventsTable;
}
