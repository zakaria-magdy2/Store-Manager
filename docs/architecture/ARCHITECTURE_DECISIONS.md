# Architecture Decision Records (ADRs) — RetailOS

---

## ADR-001: Monorepo Tooling (pnpm Workspaces + Turborepo)
- **Status**: Approved
- **Context**: RetailOS encompasses multiple deployment targets (`apps/desktop`, `apps/web`, `apps/api`) and shared packages (`core`, `application`, `infrastructure`, `shared`, `ui`).
- **Decision**: Adopt `pnpm` workspaces for strict symlinked dependency boundaries and `Turborepo` for incremental build orchestration and pipeline caching.
- **Consequences**: Fast installations, strict prevention of phantom dependencies, minimal disk footprint.

---

## ADR-002: Persistence Layer (Kysely Type-Safe Query Builder)
- **Status**: Approved
- **Context**: The system must run on local embedded SQLite in Electron without internet, but support future centralization onto PostgreSQL without rewriting application use cases.
- **Decision**: Use **Kysely** instead of Prisma or TypeORM.
- **Consequences**:
  - Prisma's binary query engine (~40MB) is completely avoided inside the Electron distributable.
  - Kysely provides compile-time type safety with zero runtime overhead.
  - Native support for both `better-sqlite3` (Desktop) and `pg` (Centralized Cloud).

---

## ADR-003: Monetary Precision & Dynamic Currency Minor Units
- **Status**: Approved
- **Context**: Retail systems operate across diverse global currencies with 0 (JPY), 2 (USD, EUR, EGP, SAR), and 3 (KWD, BHD, JOD) decimal places. Floating-point numbers produce rounding errors.
- **Decision**: Store all monetary values as `BIGINT` representing the minor currency units (e.g. milliemes, cents). Enforce all arithmetic using a domain `Money` Value Object wrapping JavaScript native `BigInt`.
- **Consequences**: Eliminates floating-point calculation errors. API serialization uses structured string representations to safely transmit `BigInt` over JSON.

---

## ADR-004: Inventory Valuation (Weighted Average Cost - WAC)
- **Status**: Approved
- **Context**: Product costs change with subsequent supplier purchase invoices. Financial reporting must accurately determine Cost of Goods Sold (COGS) and inventory valuation.
- **Decision**: Implement the Weighted Average Cost (WAC) methodology. Every sale transaction item captures an immutable `unit_cost_snapshot` at the moment of checkout.
- **Consequences**: Highly performant checkout; fully compliant with IFRS/GAAP retail inventory standards; past historical sales remain consistent when new inventory is received.

---

## ADR-005: Multi-Store Inventory Scope (Partitioned Inventories)
- **Status**: Approved
- **Context**: A business with multiple branches may operate offline during internet outages.
- **Decision**: Partition inventory counts strictly by `(store_id, variant_id)`. Branches never share a floating, centralized real-time inventory count.
- **Consequences**: Prevents cross-store race conditions and double-selling during offline partitions. Inter-store inventory movements require explicit two-phase `TRANSFER_OUT` / `TRANSFER_IN` transactions.

---

## ADR-006: Accounting Engine (Double-Entry Sub-Ledger)
- **Status**: Approved
- **Context**: The business requires verifiable, auditable financial statements (Gross Sales, Net Sales, Gross Profit, Operating Expenses, Operating Profit) and cash reconciliation.
- **Decision**: Implement an integrated double-entry sub-ledger with standard accounts, immutable posted journal entries, reversal-based corrections, and balanced debit/credit checks ($\sum \text{Debits} = \sum \text{Credits}$).
- **Consequences**: Complete auditability; separate tracking of POS Cash Drawer (`1010`), Store Safe Treasury (`1015`), and Bank Clearing (`1020`).

---

## ADR-007: SQLite Backup & 4-Stage Atomic Disaster Recovery
- **Status**: Approved
- **Context**: SQLite in WAL mode risks database corruption if files are copied while write transactions are active.
- **Decision**: Utilize the SQLite Online Backup API (`better-sqlite3` `db.backup()`). Restores utilize a 4-stage "sandbox verification -> pre-restore snapshot -> same-filesystem atomic swap -> verification & auto-rollback" pipeline with a crash recovery marker file.
- **Consequences**: Zero-corruption backups; guaranteed recovery even if power fails mid-restore.

---

## ADR-008: Revenue Presentation Policy & 8-Tier Daily Progression
- **Status**: Approved
- **Context**: Customer receipts include discounts and promotions. Reports must present a clear transition from Gross Sales to Net Sales down to Operating Profit.
- **Decision**: Use the **Net Revenue Method** in double-entry general ledger postings, while user-facing daily reports explicitly calculate and display **Gross Sales**, **Discounts and Returns**, **Net Sales**, **COGS**, **Gross Profit**, **Direct Daily Expenses**, **Daily Amortized Recurring Expenses**, and **Operating Profit**.
- **Consequences**: Accounting simplicity in ledger lines without sacrificing reporting transparency.

