import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Tenants
  await db.schema
    .createTable('tenants')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('code', 'text', (col) => col.notNull().unique())
    .addColumn('currency', 'text', (col) => col.notNull().defaultTo('USD'))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // 2. Stores
  await db.schema
    .createTable('stores')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('code', 'text', (col) => col.notNull())
    .addColumn('address', 'text')
    .addColumn('phone', 'text')
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_stores_tenant_code')
    .on('stores')
    .columns(['tenant_id', 'code'])
    .unique()
    .execute();

  // 3. Users
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('username', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text', (col) => col.notNull())
    .addColumn('full_name', 'text', (col) => col.notNull())
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_users_tenant_username')
    .on('users')
    .columns(['tenant_id', 'username'])
    .unique()
    .execute();

  // 4. Accounts (Chart of Accounts)
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('account_code', 'text', (col) => col.notNull())
    .addColumn('account_name', 'text', (col) => col.notNull())
    .addColumn('account_type', 'text', (col) => col.notNull())
    .addColumn('normal_balance', 'text', (col) => col.notNull())
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_accounts_tenant_code')
    .on('accounts')
    .columns(['tenant_id', 'account_code'])
    .unique()
    .execute();

  // 5. Accounting Periods
  await db.schema
    .createTable('accounting_periods')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('start_date', 'text', (col) => col.notNull())
    .addColumn('end_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('OPEN'))
    .addColumn('closed_at', 'text')
    .addColumn('closed_by_user_id', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // 6. Journal Entries
  // NOTE: store_id is nullable FK — must use (col) => col.references() inside callback
  await db.schema
    .createTable('journal_entries')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .addColumn('period_id', 'text', (col) =>
      col.notNull().references('accounting_periods.id').onDelete('restrict'),
    )
    .addColumn('entry_number', 'text', (col) => col.notNull())
    .addColumn('entry_date', 'text', (col) => col.notNull())
    .addColumn('source_type', 'text', (col) => col.notNull())
    .addColumn('source_id', 'text', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('POSTED'))
    .addColumn('reversed_by_entry_id', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('created_by_user_id', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_journal_tenant_idempotency')
    .on('journal_entries')
    .columns(['tenant_id', 'idempotency_key'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_journal_tenant_number')
    .on('journal_entries')
    .columns(['tenant_id', 'entry_number'])
    .unique()
    .execute();

  // 7. Journal Lines
  await db.schema
    .createTable('journal_lines')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('journal_entry_id', 'text', (col) =>
      col.notNull().references('journal_entries.id').onDelete('restrict'),
    )
    .addColumn('account_id', 'text', (col) =>
      col.notNull().references('accounts.id').onDelete('restrict'),
    )
    .addColumn('entry_type', 'text', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('memo', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // 8. Expense Categories
  await db.schema
    .createTable('expense_categories')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('code', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('expense_type', 'text', (col) => col.notNull())
    .addColumn('account_code', 'text', (col) => col.notNull().defaultTo('6090'))
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_expense_cat_tenant_code')
    .on('expense_categories')
    .columns(['tenant_id', 'code'])
    .unique()
    .execute();

  // 9. Recurring Expense Obligations (Monthly Templates)
  await db.schema
    .createTable('recurring_expense_obligations')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .addColumn('category_id', 'text', (col) =>
      col.notNull().references('expense_categories.id').onDelete('restrict'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('due_day_of_month', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  // 10. Monthly Expense Actuals (Confirmed Upfront per Month)
  await db.schema
    .createTable('monthly_expense_actuals')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .addColumn('obligation_id', 'text', (col) =>
      col.notNull().references('recurring_expense_obligations.id').onDelete('restrict'),
    )
    .addColumn('period_id', 'text', (col) =>
      col.notNull().references('accounting_periods.id').onDelete('restrict'),
    )
    .addColumn('year', 'integer', (col) => col.notNull())
    .addColumn('month', 'integer', (col) => col.notNull())
    .addColumn('days_in_month', 'integer', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('confirmed_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('confirmed_by_user_id', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('DUE'))
    .addColumn('paid_amount', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('journal_entry_id', 'text', (col) =>
      col.references('journal_entries.id').onDelete('set null'),
    )
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_monthly_actual_unique')
    .on('monthly_expense_actuals')
    .columns(['tenant_id', 'obligation_id', 'year', 'month'])
    .unique()
    .execute();

  // 11. Operating Expense Records (Direct Daily & Payments)
  await db.schema
    .createTable('operating_expense_records')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .addColumn('category_id', 'text', (col) =>
      col.notNull().references('expense_categories.id').onDelete('restrict'),
    )
    .addColumn('expense_type', 'text', (col) => col.notNull())
    .addColumn('monthly_actual_id', 'text', (col) =>
      col.references('monthly_expense_actuals.id').onDelete('set null'),
    )
    .addColumn('expense_date', 'text', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('payment_method', 'text', (col) => col.notNull())
    .addColumn('source_account_code', 'text', (col) => col.notNull())
    .addColumn('notes', 'text')
    .addColumn('reference_number', 'text')
    .addColumn('attachment_path', 'text')
    .addColumn('journal_entry_id', 'text', (col) =>
      col.references('journal_entries.id').onDelete('set null'),
    )
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('created_by_user_id', 'text', (col) => col.notNull())
    .execute();

  // 12. Outbox Events (CDC for Sync)
  await db.schema
    .createTable('outbox_events')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) => col.notNull())
    .addColumn('store_id', 'text')
    .addColumn('aggregate_type', 'text', (col) => col.notNull())
    .addColumn('aggregate_id', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'text', (col) => col.notNull())
    // SQLite AUTOINCREMENT only works on INTEGER PRIMARY KEY.
    // sequence_no is set by the application (monotonically increasing per tenant).
    .addColumn('sequence_no', 'integer', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('synced_at', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_outbox_tenant_idempotency')
    .on('outbox_events')
    .columns(['tenant_id', 'idempotency_key'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('outbox_events').execute();
  await db.schema.dropTable('operating_expense_records').execute();
  await db.schema.dropTable('monthly_expense_actuals').execute();
  await db.schema.dropTable('recurring_expense_obligations').execute();
  await db.schema.dropTable('expense_categories').execute();
  await db.schema.dropTable('journal_lines').execute();
  await db.schema.dropTable('journal_entries').execute();
  await db.schema.dropTable('accounting_periods').execute();
  await db.schema.dropTable('accounts').execute();
  await db.schema.dropTable('users').execute();
  await db.schema.dropTable('stores').execute();
  await db.schema.dropTable('tenants').execute();
}
