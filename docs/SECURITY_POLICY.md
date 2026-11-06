# RetailOS Security Policy

## Security objective

RetailOS uses defense in depth to reduce the likelihood and impact of compromise.
No product can promise protection from every attack. Security status must be
earned through verified controls, secure defaults, and continuous review.

Each customer company gets a separate installation and database. The internal
`tenant_id` field represents that installation's company scope; database guards
protect integrity within the installation and against malformed imports.

Use OWASP ASVS 5.0.0 as the application verification catalog. Target Level 2
controls across the product, with selected Level 3 controls for authentication,
company-scope isolation, financial records, and privileged administration.
This target is an engineering baseline, not a claim of certification or compliance.

## Mandatory engineering rules

- Deny access by default. Enforce authentication, authorization, company, and
  store scope at trusted application boundaries for every operation.
- Never trust a company scope, role, permission, user, store, or price supplied by a
  client. Only trusted server-side code may create execution contexts.
- Scope every repository read and write. Database updates must also guard the
  existing row's company ownership; caller-selected identifiers are untrusted.
- Validate and bound all external input. Use parameterized queries and explicit
  output encoding at any future web boundary.
- Store passwords with Argon2id using at least 19 MiB memory, time cost 2, and
  parallelism 1. Never log passwords, bearer tokens, or secret values.
- Use cryptographically secure random bearer tokens, store only token hashes,
  expire sessions, and revoke them after logout, account/company disablement, or
  scope changes.
- Keep financial and inventory history append-only. Correct mistakes with
  compensating records and audit privileged actions.
- Keep secrets out of source, fixtures, logs, renderer processes, and committed
  configuration. Use managed secret storage in deployment environments.
- Minimize dependency permissions and privileges. Review dependency and static
  analysis findings before release; critical/high findings block release unless
  a documented risk acceptance has an owner and expiry date.

## Secure delivery gates

Every pull request must pass the required quality workflow (lint, typecheck,
unit and integration tests, build) and security workflow (dependency audit and
static analysis). Configure both workflows as required branch-protection checks.
Enable repository secret scanning and push protection where the hosting plan
supports them. Do not treat a workflow file as effective enforcement until the
repository settings require its checks.

Security regressions require a test that demonstrates the failure before the
fix. Persistence and isolation controls require migrated SQLite integration
tests. Review database migrations for company-aware relationship guards and safe upgrade
behavior. Security exceptions require a written rationale, accountable owner,
mitigation, and expiry date.

## Platform-specific controls before release

- Electron: context isolation, sandbox, `nodeIntegration: false`, narrow typed
  IPC allowlists, sender validation, strict Content Security Policy, and no
  database access from renderers.
- Network/API: TLS, secure headers, restrictive CORS, CSRF protection for cookie
  sessions, request size/time limits, throttling for authentication, and
  structured security audit events.
- Operations: encrypted backups, tested restore procedures, least-privilege
  database and deployment identities, patch cadence, monitoring, and an incident
  response and credential rotation procedure.

## Initial risk register

| Priority | Finding | Required next step |
| --- | --- | --- |
| P0 | Application UI and network boundary are not implemented yet | Threat model Electron/API before exposing functionality; meet platform controls above |
| P1 | Company consistency must remain enforced for every new database relationship | Migration `006_tenant_relationship_guards` adds insert/update guards for identity, catalog, inventory, accounting, outbox, and POS relationships; add equivalent guards for future relationships |
| P1 | Authentication has no throttling or MFA | Add lockout-safe rate limiting, security events, and MFA for privileged roles at the API boundary |
| P1 | Company provisioning is a bootstrap-level operation | Keep initial company setup inaccessible to ordinary store users and authorize it through the installation/setup flow |
| P1 | CI security scanning and repository secret protection need host configuration | Require security workflow checks and enable secret scanning/push protection |
| P2 | Company-scope and store isolation regression coverage is growing | Extend tests across every scoped repository and session revocation event |

## Current verification status

Security hardening is in progress. Session scope revalidation, guarded
tenant-owned upserts, and database-level relationship guards are implemented
with regression tests. This document records a baseline; it does not represent
a completed penetration test or security certification. Track remaining risks
in this register and review it for every release.
