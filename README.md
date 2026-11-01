# RetailOS (Store Manager)

> **Universal Retail Management System** — Offline-capable, local-first retail operations platform designed for high performance, multi-tenant isolation, rigorous double-entry accounting, and Weighted Average Cost (WAC) inventory valuation.

---

## 🚀 Key Highlights

- **Local-First & Resilient**: Built for offline operation on SQLite (WAL mode) with an evolutionary path to centralized PostgreSQL.
- **Strict Multi-Tenancy & Store Scoping**: Data isolation enforced at both domain and database repository boundaries.
- **Zero Floating-Point Financials**: Exact currency arithmetic using `bigint` minor units with Half-Even (Banker's) Rounding.
- **Enterprise-Grade Security**: Password hashing powered by **Argon2id** (`@node-rs/argon2`) and cryptographically random session tokens (SHA-256 hashed in-storage).
- **8-Tier Sales & Profit Progression**: Real-time breakdown from Gross Sales down to Net Operating Profit with integer-safe monthly expense amortization.

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
│   └── web/             # Web application (React / Vite) [Phase 8]
├── docs/                # Architecture blueprints and Architecture Decision Records (ADRs)
└── PROJECT_CONTEXT.md   # Master project context and implementation status
```

---

## 🛠️ Tech Stack

- **Runtime**: Node.js `>=20` (NodeNext ESM)
- **Language**: Strict TypeScript 5.8
- **Monorepo**: pnpm 12 + Turborepo 2
- **Database**: SQLite (better-sqlite3) via Kysely query builder
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

- Node.js `>= 20.0.0`
- pnpm `>= 10.0.0`

### Installation

```bash
# Clone the repository
git clone https://github.com/zakaria-magdy2/Store-Manager.git
cd Store-Manager

# Install workspace dependencies
pnpm install
```

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
