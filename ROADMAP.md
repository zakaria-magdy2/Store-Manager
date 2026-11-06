# RetailOS — Roadmap & Handover Center

Welcome to the RetailOS engineering workspace. All architectural decisions, completed work, and future phase roadmaps are documented in detail below:

## 📚 Master Documentation Directory

1. 🌟 **[Master Vision & Execution Roadmap](docs/MASTER_ROADMAP_AND_VISION.md)**:
   - Complete product vision and target retail engine architecture.
   - Detailed technical record of completed milestones (Phases 0, 1, 2, 3).
   - In-depth forward specifications for **Phases 3 through 8** (tables, domain models, business rules, and acceptance criteria).
   - Non-negotiable engineering rules and invariants.

2. 🛠️ **[Developer Onboarding & Handover Guide](docs/DEVELOPER_HANDOVER_GUIDE.md)**:
   - Clean Architecture layer structure and boundaries.
   - Command reference (build, test, typecheck, lint).
   - Code patterns & cookbooks: Money Value Object usage, writing Kysely migrations, writing tenant-isolated repositories.
   - Instructions on how to resume immediately with Phase 3.

3. 🏛️ **[Architecture Decisions (ADRs)](docs/architecture/ARCHITECTURE_DECISIONS.md)**:
   - ADR-001 through ADR-013 covering Monorepo tooling, Kysely, BigInt minor units, WAC valuation, double-entry accounting, 4-stage recovery, upfront monthly expense amortization, and catalog/inventory representation.

4. 📐 **[Master Architecture Blueprint v2.5](docs/architecture/retailos_architecture_blueprint.md)**:
   - The authoritative architectural blueprint specifying the full retail operating model.

5. 📋 **[Project Master Context & Tracking](PROJECT_CONTEXT.md)**:
   - Real-time milestone status, completed gates, and test metrics.

---

## 🚦 Quick Milestone Status

- [x] **Phase 0**: Architecture Analysis, Threat Modeling & Blueprint v2.5
- [x] **Phase 1**: Monorepo Setup, Strict TypeScript, Core Money VO & SQLite Engine
- [x] **Phase 2**: Identity, RBAC, Multi-Tenancy & Store Assignment
- [x] **Phase 3**: Product Catalog, Dynamic Attributes & WAC Inventory Engine
- [x] **Phase 4**: POS Checkout, Fast Cart, Local Operations App & Peripheral Drivers
- [x] **Phase 5**: Financial Accounting, Purchasing, Returns, Expenses & 8-Tier P&L Reporting
- [x] **Phase 6**: Encrypted Backup, 4-Stage Disaster Recovery & Security Hardening
- [x] **Phase 7**: Dashboards, Analytics & Tamper-Evident Audit Logging
- [ ] **Phase 8**: Electron Desktop Packaging & Web Deployment
