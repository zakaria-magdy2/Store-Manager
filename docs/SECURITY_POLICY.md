# RetailOS Security Policy (Single-Device Baseline)

## Security objective

RetailOS (`رَفّ`) uses defense in depth to reduce the likelihood and impact of compromise on a single-computer store deployment using local SQLite storage and loopback-only binding (`127.0.0.1`). No product can promise protection from every attack; security status must be earned through verified controls, secure defaults, and continuous review.

Each company installation uses a dedicated local database. The internal `tenant_id` field enforces company ownership across queries, mutations, imports, and SQLite relationship triggers.

Use **OWASP ASVS 5.0.0** as the engineering verification catalog (targeting Level 2 across the product and selected Level 3 controls for authentication, tenant/store scoping, financial ledgers, and privileged operations). This baseline is an internal engineering guide and **does not** constitute third-party certification or formal compliance accreditation.

## Mandatory engineering controls

- **Loopback-only surface:** `apps/web/server.mjs` listens strictly on `127.0.0.1` with Same-Origin checks on all mutating routes and strict Content Security Policy (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'`).
- **Deny by default & RBAC:** Authenticated session cookie (`HttpOnly; SameSite=Strict`) resolved server-side via `AuthService.validateSession` (`apps/web/server.mjs`, `packages/application/src/auth/auth.service.ts`). Store managers cannot supply or spoof `tenant_id`, `role`, `permissions`, or `price`.
- **Password storage:** Argon2id (`@node-rs/argon2`) with >= 19 MiB memory (`19456` KiB), time cost `2`, parallelism `1` (`packages/infrastructure/src/security/argon2-password-hasher.ts`). Never log credentials, tokens, or backup passphrases.
- **Sessions & immediate revocation:** Cryptographically random bearer tokens stored as SHA-256 hashes with expiry validation and immediate revocation on logout, password change, role update, store assignment change, or user deactivation (`packages/infrastructure/src/database/repositories/sqlite-user.repository.ts`, `sqlite-session.repository.ts`, `apps/web/server.mjs`).
- **Persistent throttling:** Login failures (`MAX_FAILED_LOGINS = 6` per 10-minute window) and password-change failures (`MAX_FAILED_PASSWORD_CHANGES = 5` per 10-minute window) are persisted in the SQLite `auth_rate_limits` table so lockouts survive process and OS restarts (`apps/web/server.mjs`).
- **Immutable ledgers & hash-chained audit trail:** SQLite triggers block `UPDATE`/`DELETE` on `journal_lines`, block non-reversal modifications on `journal_entries`, block writes into `CLOSED` accounting periods (`019_enterprise_accounting_and_indexes.ts`), and chain all security/business audit records with sequential SHA-256 hashes (`018_audit_logs.ts`, `sqlite-audit-log.repository.ts`).
- **Encrypted backups & atomic restore:** Exported archives use AES-256-GCM + `scrypt` (`RFBK1` format, 12–256 char passphrase) with `integrity_check`, `foreign_key_check`, and `kysely_migration` verification before committing atomic 4-stage replacement + pre-restore safety snapshot (`packages/infrastructure/src/backup/sqlite-backup.service.ts`).

## Single-device MFA decision record

For the current **single-computer, single-shop, loopback-bound (`127.0.0.1`)** scope:
- Interactive in-app TOTP/WebAuthn MFA is **deferred** to the network/multi-device release phase, because the API is not reachable from external networks and POS terminals operate offline without guaranteed OTP devices.
- Compensating controls required at store installation:
  1. Strong minimum 12-character owner password (`OwnerSchema`, `PasswordSchema`) hashed with Argon2id.
  2. Persistent SQLite brute-force throttling (`auth_rate_limits`) across restarts.
  3. Dedicated standard (non-Administrator) Windows user account for daily POS use, automatic screen lock timeout, full-disk encryption (Windows BitLocker / Device Encryption), and OS updates + Microsoft Defender enabled.

## Secure delivery gates

- Pull requests and `main` must pass `.github/workflows/quality-gates.yml` (`lint`, `typecheck`, `test`, `build`) and `.github/workflows/security.yml` (`pnpm audit --prod` with zero exceptions, CodeQL JavaScript/TypeScript `security-extended`, and dependency review).
- Repository host configuration outside git (branch protection requiring passing status checks, PR reviews, Secret Scanning, and Push Protection) must be enabled in GitHub repository settings by the repository administrator.

## Risk & Control Verification Register

| Priority | Control / Risk Area | Current Status | Code & Verification Evidence | Remaining Operational Action |
| --- | --- | --- | --- | --- |
| P0 | Local UI & API boundary (`127.0.0.1`, CSP, Same-Origin) | Implemented | `apps/web/server.mjs` (`securityHeaders`, `requireSameOrigin`, `server.listen(port, '127.0.0.1')`); `apps/web/tests/app-flow.test.mjs` | Verify browser CSP console stays clean on each UI change |
| P0 | Paged historical data without truncation | Implemented | `/api/sales`, `/api/purchases`, `/api/journal-entries`, `/api/customer-returns`, `/api/expenses` in `apps/web/server.mjs` & `app.js`; tested in `apps/web/tests/app-flow.test.mjs` | Re-test under synthetic multi-year load (P2) |
| P1 | Persistent brute-force throttling | Implemented | `auth_rate_limits` SQLite table + `getAuthFailures` / `recordAuthFailure` in `apps/web/server.mjs`; tested in `app-flow.test.mjs` | Review lockouts in `audit_logs` (`AUTH_LOGIN_FAILED`) |
| P1 | Session lifecycle, password policy & RBAC isolation | Implemented | `packages/application/src/auth/auth.service.ts`; `apps/web/server.mjs`; tested across cashier vs owner flows in `app-flow.test.mjs` | Enable Windows screen lock & non-admin POS OS account on shop PC |
| P1 | Company/store SQLite relationship & ledger guards | Implemented | Migrations `006_tenant_relationship_guards.ts`, `019_enterprise_accounting_and_indexes.ts`; `packages/infrastructure` Vitest suite | Include migration + rollback drill before every release |
| P1 | Production dependency vulnerability scanning | Implemented (0 exceptions) | `.github/workflows/security.yml` runs `pnpm audit --prod` (no `--ignore` flags) + CodeQL | Administrator to require checks + secret scanning in GitHub settings |
| P1 | Workstation physical security & BitLocker | Operational | Documented in `docs/SINGLE_DEVICE_DEPLOYMENT_AND_OPERATIONS_AR.md` | Enable BitLocker & non-admin Windows account on store PC |
| P1 | Real printer/drawer/scanner + external backup restore drill | Verified in script / Pending shop hardware | `scripts/verify-backup-restore.mjs`; `docs/HARDWARE_AND_ACCOUNTING_ACCEPTANCE_CHECKLIST_AR.md` | Owner & accountant complete manual sign-off on shop peripherals |
| P2 | Multi-device / LAN / Cloud sync & TOTP MFA | Out of scope (Single-device phase) | Service strictly bound to `127.0.0.1` | Re-evaluate threat model + add TLS + TOTP MFA before network exposure |