---

## ADR-009: Negative Stock / Backorder Policy
- **Status**: Approved
- **Context**: High-volume retail stores sometimes face stock count mismatches at the cash register.
- **Decision**: **Strict Prohibition by default** (`InsufficientStockException`). A tenant-level configuration flag can optionally enable negative stock for explicit workflows, which provisionally recognizes COGS at the last known WAC and reconciles cost variances upon replenishment.
- **Consequences**: Prevents accidental overselling and inventory valuation drift by default.

---

## ADR-010: Value Added Tax (VAT) Scope
- **Status**: Approved
- **Context**: Current business requirements dictate operating without tax complexity.
- **Decision**: **VAT is explicitly excluded from the current scope**. No tax rates, tax calculations, or tax liability accounts will be active in this phase.
- **Consequences**: Simplifies cart calculations and journal entries; accelerates Phase 1–5 delivery while preserving clear architectural hooks for future tax modules.

---

## ADR-011: Upfront Monthly Expense Entry & Pure Reporting Amortization
- **Status**: Approved (v2.5)
- **Context**: Entering actuals at the beginning of each month avoids complex baseline estimations and retroactive redistributions.
- **Decision**:
  1. **Upfront Entry**: The user inputs and confirms the actual value for each recurring monthly expense at the start of the month.
  2. **Single Monthly Ledger Accrual**: The general ledger books **one** accrual entry for the month (`Debit 60xx Expense, Credit 2020 Accrued Liabilities`).
  3. **Reporting Amortization**: The daily report divides the confirmed amount over the days in that month ($N_{days} \in \{28, 29, 30, 31\}$) strictly in memory/queries. Zero daily journal entries are written.
  4. **Missing Values**: If un-entered, the system calculates $\$0.00$ and displays an actionable warning banner. Fictitious values are never invented.
  5. **Payment Decoupling**: Paying a bill settles the liability (`Debit 2020 / Credit Cash/Bank`) and shows in the Cash Flow Panel, never deducting from profit on payment day.
- **Consequences**: Drastically simpler operational workflow, zero ledger bloat, 100% audit integrity.

---

## ADR-012: Dynamic Product Attributes & Integer Stock Quantities
- **Status**: Approved (Phase 3)
- **Context**: RetailOS must serve apparel (size, color), grocery (expiry, batch), electronics (serial, warranty), and pharmacy (lot, dosage) without per-industry schema migrations. Stock quantities also need exact arithmetic for single-unit sales and future fractional units (weight, volume).
- **Decision**:
  1. Model **every sellable unit as a `ProductVariant`**; simple products use one default variant so pricing, barcode lookup, and stock share a single code path.
  2. Store industry-specific attributes as a **validated JSON primitive map** (`string | number | boolean`) in `product_variants.attributes_json`, with normalized keys, finite-number checks, and strict parse/serialize round-tripping.
  3. Store all stock quantities as **`BIGINT` integer units** (never floating point), converted at the SQLite boundary because `better-sqlite3` returns runtime integers as JavaScript numbers while Kysely types them as `bigint`.
- **Consequences**: The catalog supports any retail vertical without schema churn; inventory arithmetic stays exact and deterministic. Attribute filtering is JSON-based on SQLite and may later need generated columns or a search index for high-volume queries.

---

## ADR-013: Database-Enforced Append-Only Stock Ledger & Half-Even WAC Division
- **Status**: Approved (Phase 3)
- **Context**: WAC valuation and COGS auditability depend on a stock history that can never be silently rewritten. Weighted-average division can also produce fractional minor units, which must be rounded consistently rather than truncated.
- **Decision**:
  1. Make `stock_movements` **append-only at the database level** using `BEFORE UPDATE` and `BEFORE DELETE` triggers that raise `stock_movements is append-only: corrections must be compensating entries`. Application code is not the only line of defense.
  2. Calculate WAC with exact integer numerator/denominator arithmetic; when the current quantity is zero or negative, an incoming receipt **replaces** the WAC instead of blending meaningless history.
  3. Round fractional minor units with **Half-Even (Banker's) rounding** via `Money.divideBy`, matching the project-wide monetary policy.
  4. Record an immutable cost snapshot on every issue movement so COGS is reproducible at any later date.
- **Consequences**: Ledger tampering requires a schema change, not just an application bug. Cost valuation never loses or invents minor units, and corrections remain fully auditable as compensating entries.

