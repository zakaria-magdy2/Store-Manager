# Changelog — RetailOS

All notable changes, architectural decisions, and milestones for this project will be documented in this file.

## [Phase 7 & Phase 8 Completion: Tamper-Evident Audit Logging, Outbox CDC Sync, Desktop Host Supervisor & Full Test/Linter Expansion] - 2026-11-07

### Added
- **Phase 8 Outbox CDC Repository & Sync Worker (`@retailos/infrastructure`)**:
  - Implemented `SqliteOutboxRepository` (`packages/infrastructure/src/sync/sqlite-outbox.repository.ts`) with monotonic per-tenant `sequence_no`, idempotent event enqueueing, conflict detection (`409`), safe `BigInt` JSON serialization, pending batch queries, and tenant-scoped sync state tracking.
  - Implemented `OutboxSyncWorker` supporting batched event transport and selective acknowledgement (`markSynced`).
- **Phase 8 Desktop Host Security Policy & Supervisor (`@retailos/desktop`)**:
  - Implemented `createDesktopWindowSecurityPolicy` and `DesktopHostSupervisor` in `apps/desktop/src/index.ts`, enforcing strict `http://127.0.0.1` loopback origin validation, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, and whitelisted IPC channel dispatch (`retailos:host:status`, `retailos:sync:run-batch`, `retailos:sync:stats`, `retailos:audit:verify-chain`).
- **Comprehensive Unit & SQLite Integration Test Suites**:
  - Added `packages/application/tests/application-services.test.ts` covering `AuthService`, `TenantService`, `CatalogService`, `InventoryService`, and `CashDrawerService`.
  - Added `packages/infrastructure/tests/financial-accounting.test.ts` covering `SqlitePurchasingRepository`, `SqliteSupplierReturnRepository` (with `5090` WAC valuation variance), `SqliteReturnRepository`, `SqliteExpenseRepository`, and `SqliteRecurringExpenseRepository`.
  - Added `packages/infrastructure/tests/outbox-sync.test.ts` covering `SqliteOutboxRepository` and `OutboxSyncWorker`.
  - Added `apps/desktop/tests/desktop-host.test.mjs` covering `createDesktopWindowSecurityPolicy` and `DesktopHostSupervisor`.
- **Tamper-Evident Audit Log Engine (`018_audit_logs` & `SqliteAuditLogRepository`)**:
  - Added migration `018_audit_logs` with `audit_logs` table, database-level append-only triggers (`trg_audit_logs_immutable_update`, `trg_audit_logs_immutable_delete`), and cross-tenant isolation guard trigger (`trg_audit_logs_tenant_guard_insert`).
  - Implemented `SqliteAuditLogRepository` with canonical SHA-256 hash chaining (`previous_hash` $\rightarrow$ `entry_hash` starting from `GENESIS`), automatic recursive redaction of sensitive metadata keys (`password`, `passphrase`, `token`, `secret`, `pin`), and full chain verification (`verifyChain()`).
  - Integrated audit logging into `apps/web/server.mjs` across critical administrative, security, catalog, purchasing, POS, and backup operations, exposed via `GET /api/audit-logs` (`Permissions.AUDIT_LOG_VIEW`, restricted to `OWNER` and `AUDITOR`).
  - Added the Arabic RTL Audit Log screen (`سجل المراجعة والأمان`) in `apps/web/public/app.js` with live cryptographic chain verification status.
