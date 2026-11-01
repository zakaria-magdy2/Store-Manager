# RetailOS — Developer Onboarding & Handover Guide

> **Purpose**: This guide provides any software engineer or technical contributor with everything needed to immediately understand, build, run, and extend RetailOS without architectural ambiguity.

---

## 1. High-Level Architecture & Layering

RetailOS follows **Clean Architecture** (Hexagonal / Ports & Adapters) with a strict unidirectional dependency graph:

```text
               ┌──────────────────────────────┐
               │         apps/desktop         │
               │           apps/web           │
               └──────────────┬───────────────┘
                              │
               ┌──────────────▼───────────────┐
               │    packages/infrastructure   │
               │ (SQLite, Kysely, Argon2, FS) │
               └──────────────┬───────────────┘
                              │
               ┌──────────────▼───────────────┐
               │     packages/application     │
               │ (Services, Ports, Use Cases) │
               └───────┬──────────────┬───────┘
                       │              │
      ┌────────────────▼─┐          ┌─▼────────────────┐
      │  packages/core   │          │ packages/shared  │
      │  (Pure Domain)   │          │  (DTOs, Schemas) │
      └──────────────────┘          └──────────────────┘
```

### Layer Responsibilities:
1. **`packages/core` (Pure Domain)**:
   - Business entities (`User`, `Tenant`, `Store`), Value Objects (`Money`), Domain Errors, and pure calculation algorithms (Banker's Rounding, Hamilton-Hare discount allocation, monthly expense daily amortization).
   - **Constraint**: Zero external runtime dependencies. Completely agnostic of databases, UI, and network.
2. **`packages/shared` (Contracts & DTOs)**:
   - Shared data transfer objects (DTOs) and Zod validation schemas used across backend and frontend boundaries.
3. **`packages/application` (Application Layer)**:
   - Coordinates use cases (`AuthService`, `TenantService`).
   - Defines interfaces/ports (`PasswordHasher`, `TokenService`, `TenantRepository`, `UnitOfWork`).
   - Carries security context via `ExecutionContext` (`tenantId`, `storeId`, `userId`, `roleId`, `permissions`).
4. **`packages/infrastructure` (Adapters & Persistence)**:
   - Database managers (`SqliteDatabaseManager`), Kysely table schemas, migrations, concrete repositories (`SqliteUserRepository`, `SqliteStoreRepository`), and security implementations (`Argon2PasswordHasher`, `CryptoTokenService`).
5. **`apps/desktop` & `apps/web` (Presentation & Packaging)**:
   - UI layers and native wrappers.

---

## 2. Development Setup & Workflow

### 2.1 Tooling & Environment
- **Node.js**: `>= 22.0.0` (Verified on Node v24.21.0).
- **Package Manager**: `pnpm` (v12).
- **Build Orchestrator**: `Turborepo` (v2).
- **SQLite Driver**: `better-sqlite3` 13 (compiled natively via `node-gyp`; version 13 is required for Node 24).

### 2.2 Standard Commands

```powershell
# 1. Install all dependencies across monorepo
pnpm install

# 2. Compile TypeScript across all packages in dependency order
pnpm run build

# 3. Typecheck all packages without emitting output
pnpm run typecheck

# 4. Execute all Vitest unit and integration test suites
pnpm run test

# 5. Run ESLint across workspace with strict financial and typing rules
pnpm run lint

# 6. Clean all build outputs and tsbuildinfo caches
pnpm run clean
```

---

## 3. Core Architectural Patterns (Cookbook)

### 3.1 How to Handle Money & Arithmetic
**NEVER use JavaScript numbers or floats for currency.**

```typescript
import { Money, Currencies } from '@retailos/core';

// Correct: Minor unit integer arithmetic
const price = Money.fromDecimal('19.99', Currencies.USD); // 1999n minor units
const quantity = 3n;
const total = price.multiply(quantity); // 5997n -> $59.97

// Adding money
const fee = Money.fromDecimal('2.50', Currencies.USD);
const grandTotal = total.add(fee); // 6247n -> $62.47

// Banker's Rounding for percentage calculations
const discountShare = total.multiply(0.15, 'HALF_EVEN'); // 15% discount
```

### 3.2 How to Author a Database Migration
All schema changes are versioned sequentially under `packages/infrastructure/src/database/migrations/`:

1. Create a new file: `003_your_migration_name.ts`:
```typescript
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('your_table')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_your_table_tenant')
    .on('your_table')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('your_table').execute();
}
```

2. Register the migration in [`DatabaseMigrator`](file:///d:/Store%20Manager/packages/infrastructure/src/database/migrator.ts).
3. Update `RetailOSDatabase` interface in [`types.ts`](file:///d:/Store%20Manager/packages/infrastructure/src/database/types.ts).

### 3.3 How to Write a Tenant-Safe Repository
**EVERY database query MUST enforce tenant isolation.**

```typescript
export class SqliteSampleRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async findById(ctx: ExecutionContext, id: string): Promise<Sample | null> {
    const row = await this.db
      .selectFrom('sample_table')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId) // MANDATORY TENANT SCOPING
      .executeTakeFirst();

    if (!row) return null;
    return mapToEntity(row);
  }

  public async save(ctx: ExecutionContext, entity: Sample): Promise<void> {
    // Defense in depth: Verify entity tenantId matches caller's context
    if (entity.tenantId !== ctx.tenantId) {
      throw new Error('TenantIsolationViolation: Tenant ID mismatch');
    }

    await this.db
      .insertInto('sample_table')
      .values({
        id: entity.id,
        tenant_id: entity.tenantId,
        // ...
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ /* ... */ }))
      .execute();
  }
}
```

### 3.4 How to Shut Down SQLite in Tests
`SqliteDatabaseManager.close()` is **async** because it destroys the Kysely driver pool (which owns the native `better-sqlite3` handle). Always await it, or the process may crash during teardown.

```typescript
let dbManager: SqliteDatabaseManager;

afterEach(async () => {
  await dbManager.close();
});
```

When tests or repositories read `BIGINT` columns, normalize the runtime value with `toBigInt` from `packages/infrastructure/src/database/values.ts`: `better-sqlite3` returns integers as JavaScript numbers even though Kysely types them as `bigint`.

---

## 4. Current State & Where to Resume

- **Completed Phases**:
  - **Phase 0**: Architecture Blueprint v2.5 (`docs/architecture/retailos_architecture_blueprint.md`).
  - **Phase 1**: Monorepo, Strict TypeScript, `@retailos/core` Money VO, SQLite WAL manager, Initial Migrations.
  - **Phase 2**: Argon2id password hashing, SHA-256 session management, RBAC matrix, and multi-tenant isolation.
  - **Phase 3**: Universal catalog (categories, products, variants, JSON attributes), WAC inventory engine, tenant negative-stock policy, and DB-enforced append-only stock ledger.
- **Where to Resume Immediately**:
  - **Phase 4: POS Checkout, Fast Cart & Peripheral Drivers**.
  - Review the Phase 4 specification in [`docs/MASTER_ROADMAP_AND_VISION.md`](file:///d:/Store%20Manager/docs/MASTER_ROADMAP_AND_VISION.md) and start with the cart domain model in `packages/core/src/pos/`.
