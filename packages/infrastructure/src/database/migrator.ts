import type { Kysely, Migration } from 'kysely';
import { Migrator } from 'kysely';
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
};

export const REGISTERED_MIGRATION_NAMES: readonly string[] = Object.freeze(
  Object.keys(MIGRATION_REGISTRY),
);

export const MINIMUM_SUPPORTED_BACKUP_MIGRATION = '014_supplier_returns';

export class DatabaseMigrator {
  private readonly logger: Logger;

  constructor(private readonly db: Kysely<RetailOSDatabase>) {
    this.logger = new Logger('DatabaseMigrator');
  }

  public async migrateToLatest(): Promise<{
    success: boolean;
    executedMigrations: string[];
    error?: Error;
  }> {
    // Cast to Kysely<unknown> as required by Kysely's Migrator API
    const migrator = new Migrator({
      db: this.db as Kysely<unknown>,
      provider: {
        getMigrations: () => Promise.resolve(MIGRATION_REGISTRY),
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