- **Full Operational UI & API Endpoints (`@retailos/web`)**:
  - **Thermal Receipt Printing (`GET /api/sales/:id/receipt`)**: Formats 80mm/58mm thermal receipts using `EscPosReceiptPrinter`, returning structured receipt metadata, ESC/POS raw byte payload (`escPosBase64`), and an interactive print preview modal automatically displayed after checkout and from invoice details.
  - **Multi-Store Branch Creation & Atomic Stock Transfers (`POST /api/stores`, `POST /api/inventory/transfer`)**: Enables creating new store branches (`Permissions.STORES_MANAGE`) and transferring inventory between branches (`Permissions.INVENTORY_TRANSFER`) with atomic WAC preservation and audit logging.
  - **Cash Drawer Shift Closing / Z-Report Reconciliation (`POST /api/accounting/shift-close`)**: Calculates live book balance of `1010` (`درج النقدية`), compares against counted physical cash, and posts balanced `SESSION_CLOSING` journal entries (`6090`/`1010` for shortage, `1010`/`4010` for overage).
  - **Accounting Period Close & Lock (`POST /api/accounting/periods/close`)**: Creates or locks monthly accounting periods (`YYYY-MM`, `status = 'CLOSED'`) (`Permissions.SETTINGS_MANAGE`) with audit trail entries and SQLite trigger enforcement (`019_enterprise_accounting_and_indexes`).
  - **3-Tier Cash Treasury Management (`POST /api/accounting/treasury-transfer`)**: Tracks live balances of POS Drawer (`1010`), Main Safe (`1015`), and Bank (`1020`), and enables atomic transfers between tiers with balanced `TRANSFER` journal entries.
  - **Inventory Damage Write-Off & Physical Stock Adjustment (`POST /api/inventory/damage`, `POST /api/inventory/adjust`)**: Atomically updates WAC stock positions, records immutable `stock_movements`, and posts balanced `5090`/`1300` accounting entries.
  - **Excel-Compatible UTF-8 BOM CSV Export (`GET /api/reports/export.csv`)**: Exports sales, inventory, accounting, and audit logs with UTF-8 BOM (`\uFEFF`) and CSV formula-injection sanitization.
  - **Performance & Security Hardening (`019_enterprise_accounting_and_indexes`)**: Added database-level immutability triggers for `journal_entries`, `journal_lines`, and closed `accounting_periods`, composite SQLite indexes for hot queries, eliminated N+1 queries in `/api/data`, added `AUTH_LOGIN_FAILED`/`AUTH_LOGOUT` audit logging, bounded rate-limiting map memory, and automatic expired/revoked session pruning.

### Fixed & Hardened
- **Dynamic Migration Registry for Encrypted Backups (`@retailos/infrastructure`)**:
  - Extracted `MIGRATION_REGISTRY` (`001_initial_foundation` through `018_audit_logs`), `REGISTERED_MIGRATION_NAMES`, and `MINIMUM_SUPPORTED_BACKUP_MIGRATION` in `migrator.ts`.
  - Replaced the brittle hardcoded migration allowlist (`['014_supplier_returns', '015_employee_profiles']`) in `sqlite-backup.service.ts` with `isSupportedBackupMigrationHistory()`, fixing backup export/restore verification on schemas migrated through `018_audit_logs`.
- **SQLite Concurrency, WAL Checkpointing & Unit of Work (`@retailos/infrastructure`)**:
  - Hardened `SqliteDatabaseManager` with `busy_timeout = 10000`, `wal_autocheckpoint = 1000`, `temp_store = MEMORY`, and `checkpointPassive()` for non-blocking WAL maintenance.
  - Added `SqliteUnitOfWork` (`unit-of-work.ts`) implementing the `UnitOfWork` port from `@retailos/application` with `AsyncLocalStorage` re-entrancy and serialized write transactions.
- **Web Server Error Mapping & Endpoint Guards (`@retailos/web`)**:
  - Mapped `DomainError` instances (`InsufficientStockError`, `InvalidSaleError`, `InvalidCartError`, `InvalidPaymentError`, etc.) to HTTP `400` instead of `500` in `apps/web/server.mjs`.
  - Enforced `Permissions.INVENTORY_RECEIVE` check before returning `410` on deprecated direct `/api/inventory/receive` routes so unauthorized callers receive `403`.
  - Added periodic passive WAL checkpointing and clean checkpoint-on-shutdown in `apps/web/server.mjs`.
  - Replaced date-brittle assertions in `apps/web/tests/app-flow.test.mjs` with dynamic UTC date calculations, purchase-linked stock receipt checks, and audit chain assertions.
  - Ignored `apps/web/.test-data-*/` and `apps/web/data/` in `.gitignore`.

