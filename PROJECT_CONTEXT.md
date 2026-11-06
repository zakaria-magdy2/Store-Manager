# RetailOS — Project Context & Master State

---

## 1. Executive Overview & Product Vision
**رَفّ (RetailOS)** is an enterprise-grade, offline-capable retail management system. The product brand belongs to the vendor; each customer deployment receives its own company/store configuration and database. End users do not create a company or enter company codes in the app.

The system supports:
- **Desktop (Electron, planned)** and a local-first **Web operations app**.
- **Per-company deployment** on SQLite (WAL mode), with no shared database between customer companies.
- **Multi-store** hierarchy within each company's installation, with strict store and record scoping.
- Fast, keyboard- and barcode-optimized **Point of Sale (POS)**.
- **Universal product catalog** with dynamic attributes (industry-agnostic).
- **Weighted Average Cost (WAC)** inventory valuation with immutable historical snapshots.
- **Sub-ledger double-entry accounting** with 3-tier cash management (Drawer, Safe, Bank).
- Comprehensive **Sales & Operating Profit reporting** with **upfront monthly recurring expense entry**, daily presentation-layer amortization, non-fabricated missing-value alerts, and decoupled cash flow.
- Zero-corruption **backup and disaster recovery** with automated failure rollback.

---

## 2. Current Project State
- **Completed Through**: Core Phases 1–8 (Foundation, Identity & RBAC, Universal Catalog & WAC Inventory, POS Checkout, Integrated Purchasing/Returns/Expenses & Double-Entry Accounting, Encrypted Backup/Restore & Security Hardening, Dashboards/Analytics & Tamper-Evident Audit Logging, and Offline Outbox Sync & Desktop Host Security Supervisor), with a runnable local Arabic RTL operations app (`apps/web`) and desktop host supervisor (`apps/desktop`).
- **Current Phase**: **Phase 8 Completed (Production-Ready Local Web & Desktop Host Architecture).**
- **Workspace Directory**: `d:\Store Manager`
- **Application Code Status**: Domain, identity, catalog, inventory, POS services, `SqliteUnitOfWork`, `SqliteAuditLogRepository` (SHA-256 hash-chained audit trail), `SqliteOutboxRepository` + `OutboxSyncWorker` (monotonic per-tenant CDC outbox & batch sync), `DesktopHostSupervisor` + `createDesktopWindowSecurityPolicy` (`apps/desktop`), and 18 SQLite migrations (`001_initial_foundation` through `018_audit_logs`) are implemented; `apps/web` runs an Arabic RTL UI and authenticated SQLite API for setup, products (with variant option matrices), multi-store branch creation (`POST /api/stores`), atomic inter-store stock transfers (`POST /api/inventory/transfer`), checkout with 80mm/58mm thermal receipt print preview & ESC/POS byte stream (`GET /api/sales/:id/receipt`), customer & supplier returns, expenses, recurring monthly obligations, cash drawer Z-Report shift closing & variance reconciliation (`POST /api/accounting/shift-close`), accounting period locking (`POST /api/accounting/periods/close`), encrypted backups/restores, financial/analytics reports, and tamper-evident audit logs.
- **Architecture Blueprint Status**: **v2.5 Approved**.
- **Test Suite Status**: 75/75 automated tests pass across all layers (30 `@retailos/core` unit tests, 5 `@retailos/application` service unit tests, 33 `@retailos/infrastructure` SQLite integration tests, 2 `@retailos/desktop` host/IPC security integration tests, and 5 `@retailos/web` end-to-end integration tests).
- **Linter Status**: ESLint flat config with strict financial safety (`BigInt`-only monetary rules) and type-checked rules passing across 6/6 lint tasks with 0 warnings, 0 errors.
- **Compiler Status**: Strict TypeScript (`NodeNext`, zero implicit `any`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) passing across 9/9 typecheck tasks and 6/6 build tasks with zero warnings.
- **Security Baseline**: [`docs/SECURITY_POLICY.md`](docs/SECURITY_POLICY.md) uses OWASP ASVS Level 2 broadly and selected Level 3 controls as a target, not certification. Session-scope checks, tenant-owned upsert protection, database relationship guards, login throttling, strict CSP/security headers, and CodeQL/dependency CI checks are configured.
- **Next Security Work**: Add authentication throttling/MFA, secure Electron/API boundaries before release, and enable required CI checks plus secret scanning/push protection in repository settings.

---

## 3. Approved Architecture Decisions (ADR Summary)

