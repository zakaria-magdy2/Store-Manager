# RetailOS — Master Vision, Historical Blueprint & Execution Roadmap

> **Document Status**: Active Master Reference  
> **Target Audience**: Software Architects, Lead Engineers, and Core Contributors  
> **Last Updated**: November 2026 (Reflecting Phase 0, 1, 2, and 3 Completion)  

---

## 1. Executive Vision & Ultimate Product Goal

### 1.1 What is RetailOS?
**RetailOS** is an enterprise-grade, offline-capable, local-first Universal Retail Management System. It is engineered from first principles to solve the fundamental dilemma of modern retail software:

1. **Cloud POS systems** fail when internet connectivity fluctuates, introduce latency at checkout, and impose costly mandatory cloud subscriptions.
2. **Traditional legacy desktop POS systems** lack multi-store capabilities, suffer from database corruption during power outages, use inaccurate floating-point math, and cannot synchronize across modern web/mobile interfaces.

RetailOS bridges this divide by delivering a **local-first, zero-cloud-dependency engine** that operates at native hardware speeds on a single cashier terminal, while providing built-in distributed synchronization capabilities to scale to multi-store retail chains and centralized cloud dashboards.

### 1.2 Core Pillars & Design Philosophy

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        RETAILOS CORE PILLARS                           │
├──────────────────┬──────────────────┬─────────────────┬────────────────┤
│ 1. Local-First   │ 2. Financial     │ 3. Universal    │ 4. Strict Data │
│    & Zero Latency│    Accuracy      │    Catalog      │    Isolation   │
├──────────────────┼──────────────────┼─────────────────┼────────────────┤
│ • Offline native │ • BigInt minor   │ • Dynamic EAV   │ • Multi-tenant │
│ • SQLite WAL mode│   units only     │   attributes    │   by default   │
│ • Barcode <15ms  │ • Double-entry   │ • Apparel, tech │ • Partitioned  │
│ • Checkout <60ms │ • GAAP/IFRS WAC  │   food & pharma │   store stocks │
└──────────────────┴──────────────────┴─────────────────┴────────────────┘
```

1. **Local-First Speed (<60ms Checkout)**: All write paths (scanning, adding items, applying discounts, checking out) execute against local SQLite in Write-Ahead Logging (WAL) mode. The cashier never waits for network handshakes.
2. **Uncompromising Financial Precision**: Absolutely zero floating-point arithmetic (`Number`, `parseFloat`). Every monetary value is stored as an arbitrary-precision integer (`BigInt`) in currency minor units (cents, millimes, yen) paired with Banker's Rounding (Half-Even).
3. **Universal Industry-Agnostic Catalog**: A flexible product schema supporting variable attributes (sizes, colors, expiry dates, batch/lot numbers, serial numbers) without requiring code modifications per industry.
4. **GAAP/IFRS Compliant Inventory (WAC)**: Weighted Average Cost valuation where every sale item captures an immutable `unit_cost_snapshot` at the exact second of sale, guaranteeing 100% audit accuracy for Cost of Goods Sold (COGS).
5. **Double-Entry Sub-Ledger**: Every operational transaction (sale, return, damage write-off, expense payment) creates an immutable, balanced journal entry ($\sum \text{Debits} = \sum \text{Credits}$).
6. **Transparent Sales & Profit Reporting**: A standardized 8-tier progression separating Gross Sales, Discounts, Net Sales, COGS, Gross Profit, Direct Daily Expenses, Daily Amortized Monthly Obligations, and Operating Profit.

---

## 2. Master Progress Summary (Where We Are Today)

| Milestone | Scope | Status | Verifiable Deliverables |
| :--- | :--- | :---: | :--- |
| **Phase 0** | Architecture Analysis, Threat Modeling & Blueprint v2.5 | **COMPLETED** | Blueprint v2.5, ADR-001 through ADR-011, threat model. |
| **Phase 1** | Monorepo Setup, Strict TypeScript, Core Domain & Database Migrations | **COMPLETED** | pnpm + Turborepo, `@retailos/core` (Money VO, Banker's Rounding, Hamilton-Hare), SQLite WAL manager, 12 tables, 11 tests. |
| **Phase 2** | Identity, RBAC, Multi-Tenancy & Store Assignment | **COMPLETED** | Argon2id hasher, SHA-256 session tokens, RBAC roles & permissions, repository tenant boundaries, 20 tests. |
| **Phase 3** | Product Catalog, Dynamic Attributes & WAC Inventory | **COMPLETED** | Migration 003, JSON variant attributes, WAC engine, DB-enforced append-only ledger, atomic transfers, 42/42 tests. |
| **Phase 4** | POS Checkout, Fast Cart & Peripheral Hardware | **NEXT** | Barcode lookup, cart state machine, receipt printer ESC/POS, cash drawer trigger. |
| **Phase 5** | Financial Accounting, Expense Tracking & Cash Management | PLANNED | Sub-ledger postings, 3-tier cash flows (Drawer/Safe/Bank), monthly actuals tracker. |
| **Phase 6** | Backup, Disaster Recovery & Security Hardening | PLANNED | SQLite Online Backup API, 4-stage atomic swap, corruption recovery marker. |
| **Phase 7** | Dashboards, Analytics & Audit Logging | PLANNED | 8-Tier P&L engine, custom date ranges, drill-downs, tamper-evident audit log. |
| **Phase 8** | Electron Desktop Packaging & Web Deployment | PLANNED | Electron context-isolation, React POS UI, offline synchronization daemon. |

---

## 3. Deep-Dive: Completed Phases (Technical Record)

### Phase 0: Architecture Blueprint v2.5 (Completed)
- **Problem Defined**: Solved how monthly recurring obligations (rent, electricity, salaries) interact with daily profit calculations without inventing fictitious data or corrupting past closed periods.
- **Key Decision (ADR-011)**: Upfront monthly actual confirmation at month start $\rightarrow$ single monthly general ledger accrual entry $\rightarrow$ presentation-layer daily amortization $\rightarrow$ missing months display as $0.00$ with actionable warning banners.
- **Artifact**: [`docs/architecture/retailos_architecture_blueprint.md`](file:///d:/Store%20Manager/docs/architecture/retailos_architecture_blueprint.md).

### Phase 1: Project Foundation & Core Domain (Completed)
- **Monorepo**: Turbo v2 + pnpm v12 with strict package boundaries (`packages/core`, `packages/shared`, `packages/application`, `packages/infrastructure`, `packages/tsconfig`).
- **Strict TypeScript**: `NodeNext` ESM, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`.
- **Pure Core Domain (`@retailos/core`)**: Zero runtime external dependencies.
  - `Money` Value Object storing `amount: bigint` in currency-aware minor units. Supports 0 decimals (JPY), 2 decimals (USD/EUR/EGP/SAR), 3 decimals (KWD/BHD/JOD).
  - Half-Even rounding (Banker's Rounding) for multiplication.
  - Hamilton-Hare (Largest Remainder) whole-cart discount distributor.
  - Integer-safe daily amortization of monthly expenses across 28/29/30/31 days without losing minor units.
- **Database Engine (`@retailos/infrastructure`)**:
  - `better-sqlite3` compiled natively with WAL mode, `synchronous = NORMAL`, and `foreign_keys = ON`.
  - Migration runner with 12 foundational tables: `tenants`, `stores`, `users`, `accounts`, `accounting_periods`, `journal_entries`, `journal_lines`, `expense_categories`, `recurring_expense_obligations`, `monthly_expense_actuals`, `operating_expense_records`, `outbox_events`.
- **Linter & Security**: ESLint flat config with custom AST rules banning floating-point coercions (`parseFloat`, `Number()`) on financial properties.

### Phase 2: Identity, RBAC, Multi-Tenancy & Store Assignment (Completed)
- **Argon2id Hashing**: Native `@node-rs/argon2` (memoryCost: 19MB, timeCost: 2) in [`argon2-password-hasher.ts`](file:///d:/Store%20Manager/packages/infrastructure/src/security/argon2-password-hasher.ts).
- **Session Security**: Cryptographically secure 256-bit token generator (`CryptoTokenService`) with SHA-256 token hashing for lookup and revocation.
- **Database Expansion**: Migration `002_identity_sessions` adding `sessions` table and `users.store_id`.
- **Multi-Tenant Repositories**: `SqliteTenantRepository`, `SqliteStoreRepository`, `SqliteUserRepository`, `SqliteSessionRepository`.
  - Every query enforces `tenant_id = ctx.tenantId`.
  - Cross-tenant data tampering raises `TenantIsolationViolation`.
- **RBAC Matrix**: Built-in roles (`OWNER`, `STORE_MANAGER`, `CASHIER`, `AUDITOR`) with granular permission sets. Cashiers are strictly bound to a designated store.

### Phase 3: Product Catalog, Dynamic Attributes & WAC Inventory (Completed)
- **Universal Catalog (`@retailos/core`)**: `Category`, `Product`, and `ProductVariant` entities. Every sellable unit is a variant; simple products use a single default variant so pricing, barcode lookup, and inventory share one code path.
- **Dynamic Attributes**: Validated JSON primitive maps (`string | number | boolean`) stored in `attributes_json`, with key normalization, finite-number checks, and strict parse/serialize round-tripping. No schema change is required per retail vertical.
- **WAC Engine**: `calculateWeightedAverageCost` uses exact integer numerator/denominator arithmetic; zero or negative current quantities replace the WAC entirely; `Money.divideBy` defaults to Half-Even so fractional minor units are neither dropped nor invented.
- **Stock Ledger**: `StockMovement` is an immutable entry carrying either the receipt cost or the prevailing WAC snapshot on issues. Movement types: `PURCHASE_RECEIPT`, `SALE`, `CUSTOMER_RETURN`, `SUPPLIER_RETURN`, `TRANSFER_OUT`, `TRANSFER_IN`, `INVENTORY_ADJUSTMENT`, `DAMAGE_WRITE_OFF`.
- **Database Expansion**: Migration `003_catalog_inventory` adds `categories`, `products`, `product_variants`, `inventory_items`, `stock_movements`, and `tenants.allow_negative_stock`. `BEFORE UPDATE` and `BEFORE DELETE` triggers on `stock_movements` raise `stock_movements is append-only: corrections must be compensating entries`.
- **Application Services**: `CatalogService` (tenant-scoped category/product/variant creation, barcode lookup, SKU/barcode uniqueness) and `InventoryService` (receipts, sales with COGS snapshot, customer/supplier returns, damage, adjustments, atomic two-phase store transfers, movement history).
- **Tenant Policy**: Negative stock is prohibited by default and only permitted when the tenant explicitly enables `allowNegativeStock`; store-bound actors are restricted to their assigned store.
- **Tests**: 14 new core tests and 8 new infrastructure integration tests (barcode resolution, tenant isolation, WAC + COGS, append-only enforcement, negative-stock policy, atomic transfers, damage/returns/adjustments, store scoping).

---

## 4. Master Forward Execution Plan: Phases 4 through 8

### Phase 4: POS Checkout, Fast Cart & Peripheral Drivers

#### Goal:
High-speed cashier checkout terminal capable of offline operations, instant barcode lookup, discount applications, multi-tender payments, and receipt printing.

#### Architecture Components:
1. **Cart Domain Model (`packages/core/src/pos/cart.ts`)**:
   - Immutable cart state with line items, line discounts, whole-cart discounts, and returns.
   - Hamilton-Hare discount redistribution across eligible line items.
2. **Checkout Service (`packages/application/src/pos/checkout.service.ts`)**:
   - Atomic unit-of-work: validates stock $\rightarrow$ locks stock $\rightarrow$ creates sale order $\rightarrow$ creates stock movement with historical WAC snapshot $\rightarrow$ creates double-entry journal entry $\rightarrow$ records cash drawer inflow $\rightarrow$ returns finalized receipt.
3. **Hardware Adapters (`packages/infrastructure/src/hardware/`)**:
   - `EscPosReceiptPrinter`: Formatter generating raw ESC/POS byte streams for thermal 80mm/58mm USB/Network receipt printers.
   - `CashDrawerDriver`: Sends the standard kick pulse (`ESC p 0 25 250`) via the receipt printer DK port.
   - `BarcodeScannerListener`: Virtual keyboard wedge parser with configurable debounce and suffix detection.

---

### Phase 5: Financial Sub-Ledger, Expense Tracking & Cash Management

#### Goal:
Implement the complete double-entry accounting engine, 3-tier cash movements (POS Drawer, Safe, Bank), operating expense records, and upfront monthly expense confirmation.

#### Architecture Components:
1. **Double-Entry Journal Posting Service (`packages/application/src/accounting/`)**:
   - Enforces balanced entries: $\sum \text{Debits} == \sum \text{Credits}$.
   - Immutable journal lines: posted entries are never updated or deleted; corrections are made via full reversing journal entries.
2. **3-Tier Cash Treasury Manager (`packages/application/src/accounting/treasury.service.ts`)**:
   - POS Drawer $\leftrightarrow$ Store Safe transfers (e.g. daily drawer drop).
   - Store Safe $\leftrightarrow$ Bank Account deposits.
   - Drawer opening/closing reconciliation with expected cash vs. actual counted cash and variance posting.
3. **Operating Expenses Engine (`packages/application/src/accounting/expenses.service.ts`)**:
   - Record Direct Daily Expenses (`Debit 60xx / Credit 1011 Drawer or 1012 Safe`).
   - Confirm Monthly Recurring Expense Actuals upfront at month start (`Debit 60xx / Credit 2020 Accrued Liabilities`).
   - Pay Monthly Obligations (`Debit 2020 Accrued Liabilities / Credit 1012 Safe or 1020 Bank`).

---

### Phase 6: Backup, Disaster Recovery & Security Hardening

#### Goal:
Zero-corruption backup automation and fail-safe recovery mechanism capable of withstanding unexpected power loss during operation.

#### Architecture Components:
1. **Backup Service (`packages/infrastructure/src/backup/`)**:
   - Utilizes SQLite Online Backup API (`rawDb.backup()`) to create consistent snapshot files without locking writers or readers.
   - Checkpoints WAL log prior to backup (`wal_checkpoint(TRUNCATE)`).
   - Encrypts backup archives using AES-256-GCM with a tenant-controlled master key.
2. **4-Stage Atomic Recovery & Rollback Engine**:
   - Stage 1: Validate archive integrity, decryption, and SQLite schema version.
   - Stage 2: Create a crash-recovery marker file (`.restoring_marker`) and backup the current active database to a `.rollback` staging copy.
   - Stage 3: Perform atomic filesystem swap of the database and WAL files.
   - Stage 4: Run SQLite integrity check (`PRAGMA integrity_check`). If it fails, restore the rollback copy instantly. Upon success, remove the marker.

---

### Phase 7: Dashboards, Advanced Analytics & Audit Logging

#### Goal:
Deliver the official 8-Tier Sales & Profit Performance Report, date-range filtering, and tamper-evident audit logs.

#### Architecture Components:
1. **Performance Report Query Service (`packages/application/src/reporting/`)**:
   - Computes:
     1. Gross Sales
     2. Discounts & Returns
     3. Net Sales
     4. Cost of Goods Sold (COGS)
     5. Gross Profit
     6. Direct Daily Operating Expenses
     7. Daily Amortized Share of Confirmed Monthly Obligations
     8. Net Operating Profit
   - Produces decoupled Cash Liquidity Panel (Cash from sales, electronic funds, expense payouts, pending liabilities).
   - Generates warning banners if any monthly obligation for the period is unconfirmed (never calculates fabricated numbers).
2. **Tamper-Evident Audit Logger (`packages/infrastructure/src/audit/`)**:
   - Hash-chained audit trail of all sensitive operations (logins, price changes, stock adjustments, voided sales, drawer opens).

---

### Phase 8: Electron Desktop Packaging & Web Deployment

#### Goal:
Package RetailOS into a cross-platform desktop application (Windows, macOS, Linux) with native peripheral access, and deploy the centralized Web management dashboard.

#### Architecture Components:
1. **Desktop App (`apps/desktop`)**:
   - Electron application with context-isolated Preload bridge (`contextBridge.exposeInMainWorld`).
   - Runs SQLite database locally in the user application data directory (`%APPDATA%/RetailOS/`).
   - Direct access to local USB serial/raw printers and barcode scanners.
2. **Web App (`apps/web`)**:
   - Modern React/Vite dashboard using Tailwind CSS and lightweight UI components.
   - Touch- and keyboard-optimized POS interface.
   - Executive analytics, inventory transfers, and multi-store reporting.
3. **Background Sync Worker (`packages/infrastructure/src/sync/`)**:
   - Reads `outbox_events` CDC table and streams encrypted transactional payloads to the central PostgreSQL server when network connectivity is available.

---

## 5. Non-Negotiable Engineering Rules & Invariants

To guarantee that any new engineer maintains the architectural integrity of RetailOS, the following rules must **never** be violated:

1. **Rule 1: Zero Floating Point for Money**: Never use `Number`, `parseFloat`, or raw `Math.round` for prices, costs, totals, or balances. Use the `Money` Value Object with `BigInt` minor units.
2. **Rule 2: Pure Core Domain**: `packages/core` must have **zero external runtime dependencies**. It must never import Electron, React, Kysely, SQLite, or network libraries.
3. **Rule 3: Mandatory Tenant Scoping**: Every database repository method that queries, updates, or deletes tenant data must include `where('tenant_id', '=', ctx.tenantId)`. Never write an un-scoped query.
4. **Rule 4: Double-Entry Equality**: Every financial journal entry must balance: $\sum \text{Debits} == \sum \text{Credits}$. Unbalanced entries must throw `UnbalancedJournalEntryError`.
5. **Rule 5: Immutable Financial & Stock Ledgers**: Never `UPDATE` or `DELETE` posted `journal_entries`, `journal_lines`, or `stock_movements`. Any correction requires an explicit reversal or compensating record.
6. **Rule 6: Tax Scope**: Value Added Tax (VAT) is intentionally excluded from the current scope. Do not inject tax calculations or VAT accounts.
7. **Rule 7: Verifiable Proof**: Never mark a phase or task as complete without executing the actual compilers, linters, and unit/integration tests and displaying real execution logs.

---

*This document serves as the permanent handover blueprint for RetailOS. Any contributor can continue implementation starting from Phase 4 with 100% architectural continuity.*