### Verification
- `pnpm run typecheck`: 9/9 tasks passed (0 errors).
- `pnpm run lint`: 6/6 tasks passed (0 errors, 0 warnings).
- `pnpm run test`: 75/75 tests passed (30 core, 5 application, 33 infrastructure, 2 desktop, 5 web end-to-end integration).
- `pnpm run build`: 6/6 tasks passed (`apps/web/dist` and `apps/desktop/dist` built and verified with 0 warnings).

## [Employee Contact and Profile Details] - 2026-11-04

### Added
- Added employee phone numbers and employment start dates to account creation and persistence. Migration `015_employee_profiles` backfills existing accounts' start date from their original creation date.
- Made employee names open a profile with username, role, branch, active status, account creation time, employment start date, and editable phone/start-date fields.
- Kept backup restore compatible with both the prior `014_supplier_returns` schema and the current `015_employee_profiles` schema; restored prior backups are upgraded by normal startup migrations.
- Added SQLite web integration coverage for creating, listing, and updating employee contact and start-date details.

### Verification
- Infrastructure tests passed (26/26), including legacy employee-date backfill; web SQLite integration passed (1/1); lint and typecheck passed.

## [Cashier Access Boundaries] - 2026-11-04

### Changed
- Restricted cashier accounts to point-of-sale checkout and sellable catalog lookup. Cashiers land directly in POS and see no accounting, expense, supplier, inventory-management, sales-report, backup, or user-management navigation.
- Removed cashier permissions for discounts, refunds, cash drawer administration, and direct expense entry. Only active products and variants are shown for checkout; checkout continues to reject inactive items server-side.
- Redacted supplier balances, purchase/payment history, accounting entries, expense data, monthly obligations, and inventory cost valuation from cashier API responses.
- Enforced catalog-management and inventory-receipt permissions in their API routes, closing direct-request paths that bypass hidden UI controls.
- Added role and web integration assertions for cashier redaction and denied administrative actions.

### Verification
- Workspace lint and typecheck passed; all 57 tests passed. The focused web integration test passed again after the final active-item display filter, and the production web build succeeded.

## [Runnable Local Store App and Supplier Ledger] - 2026-11-04

### Added
- Added temporary-database integration coverage for successful restore, wrong-passphrase and foreign-company rejection, interrupted swap recovery, and rollback snapshot recovery; fixed recovery to use the rollback snapshot when the active file is damaged.
- Added owner-only encrypted SQLite restore with same-company and supported-schema checks, integrity and foreign-key verification, staged database replacement, rollback snapshot, startup recovery after interruption, session invalidation, upload bounds, and an explicit replacement confirmation in the UI.
- Added owner-only encrypted SQLite backup downloads. Snapshots use the SQLite online backup API, AES-256-GCM with a user-chosen passphrase, and integrity plus foreign-key checks before export.
- Added a permission-scoped profit and loss report with custom date ranges (up to one year), an eight-step sales-to-operating-profit breakdown, exact monthly expense amortization, warnings for unconfirmed recurring expense actuals, and a separate cash-flow panel. Supplier-return cost variances are included in cost of goods sold.
- Added supplier returns tied to original purchase lines. Returns restore no stock; they decrease stock using current weighted average cost, credit the supplier at invoice cost, and post any valuation difference to a dedicated account. Return quantities are capped at the unreturned invoice quantity, and idempotency and immutable history are enforced. Supplier credits are reflected in balances and return history.
- Added migration `013_monthly_expense_safety`, recurring monthly obligation
  templates, one-time monthly actual confirmation, and partial settlement from
  cash drawer, safe, or bank. Accrual debits expense and credits accrued
  liabilities; payments settle that liability without booking expense again.
- Added database safeguards for immutable confirmed values, monotonic payments,
  append-only monthly payment records, and template idempotency.
- Branded the customer-facing application **رَفّ**. Company and main-store
  identity now come from deployment configuration; the first-run screen creates
  only the store owner's login.
