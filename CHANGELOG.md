# Changelog — RetailOS

All notable changes, architectural decisions, and milestones for this project will be documented in this file.

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
