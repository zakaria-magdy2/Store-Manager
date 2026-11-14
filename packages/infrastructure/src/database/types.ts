import type { Generated } from 'kysely';

export interface TenantsTable {
  id: string;
  name: string;
  code: string;
  currency: string;
  is_active: Generated<number>; // SQLite stores booleans as 0/1
  allow_negative_stock: Generated<number>;
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
  phone: string | null;
  employment_start_date: string | null;
  shift_start_time: Generated<string | null>;
  late_grace_minutes: Generated<number>;
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
  source_type: 'SALE' | 'PURCHASE' | 'PURCHASE_PAYMENT' | 'SUPPLIER_RETURN' | 'RETURN' | 'TRANSFER' | 'EXPENSE' | 'ADJUSTMENT' | 'SESSION_CLOSING';
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
  idempotency_key: string;
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
  idempotency_key: string;
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

export interface CategoriesTable {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  code: string;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface ProductsTable {
  id: string;
  tenant_id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category_id: string | null;
  has_variants: number;
  item_kind: 'PRODUCT' | 'SERVICE';
  description: string | null;
  brand: string | null;
  image_path: string | null;
  options_json: string;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface ProductVariantsTable {
  id: string;
  tenant_id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  attributes_json: string;
  retail_price: bigint;
  currency: string;
  reorder_point: bigint;
  is_active: Generated<number>;
  created_at: Generated<string>;
}

export interface InventoryItemsTable {
  id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  quantity_on_hand: bigint;
  wac_cost: bigint;
  currency: string;
  updated_at: Generated<string>;
}

export interface StockMovementsTable {
  id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  movement_type: string;
  quantity_delta: bigint;
  unit_cost: bigint;
  currency: string;
  resulting_quantity: bigint;
  resulting_wac: bigint;
  source_type: string;
  source_id: string;
  created_by_user_id: string;
  created_at: Generated<string>;
}

export interface SalesTable {
  id: string;
  tenant_id: string;
  store_id: string;
  sale_number: string;
  idempotency_key: string;
  customer_name: string | null;
  currency: string;
  subtotal: bigint;
  discount_total: bigint;
  total: bigint;
  paid_total: bigint;
  change_given: bigint;
  cashier_user_id: string;
  status: string;
  created_at: Generated<string>;
}

export interface SaleItemsTable {
  id: string;
  sale_id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  variant_attributes_json: string | null;
  line_number: number;
  item_type: string;
  quantity: bigint;
  unit_price: bigint;
  line_discount: bigint;
  cart_discount_share: bigint;
  net_revenue: bigint;
  unit_cost_snapshot: bigint;
  cost_of_goods_sold: bigint;
  currency: string;
  created_at: Generated<string>;
}

export interface SalePaymentsTable {
  id: string;
  sale_id: string;
  tenant_id: string;
  tender_index: number;
  method: string;
  amount: bigint;
  created_at: Generated<string>;
}

export interface SuppliersTable {
  id: string; tenant_id: string; name: string; phone: string | null; notes: string | null;
  is_active: Generated<number>; created_at: Generated<string>;
}

export interface SupplierPurchasesTable {
  id: string; tenant_id: string; store_id: string; supplier_id: string; invoice_number: string | null;
  idempotency_key: string;
  purchased_at: string; total_amount: bigint; initial_paid_amount: Generated<bigint>; currency: string;
  notes: string | null; created_by_user_id: string; created_at: Generated<string>;
}

export interface SupplierPaymentsTable {
  id: string; tenant_id: string; supplier_id: string; purchase_id: string; amount: bigint;
  currency: string; payment_method: string; reference_number: string | null; paid_at: string;
  idempotency_key: string;
  created_by_user_id: string; created_at: Generated<string>;
}

export interface SupplierPurchaseItemsTable {
  id: string; tenant_id: string; store_id: string; purchase_id: string; variant_id: string;
  product_id: string; product_name: string; sku: string; quantity: bigint; unit_cost: bigint;
  currency: string; created_at: Generated<string>;
}

export interface CustomerReturnsTable {
  id: string; tenant_id: string; store_id: string; original_sale_id: string;
  return_number: string; idempotency_key: string; refund_amount: bigint; currency: string;
  payment_method: 'CASH' | 'CARD' | 'MOBILE' | 'OTHER'; journal_entry_id: string;
  created_by_user_id: string; created_at: string;
}

export interface CustomerReturnItemsTable {
  id: string; return_id: string; tenant_id: string; original_sale_item_id: string;
  variant_id: string; quantity: bigint; refund_amount: bigint; cost_amount: bigint;
}

export interface SupplierReturnsTable {
  id: string; tenant_id: string; store_id: string; supplier_id: string; purchase_id: string;
  return_number: string; idempotency_key: string; credit_amount: bigint; currency: string;
  journal_entry_id: string | null; created_by_user_id: string; created_at: string;
}

export interface SupplierReturnItemsTable {
  id: string; return_id: string; tenant_id: string; purchase_item_id: string;
  variant_id: string; quantity: bigint; credit_amount: bigint; inventory_cost: bigint;
}

export interface AuditLogsTable {
  sequence_no: Generated<number>;
  id: string;
  tenant_id: string;
  store_id: string | null;
  actor_user_id: string | null;
  actor_username: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  metadata_json: string;
  previous_hash: string;
  entry_hash: string;
  created_at: string;
}

export interface StocktakeSessionsTable {
  id: string;
  tenant_id: string;
  store_id: string;
  session_number: string;
  title: string;
  scope: 'FULL' | 'CATEGORY' | 'PARTIAL';
  category_id: string | null;
  blind_mode: number;
  include_zero_stock: number;
  status: 'DRAFT' | 'COMMITTED' | 'CANCELLED';
  idempotency_key: string | null;
  uncounted_strategy: 'SKIP_UNCOUNTED' | 'ZERO_UNCOUNTED' | null;
  currency: string;
  notes: string | null;
  total_lines: number;
  counted_lines: number;
  total_variance_qty: number;
  total_surplus_cost: number;
  total_shortage_cost: number;
  net_variance_cost: number;
  net_variance_retail: number;
  journal_entry_id: string | null;
  created_by_user_id: string;
  committed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  cancelled_at: string | null;
}

export interface StocktakeLinesTable {
  id: string;
  session_id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  expected_quantity: number;
  counted_quantity: number | null;
  unit_wac: number;
  retail_price: number;
  override_unit_cost: number | null;
  scanned_count: number;
  reason: string | null;
  committed_expected_quantity: number | null;
  committed_variance_qty: number | null;
  committed_variance_cost: number | null;
  committed_unit_cost: number | null;
  last_counted_at: string | null;
  created_at: string;
  updated_at: string;
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
  categories: CategoriesTable;
  products: ProductsTable;
  product_variants: ProductVariantsTable;
  inventory_items: InventoryItemsTable;
  stock_movements: StockMovementsTable;
  sales: SalesTable;
  sale_items: SaleItemsTable;
  sale_payments: SalePaymentsTable;
  suppliers: SuppliersTable;
  supplier_purchases: SupplierPurchasesTable;
  supplier_payments: SupplierPaymentsTable;
  supplier_purchase_items: SupplierPurchaseItemsTable;
  customer_returns: CustomerReturnsTable;
  customer_return_items: CustomerReturnItemsTable;
  supplier_returns: SupplierReturnsTable;
  supplier_return_items: SupplierReturnItemsTable;
  audit_logs: AuditLogsTable;
  stocktake_sessions: StocktakeSessionsTable;
  stocktake_lines: StocktakeLinesTable;
}