- Added a dedicated supplier and purchases screen with supplier records,
  purchase invoice totals, initial payments, later partial payments, payment
  references, and remaining balances.
- Added migration `007_suppliers_purchases` with tenant and store guards plus
  append-only purchase and payment history.
- Added an end-to-end SQLite test for provisioning, login, supplier invoices,
  partial payments, overpayment rejection, inventory receipt, and checkout.
- Added migration `010_supplier_journal_idempotency` and balanced journal
  posting for supplier invoices, payments, and POS sales within their source
  transactions. The accounting view shows posted source and debit/credit totals.
- Added direct operating expense entry with migration `011_expense_idempotency`,
  atomic balanced journal posting, payment source selection, and duplicate request
  protection. Expense list and accounting view are permission-scoped.
- Added migration `012_customer_returns` and partial customer returns linked to
  original sale lines. Returned quantities cannot exceed the sold balance;
  refunds use the original discounted line value, stock returns at original
  WAC, and journal/inventory updates commit atomically. Added returns history.

### Scope
- Multi-line supplier invoices now record invoice items, WAC stock receipts,
  purchase history, and initial payment in one SQLite transaction. Later
  payments remain append-only and cannot exceed the outstanding amount.
- Catalog entries can be stock-tracked products or non-stock services sold
  through POS. Product returns for services remain unsupported.
- Purchase, payment, sales, direct expense, and customer return journals post
  atomically. Recurring expense accruals and supplier returns remain pending.
- Company name, code, currency, and store name can be supplied through
  deployment environment settings; end users do not create company tenants.

### Verification
- Web end-to-end integration: 1/1 passed.
- Workspace lint passed; typecheck passed (8/8 tasks); 52 tests passed; build
  passed (6/6 tasks). Turbo reports the existing desktop Phase 8 no-output
  warning because that package is still a placeholder.

## [Security Hardening Baseline] - 2026-11-03

### Established
- Added `docs/SECURITY_POLICY.md` with an ASVS-aligned baseline, secure
  engineering rules, release controls, and prioritized security risks.
- Added CI CodeQL analysis, production dependency audits, and vulnerable
  dependency review. Repository settings must require these checks and enable
  secret scanning/push protection where available.
- Hardened session validation to revoke expired, inactive, tenant-disabled, or
  user-scope-mismatched sessions.
- Guarded tenant-owned repository upserts against cross-tenant identifier
  collisions and added session/user isolation regression coverage.
- Added migration `006_tenant_relationship_guards`, which checks for existing
  company-scope violations and blocks invalid links across identity, catalog,
  inventory, accounting, outbox, and POS rows at the database layer.
- Added migrated SQLite integration coverage for cross-scope user, product,
  variant, inventory, journal-line, and outbox relationships.
- Recorded ADR-014: one installation and database per company; internal company
  scope remains an integrity boundary rather than a shared-customer hosting model.
- Updated `README.md`, `PROJECT_CONTEXT.md`, `PROJECT_DOCUMENTATION_POLICY.md`,
  `docs/QUALITY_GATES.md`, `docs/MASTER_ROADMAP_AND_VISION.md`,
  `docs/SECURITY_POLICY.md`, and `docs/architecture/ARCHITECTURE_DECISIONS.md`.

### Verification Results
- `pnpm run lint`: passed with zero warnings/errors.
- `pnpm run typecheck`: passed (8/8 tasks).
- `pnpm test`: passed (51 tests: 30 core, 1 application, 20 infrastructure).
- `pnpm run build`: passed (6/6 tasks; web/desktop remain Phase 8 placeholders and Turbo reports their configured no-output warning).

## [Engineering Quality Gates] - 2026-11-03

### Established
- Added `docs/QUALITY_GATES.md` defining ESLint requirements, unit-test boundaries,
  SQLite integration-test expectations, and the four required merge commands.
- Added a GitHub Actions workflow that runs lint, typecheck, tests, and build on
  every push and pull request.
- Enabled Vitest in `@retailos/application` and added a unit test for checkout
  catalog snapshots and application-port orchestration.
