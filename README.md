# رَفّ | RetailOS (Store Manager)

> **Universal Retail Management System** — Offline-capable, local-first retail operations platform deployed separately for each company, with rigorous accounting and Weighted Average Cost (WAC) inventory valuation.

---

## 🚀 Key Highlights

- **Local-First & Resilient**: Each company deployment uses its own SQLite database (WAL mode) and operates offline.
- **Company and Store Scoping**: Within a company database, application scope and database guards protect records across stores and preserve company ownership relationships.
- **Zero Floating-Point Financials**: Exact currency arithmetic using `bigint` minor units with Half-Even (Banker's) Rounding.
- **Enterprise-Grade Security**: Separate company installations and databases, Argon2id password hashing (`@node-rs/argon2`), and cryptographically random session tokens (SHA-256 hashed in storage).
- **Universal Product Catalog**: Products, nested categories, and sellable variants with validated JSON attributes — apparel, grocery, electronics, and pharmacy share one schema.
- **WAC Inventory with Immutable Ledger**: Weighted Average Cost valuation with exact integer arithmetic, immutable cost snapshots on every issue, atomic inter-store transfers, and a database-enforced append-only `stock_movements` ledger.
- **Supplier Ledger**: Supplier directory, purchase invoice totals, payments, and outstanding balances. Integrated stock receiving and double-entry accounting are upcoming milestones.

---

## 📦 Workspace Architecture

This project is organized as a strict, high-performance monorepo powered by **pnpm workspaces** and **Turborepo**:

```text
├── packages/
│   ├── core/            # Pure domain layer: entities, value objects, Money VO (zero external deps)
│   ├── shared/          # Shared DTOs, Zod validation schemas, and contracts
│   ├── application/     # Ports, application services, auth & execution context
│   ├── infrastructure/  # Kysely SQLite, database migrations, Argon2id hasher, repositories
│   └── tsconfig/        # Strict shared TypeScript configurations
├── apps/
│   ├── desktop/         # Desktop application (Electron) [Phase 8]
│   └── web/             # Arabic RTL local web UI, SQLite API, and integration flow
├── docs/                # Architecture blueprints and Architecture Decision Records (ADRs)
└── PROJECT_CONTEXT.md   # Master project context and implementation status
```

---

## 🛠️ Tech Stack

- **Runtime**: Node.js `>=22` (NodeNext ESM)
- **Language**: Strict TypeScript 5.8 for domain packages; JavaScript ESM for the local web host and UI
- **Monorepo**: pnpm 12 + Turborepo 2
- **Database**: SQLite (`better-sqlite3` 13) via Kysely query builder
- **Security**: Argon2id (`@node-rs/argon2`)
- **Validation**: Zod
- **Testing**: Vitest

---

## 📚 Documentation & Roadmap

- 🗺️ **[Master Vision & Execution Roadmap (Phases 0–8)](docs/MASTER_ROADMAP_AND_VISION.md)**: Full product vision, completed work breakdown, and detailed blueprints for all upcoming phases.
- 🧑‍💻 **[Developer Onboarding & Handover Guide](docs/DEVELOPER_HANDOVER_GUIDE.md)**: Architectural patterns, coding standards, repository cookbooks, and how to resume work.
- 🏛️ **[Architecture Decisions (ADRs)](docs/architecture/ARCHITECTURE_DECISIONS.md)**: Formal records of all technical and architectural choices.
- 📐 **[Master Architecture Blueprint v2.5](docs/architecture/retailos_architecture_blueprint.md)**: Comprehensive system blueprint.

---

## 🚦 Getting Started

### Prerequisites

- Node.js `>= 22.0.0`
- pnpm `>= 10.0.0`

### Installation

```bash
# Clone the repository
git clone https://github.com/zakaria-magdy2/Store-Manager.git
cd Store-Manager

# Install workspace dependencies
pnpm install
```

### Run the local application

```bash
pnpm --filter @retailos/web dev
```

Open `http://127.0.0.1:4173`. The company and main store come from the
deployment configuration (`RETAILOS_COMPANY_NAME`, `RETAILOS_COMPANY_CODE`,
`RETAILOS_CURRENCY`, and `RETAILOS_STORE_NAME`). The first screen creates
only the store manager's login; it does not ask the user to create a company or
enter company codes. The product brand shown to users is **رَفّ**. The app
creates a real SQLite database at
`apps/web/data/retailos.sqlite`; this directory is local data and is ignored by
Git. The local service binds to loopback only and serves the same-origin UI and
API. Product creation, stock receipts, POS checkout, supplier purchase invoices,
supplier payments, supplier returns, and outstanding balances are stored in SQLite. A financial report provides a date-filtered profit and loss breakdown, monthly expense amortization, and a separate cash flow summary. Owners can download AES-256-GCM encrypted SQLite backups after integrity checks. Configure
`RETAILOS_DATA_DIR` to put the
company database in a different protected location.

Current runnable flows cover product setup, stock receipts, sales, inventory
balances, sale history, supplier records, purchase totals, payments, and
remaining balances. Catalog entries can be stock-tracked products or services
that sell without inventory deduction. Multi-line supplier invoices create
their stock movements and initial payment atomically. Supplier returns link to original purchase lines, cannot exceed received quantities, reduce stock at weighted average cost, and credit the supplier at the original invoice cost. Supplier invoices,
payments, and sales also post balanced double-entry journal entries in the same
transaction. Direct operating expenses post to the journal atomically with
cash drawer, safe, or bank movements. Linked partial customer returns update
inventory at the original sale cost, refund the original discounted value,
and post a balancing journal entry. Recurring expense actuals are confirmed once
per month, then settled as liability payments without double-counting. Supplier
returns, staff administration, backups, and final Electron packaging remain
future work.

### Build & Verification Commands

```bash
# Typecheck all packages
pnpm run typecheck

# Run test suites
pnpm run test

# Run ESLint across workspace
pnpm run lint

# Build all packages
pnpm run build
```

---

## 📄 License

Proprietary — All Rights Reserved.

## Engineering quality gates

All contributors follow [the project quality gates](docs/QUALITY_GATES.md) for
linting, unit tests, integration tests, and merge verification.
