import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';
import { Migrator } from 'kysely/migration';
import { Logger } from '../logger/logger.js';
import type { RetailOSDatabase } from './types.js';
import * as initialFoundation from './migrations/001_initial_foundation.js';
import * as identitySessions from './migrations/002_identity_sessions.js';
import * as catalogInventory from './migrations/003_catalog_inventory.js';
import * as posCheckout from './migrations/004_pos_checkout.js';
import * as posCheckoutOrdering from './migrations/005_pos_checkout_ordering.js';
import * as tenantRelationshipGuards from './migrations/006_tenant_relationship_guards.js';
import * as suppliersPurchases from './migrations/007_suppliers_purchases.js';
import * as productServiceKind from './migrations/008_product_service_kind.js';
import * as supplierPurchaseItems from './migrations/009_supplier_purchase_items.js';
import * as supplierJournalIdempotency from './migrations/010_supplier_journal_idempotency.js';
import * as expenseIdempotency from './migrations/011_expense_idempotency.js';
import * as customerReturns from './migrations/012_customer_returns.js';
import * as monthlyExpenseSafety from './migrations/013_monthly_expense_safety.js';
import * as supplierReturns from './migrations/014_supplier_returns.js';
import * as employeeProfiles from './migrations/015_employee_profiles.js';
import * as productsRequireStock from './migrations/016_products_require_stock.js';
import * as productVariantsMetadata from './migrations/017_product_variants_metadata.js';
import * as auditLogs from './migrations/018_audit_logs.js';
import * as enterpriseAccountingAndIndexes from './migrations/019_enterprise_accounting_and_indexes.js';
import * as attendanceSchedule from './migrations/020_attendance_schedule.js';
import * as stocktakeSessions from './migrations/021_stocktake_sessions.js';
import * as purchaseRetailPricing from './migrations/022_purchase_retail_pricing.js';
import * as businessTimezoneShiftsSequences from './migrations/023_business_timezone_shifts_sequences.js';
import * as stressHardeningExpensesAndShifts from './migrations/024_stress_hardening_expenses_and_shifts.js';
import * as customerReturnExchangeFlag from './migrations/025_customer_return_exchange_flag.js';
import * as accountingCashBasisAndSupplierInvoiceIndex from './migrations/026_accounting_cash_basis_and_supplier_invoice_index.js';
import * as supplierRefunds from './migrations/027_supplier_refunds.js';
import * as systemLicensing from './migrations/028_system_licensing.js';
import * as systemLicensingGuard from './migrations/029_system_licensing_guard.js';
import * as editablePurchasesPaymentsExpenses from './migrations/030_editable_purchases_payments_expenses.js';
import * as passwordResetTokens from './migrations/031_password_reset_tokens.js';
import * as singleOpenShiftPerStore from './migrations/032_single_open_shift_per_store.js';
import * as shiftReconciliationStatus from './migrations/033_shift_reconciliation_status.js';
import * as clockResetRecovery from './migrations/034_clock_reset_recovery.js';
import * as supplierOpeningDebt from './migrations/035_supplier_opening_debt.js';
import * as openingDebtUniqueness from './migrations/036_opening_debt_uniqueness.js';

const MIGRATION_REGISTRY: Record<string, Migration> = {
  '001_initial_foundation': {
    up: initialFoundation.up,
    down: initialFoundation.down,
  },
  '002_identity_sessions': {
    up: identitySessions.up,
    down: identitySessions.down,
  },
  '003_catalog_inventory': {
    up: catalogInventory.up,
    down: catalogInventory.down,
  },
  '004_pos_checkout': {
    up: posCheckout.up,
    down: posCheckout.down,
  },
  '005_pos_checkout_ordering': {
    up: posCheckoutOrdering.up,
    down: posCheckoutOrdering.down,
  },
  '006_tenant_relationship_guards': {
    up: tenantRelationshipGuards.up,
    down: tenantRelationshipGuards.down,
  },
  '007_suppliers_purchases': {
    up: suppliersPurchases.up,
    down: suppliersPurchases.down,
  },
  '008_product_service_kind': {
    up: productServiceKind.up,
    down: productServiceKind.down,
  },
  '009_supplier_purchase_items': {
    up: supplierPurchaseItems.up,
    down: supplierPurchaseItems.down,
  },
  '010_supplier_journal_idempotency': {
    up: supplierJournalIdempotency.up,
    down: supplierJournalIdempotency.down,
  },
  '011_expense_idempotency': {
    up: expenseIdempotency.up,
    down: expenseIdempotency.down,
  },
  '012_customer_returns': {
    up: customerReturns.up,
    down: customerReturns.down,
  },
  '013_monthly_expense_safety': {
    up: monthlyExpenseSafety.up,
    down: monthlyExpenseSafety.down,
  },
  '014_supplier_returns': {
    up: supplierReturns.up,
    down: supplierReturns.down,
  },
  '015_employee_profiles': {
    up: employeeProfiles.up,
    down: employeeProfiles.down,
  },
  '016_products_require_stock': {
    up: productsRequireStock.up,
    down: productsRequireStock.down,
  },
  '017_product_variants_metadata': {
    up: productVariantsMetadata.up,
    down: productVariantsMetadata.down,
  },
  '018_audit_logs': {
    up: auditLogs.up,
    down: auditLogs.down,
  },
  '019_enterprise_accounting_and_indexes': {
    up: enterpriseAccountingAndIndexes.up,
    down: enterpriseAccountingAndIndexes.down,
  },
  '020_attendance_schedule': {
    up: attendanceSchedule.up,
    down: attendanceSchedule.down,
  },
  '021_stocktake_sessions': {
    up: stocktakeSessions.up,
    down: stocktakeSessions.down,
  },
  '022_purchase_retail_pricing': {
    up: purchaseRetailPricing.up,
    down: purchaseRetailPricing.down,
  },
  '023_business_timezone_shifts_sequences': {
    up: businessTimezoneShiftsSequences.up,
    down: businessTimezoneShiftsSequences.down,
  },
  '024_stress_hardening_expenses_and_shifts': {
    up: stressHardeningExpensesAndShifts.up,
    down: stressHardeningExpensesAndShifts.down,
  },
  '025_customer_return_exchange_flag': {
    up: customerReturnExchangeFlag.up,
    down: customerReturnExchangeFlag.down,
  },
  '026_accounting_cash_basis_and_supplier_invoice_index': {
    up: accountingCashBasisAndSupplierInvoiceIndex.up,
    down: accountingCashBasisAndSupplierInvoiceIndex.down,
  },
  '027_supplier_refunds': {
    up: supplierRefunds.up,
    down: supplierRefunds.down,
  },
  '028_system_licensing': {
    up: systemLicensing.up,
    down: systemLicensing.down,
  },
  '029_system_licensing_guard': {
    up: systemLicensingGuard.up,
    down: systemLicensingGuard.down,
  },
  '030_editable_purchases_payments_expenses': {
    up: editablePurchasesPaymentsExpenses.up,
    down: editablePurchasesPaymentsExpenses.down,
  },
  '031_password_reset_tokens': {
    up: passwordResetTokens.up,
    down: passwordResetTokens.down,
  },
  '032_single_open_shift_per_store': {
    up: singleOpenShiftPerStore.up,
    down: singleOpenShiftPerStore.down,
  },
  '033_shift_reconciliation_status': {
    up: shiftReconciliationStatus.up,
    down: shiftReconciliationStatus.down,
  },
  '034_clock_reset_recovery': {
    up: clockResetRecovery.up,
    down: clockResetRecovery.down,
  },
  '035_supplier_opening_debt': {
    up: supplierOpeningDebt.up,
    down: supplierOpeningDebt.down,
  },
  '036_opening_debt_uniqueness': {
    up: openingDebtUniqueness.up,
    down: openingDebtUniqueness.down,
  },
};