| ID | Title | Approved Decision | Rationale |
| :---: | :--- | :--- | :--- |
| **ADR-001** | Monorepo Tooling | **pnpm Workspaces + Turborepo** | Maximum speed, strict symlinked boundaries, and cached builds. |
| **ADR-002** | Database Query Builder | **Kysely (Type-safe SQL)** | Zero-overhead, dialect-agnostic (SQLite & PostgreSQL), no heavy binaries in Electron. |
| **ADR-003** | Monetary Precision | **Currency-Aware `BIGINT` Minor Units** | Eliminates floating-point rounding errors; dynamically supports 0, 2, and 3-decimal currencies. |
| **ADR-004** | Inventory Valuation | **Weighted Average Cost (WAC)** | Compliant with GAAP/IFRS; paired with immutable `unit_cost_snapshot` on every sale item. |
| **ADR-005** | Multi-Store Inventory Scope | **Partitioned Store Inventories** | Each store maintains independent stock levels; prevents overselling during offline partitions. |
| **ADR-006** | Accounting Depth | **Integrated Double-Entry Sub-Ledger** | Guarantees balanced transactions ($\sum \text{Debits} = \sum \text{Credits}$), auditability, and immutability. |
| **ADR-007** | Backup & Recovery | **SQLite Online Backup API + 4-Stage Atomic Swap & Rollback** | Safe WAL checkpoints, same-filesystem staging, crash recovery marker file. |
| **ADR-008** | Revenue Presentation | **Net Revenue Method (Default Accounting) with 8-Tier Daily Report** | General ledger records net revenue; user reports explicitly show Gross Sales, Discounts/Returns, Net Sales, and Expenses. |
| **ADR-009** | Negative Stock Policy | **Strict Prohibition by default** | Prevents inventory drift; configurable per-tenant toggle retained for explicit future overrides. |
| **ADR-010** | Value Added Tax (VAT) | **Excluded from Current Scope** | RetailOS currently operates without VAT calculations or VAT accounts; keeps reporting focused. |
| **ADR-011** | Upfront Monthly Expense Entry | **Upfront Monthly Entry + Reporting Amortization + Zero Inventions** | User confirms actuals at beginning of month; single monthly ledger accrual; dynamic daily reporting; missing values yield $0 + warning banner. |
| **ADR-012** | Product Attributes & Quantities | **JSON `attributes_json` on variants + integer `BIGINT` quantities** | Industry-agnostic catalog without schema churn; exact stock arithmetic with no fractional-unit drift. |
| **ADR-013** | Inventory Ledger Immutability & WAC Rounding | **DB-enforced append-only `stock_movements` + Half-Even WAC division** | Corrections must be compensating entries; cost valuation never loses or invents minor units. |
| **ADR-014** | Company Deployment Boundary | **Separate installation and database per company** | Removes shared-customer-database isolation as a deployment dependency; internal company scope remains a defense-in-depth data integrity boundary. |
| **ADR-015** | Product Brand and Customer Provisioning | **Vendor-owned product brand; company identity comes from deployment configuration** | End users manage their shop and do not create companies or enter deployment codes in the UI. |

---

## 4. Approved Financial Reporting & Operating Expenses Rules (v2.5)

### 4.1 Daily Sales & Operating Profit Report (8-Tier Breakdown)
The primary performance report defaults to **TODAY** and displays the exact progression:
1. **Gross Sales**: Sum of all line item list prices before discounts or returns.
2. **Discounts and Returns**: Sum of cart discounts, line item discounts, and sales refunds.
3. **Net Sales**: Gross Sales minus Discounts and Returns.
4. **Cost of Goods Sold (COGS)**: Historical unit cost snapshot multiplied by quantity sold (net of restocked returns).
5. **Gross Profit**: Net Sales minus COGS.
6. **Direct Daily Operating Expenses**: Spontaneous one-off daily expenses incurred on that specific day (cleaning, hospitality, tips).
7. **Daily Amortized Share of Monthly Recurring Expenses**: Proportional daily share of confirmed monthly commitments:
   $$\text{Daily Share} = \sum \left( \left\lfloor \frac{\text{Monthly Confirmed Amount}}{\text{Days In Current Month}} \right\rfloor + \text{Remainder Allocation} \right)$$
8. **Operating Profit**: Gross Profit minus Direct Daily Expenses minus Daily Amortized Recurring Expenses.

#### Decoupled Cash Flow Panel (Shown Separately Below P&L):
- **Cash from Sales** (POS Drawer)
- **Electronic/Card Inflows** (Bank)
- **Cash Outflow for Direct Daily Expenses** (Drawer/Safe)
- **Cash Outflow for Monthly Obligations Settled Today** (Safe/Bank)
- **Pending Unpaid Due Obligations** (Accrued Liabilities)