- Added `packages/application/tsconfig.eslint.json` so application tests receive
  the same type-aware lint checks as source files.

### Verification Results
- 48/48 tests passed: 30 core, 1 application, and 17 infrastructure tests.
- Workspace typecheck passed (8/8 tasks); lint passed with zero warnings/errors.
- Workspace build passed (6/6 tasks; desktop and web report intentional Phase 8
  placeholder output warnings).

---

## [Phase 3: Product Catalog, Dynamic Attributes & WAC Inventory] - 2026-11-01

### Implemented & Verified
- **Core Domain Catalog (`@retailos/core`)**:
  - Implemented `Category` (nested), `Product`, and `ProductVariant` entities. Every sellable unit is a variant; simple products use one default variant so inventory, pricing, and barcode lookup share a single code path.
  - Dynamic, industry-agnostic attributes stored as validated JSON primitives (`string | number | boolean`) with safe key normalization, finite-number checks, and strict parse/serialize round-tripping.
  - Added `CATALOG_MANAGE` permission to `STORE_MANAGER` and `OWNER`.
- **WAC Inventory Engine (`@retailos/core`)**:
  - `calculateWeightedAverageCost` implements the GAAP/IFRS formula with exact integer numerator/denominator arithmetic.
  - Zero/negative-quantity receipts replace the WAC entirely (no meaningless weighted history).
  - New `Money.divideBy(divisor, roundingMode)` uses Half-Even by default, so fractional minor units are neither dropped nor invented.
  - `InventoryPosition` is an immutable stock partition that preserves WAC on issues and optionally permits negative stock.
  - `StockMovement` is an immutable ledger entry carrying the receipt cost or the prevailing WAC snapshot on issues.
  - Tenant-level `allowNegativeStock` policy (strict prohibition by default).
- **Application Layer (`@retailos/application`)**:
  - Added catalog and inventory repository ports plus `CatalogService` (category/product/variant creation, barcode lookup, tenant-scoped SKU/barcode uniqueness) and `InventoryService` (receive, sale + COGS snapshot, customer/supplier returns, damage, adjustments, transfers, movement history).
  - Every stock operation re-reads the tenant negative-stock policy and enforces store scoping from the execution context.
- **Persistence (`@retailos/infrastructure`)**:
  - Migration `003_catalog_inventory` adds `categories`, `products`, `product_variants`, `inventory_items`, `stock_movements`, and the `tenants.allow_negative_stock` column, with tenant-scoped unique indexes.
  - `BEFORE UPDATE` / `BEFORE DELETE` triggers reject any mutation of `stock_movements`; corrections must be compensating entries.
  - Added `SqliteCategoryRepository`, `SqliteProductRepository`, `SqliteProductVariantRepository`, `SqliteInventoryRepository` (atomic WAC updates and two-phase transfers inside a single transaction), and `SqliteStockMovementRepository`.
  - Added `toBigInt` boundary normalization because better-sqlite3 returns runtime integers as JS numbers while Kysely types them as `bigint`.
- **Shared Contracts (`@retailos/shared`)**:
  - Added `CategoryDTO`, `ProductDTO`, `ProductVariantDTO`, `InventoryPositionDTO`, `StockMovementDTO`, and transfer/operation result DTOs.
  - Added Zod schemas for category/product/variant creation and stock receive/sale/adjust/transfer inputs.

### Fixed
- `ValueObject.equals` no longer uses `JSON.stringify`, which throws on `bigint` and made `Money` comparison unusable.
- `Money.fromDecimal` now rounds excess decimal digits with Half-Even instead of silently truncating.
- Session row ids are derived from the SHA-256 token hash instead of `Math.random()`.
- `TenantService.createUser` can no longer omit or mismatch a store for store-bound actors and can no longer mint another `OWNER` without OWNER authority.
- Upgraded `better-sqlite3` to `13.0.3` (Node 24 compatible) and made `SqliteDatabaseManager.close()` async so the Kysely pool is destroyed; the previous partial teardown caused native process crashes during multi-file test runs.