export const REGISTERED_MIGRATION_NAMES: readonly string[] = Object.freeze(
  Object.keys(MIGRATION_REGISTRY),
);

export const MINIMUM_SUPPORTED_BACKUP_MIGRATION = '014_supplier_returns';

export function parseNonNegativeRowid(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
  if (typeof value === 'bigint') {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.parseInt(value.toString(), 10)
      : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    }
  }
  return 0;
}

export class DatabaseDowngradeError extends Error {
  public readonly code = 'DATABASE_DOWNGRADE_UNSUPPORTED';
  public readonly unknownMigrations: readonly string[];

  constructor(unknownMigrations: readonly string[]) {
    super(
      'قاعدة البيانات الحالية محدثة لإصدار أحدث من البرنامج ولا يمكن فتحها بهذا الإصدار الأقدم. يرجى تثبيت أحدث إصدار من رَفّ.',
    );
    this.name = 'DatabaseDowngradeError';
    this.unknownMigrations = Object.freeze([...unknownMigrations]);
  }
}

export class DatabaseMigrator {
  private readonly logger: Logger;

  constructor(private readonly db: Kysely<RetailOSDatabase>) {
    this.logger = new Logger('DatabaseMigrator');
  }

  public async getAppliedMigrationNames(): Promise<string[]> {
    const tableResult = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'
    `.execute(this.db);
    if (tableResult.rows.length === 0) {
      return [];
    }
    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(this.db);
    return rows.rows.map((r) => String(r.name ?? '')).filter(Boolean);
  }

  public async assertNoDowngrade(): Promise<void> {
    const applied = await this.getAppliedMigrationNames();
    const unknown = applied.filter(
      (name) => !Object.prototype.hasOwnProperty.call(MIGRATION_REGISTRY, name),
    );
    if (unknown.length > 0) {
      this.logger.error(
        `Detected newer database migrations unsupported by this version: ${unknown.join(', ')}`,
      );
      throw new DatabaseDowngradeError(unknown);
    }
  }

  public async getPendingMigrationNames(): Promise<string[]> {
    const applied = new Set(await this.getAppliedMigrationNames());
    return REGISTERED_MIGRATION_NAMES.filter((name) => !applied.has(name));
  }

  public async migrateToLatest(maxMigrationName?: string): Promise<{
    success: boolean;
    executedMigrations: string[];
    error?: Error;
  }> {
    await this.assertNoDowngrade();

    const migrations = maxMigrationName
      ? Object.fromEntries(
          Object.entries(MIGRATION_REGISTRY).filter(([name]) => name <= maxMigrationName),
        )
      : MIGRATION_REGISTRY;

    // Cast to Kysely<unknown> as required by Kysely's Migrator API
    const migrator = new Migrator({
      db: this.db as Kysely<unknown>,
      provider: {
        getMigrations: () => Promise.resolve(migrations),
      },
    });

    this.logger.info('Running database migrations to latest version...');
    const { error, results } = await migrator.migrateToLatest();

    const executed: string[] = [];
    results?.forEach((it) => {
      if (it.status === 'Success') {
        executed.push(it.migrationName);
        this.logger.info(`Migration '${it.migrationName}' successfully executed.`);
      } else if (it.status === 'Error') {
        this.logger.error(`Migration '${it.migrationName}' failed.`);
      }
    });

    if (error) {
      this.logger.error('Database migration failed', error as Error);
      return { success: false, executedMigrations: executed, error: error as Error };
    }

    return { success: true, executedMigrations: executed };
  }
}