### 4.2 Upfront Entry, Missing Values & Anti-Double-Counting Mechanics
- **Upfront Entry at Beginning of Month**: The user enters and confirms the actual monthly amount for each recurring template at month start.
- **Single Ledger Accrual**: Exactly **one** journal entry is posted per month for each recurring expense (`Debit 60xx Expense / Credit 2020 Accrued Liabilities`).
- **Zero Fictitious Data**: If a month begins and an expense has not yet been entered, daily share calculates as **$0.00** and a prominent dashboard/report notice is displayed:
  `[ACTION REQUIRED: Monthly expense for <Template> has not been entered for <Month>. Click to input actuals.]`
- **Closed Period Lock**: Past closed accounting periods remain **strictly immutable**.
- **Payment Invariant (No Double-Counting)**: Settling a monthly bill is a balance sheet movement (`Debit 2020 Accrued Liabilities / Credit Cash or Bank`); it is never deducted as an operating expense on the payment date.
- **Reporting Hierarchy**:
  - *Daily*: Direct Daily $+$ Daily Amortized Share.
  - *Custom Range*: Direct Daily in range $+$ Amortized Share for days in range.
  - *Full Month*: Direct Daily in month $+$ Confirmed Monthly Actual (deducted once).
  - *Year*: Direct Daily in year $+$ Sum of 12 Confirmed Monthly Actuals.

---

## 5. Scope & Progress Tracking

| Phase | Description | Status | Verification Gate |
| :---: | :--- | :---: | :--- |
| **Phase 0** | Architecture Analysis, Threat Modeling & Blueprint | **COMPLETED** | Blueprint v2.5 approved, ADRs logged. |
| **Phase 1** | Project Foundation (Monorepo, TS, Core Domain, DB Abstraction) | **COMPLETED** | Strict TS build (0 errors), Vitest (11/11 pass), Money VO verified, Kysely SQLite migrations work. |
| **Phase 2** | Identity, RBAC, Company Scope & Store Assignment | **COMPLETED** | Argon2id, session tokens, company scoping, store isolation, identity integration tests pass. |
| **Phase 3** | Product Catalog, Dynamic Attributes & WAC Inventory | **COMPLETED** | Migration 003, JSON variant attributes, WAC engine, append-only ledger triggers, atomic transfers, 42/42 tests pass. |
| **Phase 4** | POS Checkout, Local Operations UI & Peripheral Drivers | **COMPLETED** | SQLite-backed POS, WAC snapshots, ESC/POS receipts, cash drawer & barcode wedge drivers verified. |
| **Phase 5** | Financial Accounting, Purchasing, Expenses & Returns | **COMPLETED** | Supplier invoices/payments/returns, customer returns, direct & recurring monthly expenses, and 8-tier P&L verified with SQLite integration tests. |
| **Phase 6** | Backup, Disaster Recovery & Security Hardening | **COMPLETED** | AES-256-GCM backups, 4-stage atomic swap & rollback recovery, dynamic migration validation (`014`–`018`) verified. |
| **Phase 7** | Dashboards, Analytics & Audit Logging | **COMPLETED** | Custom date-range P&L & cash-flow analytics, cashier redaction, and SHA-256 hash-chained immutable `audit_logs` (`018_audit_logs`) verified. |
| **Phase 8** | Electron Desktop Host Supervisor, Outbox Sync & Web Deployment | **COMPLETED** | `SqliteOutboxRepository`, `OutboxSyncWorker`, `DesktopHostSupervisor`, context-isolated IPC whitelist, and production builds passing with 0 warnings. |

---

## 6. Exact Stopping Point & Next Step
- **Current Stopping Point**: All 8 architectural phases (Phases 0–8) are implemented, linted, typechecked, and verified with 75 passing unit, integration, and end-to-end tests across `@retailos/core`, `@retailos/application`, `@retailos/infrastructure`, `@retailos/desktop`, and `@retailos/web`.
- **Purchasing, expenses, returns, and accounting**: Supplier invoices, invoice lines, payments, supplier returns, direct operating expenses, linked customer returns, recurring obligation actuals, and partial settlements post balanced journal entries transactionally. Supplier returns are linked to invoice lines, capped by unreturned quantity, decrease inventory at weighted average cost, and credit the supplier at original invoice cost; valuation differences post to account 5090.
- **Verification**: Full `pnpm run typecheck` (9/9), `pnpm run lint` (6/6), `pnpm run test` (75/75), and `pnpm run build` (6/6) gates pass with zero errors and zero warnings.