### Verification Results
- 42/42 Vitest tests passing (28 in `@retailos/core`, 14 in `@retailos/infrastructure`).
- Typecheck: 8/8 tasks passed with 0 errors.
- Lint: 4/4 packages passed with 0 errors and 0 warnings.
- Build: 6/6 tasks passed.

---

## [Phase 2: Identity, RBAC, Multi-Tenancy & Store Assignment] - 2026-11-01

### Implemented & Verified
- **Core Domain Identity (`@retailos/core`)**:
  - Implemented `Tenant`, `Store`, and `User` domain entities.
  - Defined system roles: `OWNER`, `STORE_MANAGER`, `CASHIER`, `AUDITOR`.
  - Implemented granular permissions map (`Permissions`) and role resolution (`getPermissionsForRole`).
  - Enforced domain invariants (e.g. Cashier role strictly requires a store assignment).
- **Security & Authentication Engine (`@retailos/infrastructure`)**:
  - Implemented `Argon2PasswordHasher` leveraging native `@node-rs/argon2` with high-security parameters (memoryCost: 19MB, timeCost: 2, outputLen: 32).
  - Implemented `CryptoTokenService` generating 256-bit cryptographically secure session tokens hashed with SHA-256 for secure storage.
  - Added migration `002_identity_sessions` introducing `sessions` table and `store_id` reference on `users`.
- **Multi-Tenant & Store Isolation**:
  - Implemented `SqliteTenantRepository`, `SqliteStoreRepository`, `SqliteUserRepository`, and `SqliteSessionRepository`.
  - Enforced strict tenant boundary: all lookups, inserts, and updates require matching caller `tenantId`.
  - Implemented store authorization: Store Managers and Cashiers cannot access or assign users to stores outside their assigned store.
- **Application Services (`@retailos/application`)**:
  - `AuthService`: `login` with Argon2 verification, session token issuance, `validateSession` returning an immutable `ScopedExecutionContext`, and `logout` session revocation.
  - `TenantService`: Multi-tenant tenant/store/user provisioning with permission verification.
- **Shared Contracts (`@retailos/shared`)**:
  - Added `TenantDTO`, `StoreDTO`, `UserDTO`, `AuthSessionDTO`.
  - Added Zod validation schemas: `LoginSchema`, `CreateTenantSchema`, `CreateStoreSchema`, `CreateUserSchema`.
- **Verification Results**:
  - 20/20 Vitest tests passing (14 in `@retailos/core`, 6 in `@retailos/infrastructure`).
  - Zero TypeScript compiler errors across all workspace packages.
  - Zero ESLint warnings or errors across the entire codebase.

---

## [Phase 1: Project Foundation & Core Domain] - 2026-11-01

### Implemented & Verified
- **Monorepo Architecture (pnpm v12 + Turborepo v2)**:
  - Configured workspace packages: `@retailos/tsconfig`, `@retailos/core`, `@retailos/shared`, `@retailos/application`, `@retailos/infrastructure`, apps placeholders.
  - Setup unified pipeline scripts: `build`, `typecheck`, `test`, `lint`, and `clean`.
