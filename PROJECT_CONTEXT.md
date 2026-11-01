# RetailOS — Project Context & Master State

---

## 1. Executive Overview & Product Vision
**RetailOS** is an enterprise-grade, offline-capable Universal Retail Management System. It is engineered to bridge local-first single-store retail environments (zero cloud latency, full offline resilience, zero mandatory cloud subscriptions) with centralized, multi-store, multi-tenant enterprise operations.

The system supports:
- **Desktop (Electron)** and **Web (React/Vite)** applications.
- **Local-first deployment** on SQLite (WAL mode) with an evolutionary path to centralized **PostgreSQL**.
- **Multi-tenant and multi-store** hierarchy with strict data isolation.
- Fast, keyboard- and barcode-optimized **Point of Sale (POS)**.
- **Universal product catalog** with dynamic attributes (industry-agnostic).
- **Weighted Average Cost (WAC)** inventory valuation with immutable historical snapshots.
- **Sub-ledger double-entry accounting** with 3-tier cash management (Drawer, Safe, Bank).
- Comprehensive **Sales & Operating Profit reporting** with **upfront monthly recurring expense entry**, daily presentation-layer amortization, non-fabricated missing-value alerts, and decoupled cash flow.
- Zero-corruption **backup and disaster recovery** with automated failure rollback.

---

## 2. Current Project State
- **Current Phase**: **Phase 3: Product Catalog, Dynamic Attributes & WAC Inventory — COMPLETED**.
- **Next Phase**: **Phase 4: POS Checkout, Fast Cart & Peripheral Drivers (Awaiting User Review & Approval)**.
- **Workspace Directory**: `d:\Store Manager`
- **Application Code Status**: Phase 1 foundation, Phase 2 security/identity, and Phase 3 catalog + inventory engine implemented and verified.
- **Architecture Blueprint Status**: **v2.5 Approved**.
- **Test Suite Status**: 100% passing (42/42 tests: 28 in `@retailos/core`, 14 in `@retailos/infrastructure`).
- **Linter Status**: ESLint flat config with strict financial safety and typing rules passing with 0 warnings, 0 errors.
- **Compiler Status**: Strict TypeScript (NodeNext, zero implicit any, exactOptionalPropertyTypes, noUncheckedIndexedAccess) passing across all packages.

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
| **Phase 2** | Identity, RBAC, Multi-Tenancy & Store Assignment | **COMPLETED** | Argon2id, session tokens, tenant scoping, store isolation, 20/20 tests pass. |
| **Phase 3** | Product Catalog, Dynamic Attributes & WAC Inventory | **COMPLETED** | Migration 003, JSON variant attributes, WAC engine, append-only ledger triggers, atomic transfers, 42/42 tests pass. |
| **Phase 4** | POS Checkout, Fast Cart & Peripheral Drivers | **READY TO START** | Barcode lookup $<15\text{ms}$, checkout $<60\text{ms}$, receipt formatting. |
| **Phase 5** | Financial Accounting, Expenses & Returns | PLANNED | Double-entry journal postings, 8-tier P&L report, recurring expense tracker. |
| **Phase 6** | Backup, Disaster Recovery & Security Hardening | PLANNED | Online backup API, 4-stage atomic restore with rollback. |
| **Phase 7** | Dashboards, Analytics & Audit Logging | PLANNED | Date range filters, drill-downs, cashier metric redactions. |
| **Phase 8** | Electron Desktop Packaging & Web Deployment | PLANNED | Context-isolated preload bridge, offline operation, production build. |

---

## 6. Exact Stopping Point & Next Step
- **Current Stopping Point**: Phase 3 successfully completed and verified. The universal catalog (categories, products, sellable variants, validated JSON attributes, barcode lookup), the WAC inventory engine (receipts, sales, returns, damage, adjustments, atomic store transfers), tenant-level negative-stock policy, and the database-enforced append-only stock ledger are implemented and tested.
- **Next Immediate Step**: Await user review and approval to proceed to **Phase 4: POS Checkout, Fast Cart & Peripheral Drivers**.
