# Changelog — RetailOS

All notable changes, architectural decisions, and milestones for this project will be documented in this file.

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