- **Strict TypeScript Setup**:
  - `NodeNext` ESM module resolution with `"type": "module"`.
  - Configured maximum compiler strictness: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strictNullChecks`, `noImplicitAny`.
- **Core Domain Layer (`@retailos/core`)**:
  - Zero external runtime dependencies (framework-free, DB-free, Electron-free).
  - Implemented `Money` Value Object:
    - Currency-aware minor unit storage (`bigint`).
    - Multi-decimal support (0 decimals for JPY, 2 for USD/EGP/SAR/EUR, 3 for KWD/BHD/JOD/OMR).
    - Half-Even rounding (Banker's Rounding) for multiplication.
    - Hamilton-Hare (Largest Remainder) discount allocation for whole-cart discounts.
    - Integer-safe daily amortization of confirmed monthly expenses across 28/29/30/31 days without losing minor units.
  - Functional error hierarchy and type-safe `Result<T, E>` monad.
- **Shared Contracts (`@retailos/shared`)**:
  - Implemented `DailyPerformanceReportDTO` with the approved 8-tier profit progression and decoupled cash flow panel.
  - Added Zod schemas for direct daily and monthly expense confirmations.
- **Application Core Abstractions (`@retailos/application`)**:
  - Implemented `ExecutionContext` and `ScopedExecutionContext` for tenant-scoped operations, role validation, and permission checks.
  - Defined `BaseRepository` and `UnitOfWork` ports.
- **Infrastructure & Database Engine (`@retailos/infrastructure`)**:
  - Implemented `SqliteDatabaseManager` with automatic WAL mode, NORMAL synchronous mode, 5000ms busy timeout, and foreign key constraint enforcement.
  - Created initial schema migration (`001_initial_foundation`) defining 12 core tables:
    - `tenants`, `stores`, `users`, `accounts`, `accounting_periods`, `journal_entries`, `journal_lines`, `expense_categories`, `recurring_expense_obligations`, `monthly_expense_actuals`, `operating_expense_records`, `outbox_events`.
  - Built Kysely-based `DatabaseMigrator`.
  - Structured JSON `Logger` with automatic sensitive key sanitization (`password`, `token`, `secret`, `pin`).
- **Tooling & Code Quality**:
  - ESLint flat configuration with custom AST safety rules strictly banning floating-point coercions (`parseFloat`, `Number()`, non-safe `Math` functions) on financial fields.
  - Prettier configuration.
- **Verification Results**:
  - Build: 6/6 tasks passed.
  - Typecheck: 8/8 tasks passed with 0 errors.
  - Tests: 11/11 Vitest tests passed (9 core tests, 2 infrastructure integration tests).
  - Lint: 4/4 packages passed with 0 errors and 0 warnings.

---

## [Phase 0: Architecture Blueprint v2.5] - 2026-11-01

### Added & Formalized
- **ADR-011 Updated (Upfront Monthly Entry & Zero Fictitious Values)**:
  - Eliminated `PROVISIONAL_ESTIMATED` status, estimated baseline logic, and retroactive redistributions.
  - User confirms actual monthly expense values at the start of each month.
  - Implemented non-fabricated missing expense handling: un-entered expenses calculate as $0.00$ with an actionable dashboard warning banner.
  - Preserved single monthly general ledger accrual entry, presentation-layer daily amortization, and cash flow payment decoupling.
- Updated `docs/architecture/retailos_architecture_blueprint.md`, `PROJECT_CONTEXT.md`, and `docs/architecture/ARCHITECTURE_DECISIONS.md`.

---

## [Phase 0: Architecture Blueprint v2.4] - 2026-11-01

### Added & Formalized
- **Operating Expense Confirmation Lifecycle & Double-Track Architecture**:
  - Delineated General Ledger entries from Presentation-Layer daily amortization.
  - Formulated universal anti-double-counting across Daily, Custom Range, Monthly, and Annual reporting scopes.

---

## [Phase 0: Architecture Blueprint v2.3] - 2026-11-01

### Added & Formalized
- **ADR-011 (Operating Expense Amortization & Cash Decoupling)**:
  - Decomposed daily operating expenses into Direct Daily Expenses and Daily Amortized Monthly Recurring Expenses.
  - Decoupled Accrual Operating Profit from the Cash Liquidity Panel.
- **8-Tier Daily Sales & Profit Progression**:
  - 1. Gross Sales $\rightarrow$ 2. Discounts & Returns $\rightarrow$ 3. Net Sales $\rightarrow$ 4. COGS $\rightarrow$ 5. Gross Profit $\rightarrow$ 6. Direct Daily Expenses $\rightarrow$ 7. Daily Amortized Monthly Expenses $\rightarrow$ 8. Operating Profit.

---

## [Phase 0: Project Inception & Architecture v2.2] - 2026-11-01

### Added
- Created `PROJECT_CONTEXT.md`, `PROJECT_DOCUMENTATION_POLICY.md`, `docs/architecture/ARCHITECTURE_DECISIONS.md`, and initial blueprint.
