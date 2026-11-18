# AGENTS.md — RetailOS Engineering Rules (Non-Negotiable)

These rules bind every human and AI contributor working in this repository.
If a task conflicts with a rule below, stop and ask the repository owner before proceeding.

---

## 1. Monorepo dependency direction

Dependencies flow strictly in one direction:

```
@retailos/core  →  @retailos/application  →  @retailos/infrastructure  →  @retailos/web  →  @retailos/desktop
```

- `@retailos/shared` (validation schemas) and `@retailos/tsconfig` may be consumed by any layer.
- `core` is pure domain logic: no I/O, no Node APIs, no database, no HTTP.
- `application` depends only on `core` and port interfaces; it never imports `infrastructure`.
- `infrastructure` implements the ports (SQLite/Kysely repositories, migrations, crypto, backups).
- `web` (`apps/web/server.mjs` + `public/`) composes the layers into the local HTTP server and UI.
- `desktop` (`apps/desktop`) wraps `web` in Electron. Nothing may import from `desktop`.
- Never introduce a reverse or circular import. New migrations go in
  `packages/infrastructure/src/database/migrations/` and must be registered in `migrator.ts`.

## 2. Money & accounting integrity

- All currency values are **integer minor units (piasters)** using `bigint` / `BigInt` (or integer
  strings over the wire). **Zero floats for currency** — no `parseFloat`, no `Number()` coercion of
  money, no `Math.round/floor/ceil` on monetary values. Use `Money` from `@retailos/core`.
- Every journal entry must be balanced: `SUM(debits) === SUM(credits)` in integer piasters,
  posted atomically inside the same database transaction as the business operation.
- Never "fix" a report by editing an assertion or a formula to match a wrong number. Fix the source
  posting, and add a regression test proving Trial Balance, P&L, Account `1010` (cash drawer), and
  inventory reconcile.
- Mutating financial endpoints must be idempotent (`idempotencyKey`) so retries never double-post.

## 3. Server-side security

- Every protected route resolves `ctx` server-side and enforces `ctx.assertPermission(...)`;
  store-scoped operations additionally enforce store access (`assertStoreAccess` / `assertStoreScope`)
  for **both** source and destination stores. Never rely on the UI to hide forbidden actions.
- All user-controlled text rendered into HTML must pass through `escapeHtml()` (XSS protection).
- Every mutating route (`POST`/`PUT`/`PATCH`/`DELETE`) must pass Origin/CSRF enforcement
  (`requireSameOrigin`). Do not add bypasses.
- Validate request bodies with Zod schemas; reject ambiguous payloads with `400`.

## 4. Electron desktop hardening

- `BrowserWindow` must keep `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, `allowRunningInsecureContent: false`.
- The embedded server binds **only** to `127.0.0.1` (loopback). Never bind to `0.0.0.0`.
- Block navigation and `window.open` to any origin other than the local loopback origin.
- The preload exposes a minimal, explicit `contextBridge` API; IPC senders are verified against the
  loopback origin.
- Store data, SQLite, and backups live under `app.getPath('userData')` (`%APPDATA%\RetailOS`) via
  `RETAILOS_DATA_DIR`, `RETAILOS_DB_PATH`, `RETAILOS_BACKUP_DIR` — never inside the install folder.
- On quit, the server child process must be shut down gracefully with zero orphan processes.

## 5. Data safety & quality gates

- **NEVER touch, read, copy, or modify `apps/web/data/retailos.sqlite`.** Tests and tools must spin
  up `apps/web/server.mjs` against an isolated temporary `RETAILOS_DATA_DIR` on a free `127.0.0.1`
  port and delete that folder afterwards.
- Before every commit, run the **un-cached** Quality Gates and confirm all are green:

  ```
  pnpm exec turbo run build --force
  pnpm exec turbo run lint --force
  pnpm exec turbo run typecheck --force
  pnpm exec turbo run test --concurrency=1 --force
  ```

  On Windows run them through `cmd /c "... 2>&1"` (PowerShell's `pnpm.ps1` can mask exit codes).
- Report exact pass/fail counts from real output. Never fabricate or extrapolate results.
- `pnpm audit --prod` must stay clean; new tooling goes in `devDependencies`.
