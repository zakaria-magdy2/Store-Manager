# RetailOS — Pre-Pilot Production Readiness Audit Report

**Audit Date:** 2026-11-19  
**Base Commit:** `main` @ `7f1fa727f2cf42750816b8513b24b4f0099c667c` (`7f1fa72`) + Pre-Pilot Remediation Working Tree (Uncommitted, Pending Clean-Windows Rehearsal)  
**Database Integrity Policy:** Strict isolation — `apps/web/data/retailos.sqlite` was never touched, read, or modified.  
**Recommendation:** **`NOT READY`** *(All identified software P1 blockers (`P1-1`, `P1-4`) and `P2` stocktake `BigInt` coercions are fixed and proven in un-cached test suites; physical clean-Windows installation, real OneDrive/Google Drive cloud upload verification, and live replacement-PC cloud restore remain **`NOT VERIFIED`** until the physical P1-2 rehearsal passes on the pilot machine.)*

---

## Executive Summary Table

| # | Audit Area | Verdict | Verified Technical Controls | Remaining Physical / Unverified Gaps |
| :- | :--- | :---: | :--- | :--- |
| **1** | Backup and Cloud Sync | **`NOT VERIFIED`** | AES-256-GCM `.rfbackup` (`RFBK1`), pre-encryption `integrity_check` & `foreign_key_check`, `.rfbackup`-only mirroring, 30-day retention, disconnected drive error (`400`), local off-site decrypt & cross-PC fresh-tenant restore verified (`sqlite-backup.test.ts`, `app-flow.test.mjs`) | Real Microsoft OneDrive / Google Drive desktop upload completion, `.tmp-*` file-lock contention with live sync agents, and restore of an archive physically downloaded from cloud web storage remain **NOT VERIFIED** |
| **2** | Disaster Recovery and DPAPI | **`NOT VERIFIED`** | **P1-4 Fixed:** Setup & Settings support custom master passphrase (`dailyBackupKey`); `daily-backup-keyring.bin` (DPAPI) preserves all previous keys across rotations so historical `.rfbackup` files remain recoverable; fresh replacement-PC restore (`allowReplacementTenantId` when target store has zero sales/journals/movements); lockout emergency sign-in + backup export (`app.js`, Playwright E2E #6); updated [SINGLE_DEVICE_DEPLOYMENT_AND_OPERATIONS_AR.md](file:///d:/Store%20Manager/docs/SINGLE_DEVICE_DEPLOYMENT_AND_OPERATIONS_AR.md) | Live Windows OS DPAPI durability across real Windows password reset / OS reinstall / secondary Windows user tests on compiled `RetailOS.exe` remain **NOT VERIFIED** |
| **3** | Installer and Windows Deployment | **`NOT VERIFIED`** *(Unsigned Pilot Accepted)* | `RetailOS-Setup-0.1.0-x64.exe` rebuilt (`132,740,278` bytes) with `RETAILOS_REQUIRE_SIGNED_MANIFEST=1`; Ed25519 runtime `integrity-manifest.json` verified **`{ checked: true, verifiedFiles: 123 }`** (`hasWebData: false`, `hasPrivateKey: false`); Electron `sandbox`/`contextIsolation`/CSP/IPC verified. Unsigned Windows installer is an **accepted project decision** for pilot (Authenticode deferred post-pilot; Windows **Unknown Publisher / SmartScreen** warning expected) | Clean interactive NSIS install, first packaged `RetailOS.exe` offline GUI launch, restart, upgrade over existing `%APPDATA%\RetailOS`, and uninstall/reinstall on a clean target Windows 10/11 machine are **NOT VERIFIED** |
| **4** | Anti-Tamper and Machine Fingerprint | **`NOT VERIFIED`** | **P1-1 Fixed:** Non-blocking startup license check after `server.listen()` ([server.mjs](file:///d:/Store%20Manager/apps/web/server.mjs)); persistent transient hardware failure returns `503 HARDWARE_IDENTITY_UNAVAILABLE` (`retryable: true`) while strictly blocking all financial/operational mutations (`assertOperationalAccess` & `touchWatermarkOnCheckout`); `app.js` renders clear retryable UI + 3s auto-retry instead of swallowing `503` or showing `UNLICENSED` (verified in unit + Playwright E2E #6) | Real Windows OS cold-boot WMI/Registry delay faults without mocked providers remain **NOT VERIFIED** |
| **5** | Real-World Failure Recovery | **`NOT VERIFIED`** | SQLite `WAL` + `synchronous=FULL`; survived abrupt `taskkill /F /T` mid-run with `quickCheckOk=true`, idempotent replay, shift close & balanced Trial Balance; `SQLITE_FULL` rolled back atomically | Real physical AC power loss mid-WAL-fsync & non-SQLite OS `ENOSPC` disk-full fault tests remain **NOT VERIFIED** |
| **6** | Financial Audit Reconciliation | **`PASS`** | Both `24.00 EGP` (`4010`/`6090` `SESSION_CLOSING` variance) and `0.89 EGP` (`89` minor) WAC rounding residual fully reconciled with exact code & zero unexplained GL variance; GL and P&L code left untouched | Optional post-pilot P2: dedicated Cash Overage/Shortage GL accounts (`4090`/`6095`) |
| **7** | Pre-Pilot Code Quality & Stocktake `BigInt` | **`PASS`** | All prior Codex/OpenCode findings + **6 P2 stocktake snapshot coercions** replaced with `toNonNegativeBigInt()` (`unit_wac`, `retail_price` verified for exact minor-unit SQLite persistence, API serialization, and UI/report math); **114/114** un-cached monorepo tests + **6/6** Playwright E2E tests pass | — |

---

## Pre-Pilot Remediation Verification Summary (Pass 2 Evidence)

### 1. P1-1 — Startup Resilience & Fail-Closed `503` Handling (`PASS` in Automated + Mocked E2E Tests)
- [apps/web/server.mjs](file:///d:/Store%20Manager/apps/web/server.mjs): Removed blocking `await licenseService.getStatus()` before `server.listen()`. Added deferred non-blocking warmup after `server.listen()` that catches `LicenseHardwareIdentityError` with warning log so `/api/bootstrap` binds reliably while `GET /api/license/status` returns `503 { code: 'HARDWARE_IDENTITY_UNAVAILABLE', retryable: true }`.
- **Fail-Closed Guarantee Verified:** Every non-exempt mutation continues enforcing `await licenseService.assertOperationalAccess()` (and `touchWatermarkOnCheckout()` on checkout); verified in `app-flow.test.mjs` (`"pre-pilot fixes..."`) that `POST /api/shifts/start` and `POST /api/expenses` return HTTP `503 HARDWARE_IDENTITY_UNAVAILABLE` with zero DB writes while hardware identity is degraded, then resume `201` upon recovery.
- [apps/web/public/app.js](file:///d:/Store%20Manager/apps/web/public/app.js): `fetchLicenseStatusSafe()`, `api()`, `licenseStatusMeta()`, and `licenseActivationView()` handle `503 HARDWARE_IDENTITY_UNAVAILABLE` as explicit `HARDWARE_UNAVAILABLE` with `#license-hardware-retry-box`, manual `#retry-license-status-btn`, and guarded `3000 ms` auto-retry (never displaying `UNLICENSED` or permitting POS access), verified in Playwright E2E Test #6.

### 2. P1-4 — Master Backup Passphrase, Versioned Key Preservation, Cross-PC Restore & Lockout Export (`PASS` in Automated + Mocked E2E Tests)
- **Versioned DPAPI Keyring ([apps/desktop/src/runtime.ts](file:///d:/Store%20Manager/apps/desktop/src/runtime.ts), [apps/desktop/src/main.ts](file:///d:/Store%20Manager/apps/desktop/src/main.ts)):** Added `readDesktopDailyBackupHistory()` and `updateDesktopDailyBackupSecret()` (`daily-backup-keyring.bin` DPAPI-sealed before atomically updating `daily-backup.bin`), wired via `__RETAILOS_DAILY_KEY_UPDATE__:<base64url>` stdout signal. Verified in `desktop-host.test.mjs` (`9/9` passed). **Old recovery keys are never deleted or invalidated across rotations.**
- **Setup & Settings Management ([apps/web/server.mjs](file:///d:/Store%20Manager/apps/web/server.mjs), [apps/web/public/app.js](file:///d:/Store%20Manager/apps/web/public/app.js)):**
  - `POST /api/setup` accepts optional `dailyBackupPassphrase` (`12–256` printable chars) and shows the active `dailyBackupKey` one-time banner (`#post-setup-daily-key-banner`) right after setup.
  - Added password-verified Owner-only `POST /api/backups/daily/master-key` to update/set a custom master passphrase, preserve all historical passphrases, and immediately re-encrypt & mirror today's daily `.rfbackup`.
  - Updated `POST /api/backups/daily/key-export` to return both active `dailyBackupKey` and preserved `previousDailyBackupKeys`, and updated `POST /api/backups/daily/restore` & `findNewestVerifiedCandidate()` to try all candidate keys (`[active, ...historicalDailyBackupKeys]`).
- **Replacement-PC Cross-Tenant UUID Support ([packages/infrastructure/src/backup/sqlite-backup.service.ts](file:///d:/Store%20Manager/packages/infrastructure/src/backup/sqlite-backup.service.ts), [apps/web/server.mjs](file:///d:/Store%20Manager/apps/web/server.mjs)):** `prepareEncryptedSqliteRestore` supports optional `allowReplacementTenantId: true` (still enforcing strict `code` & `currency` match); `POST /api/backups/restore` enables it **only** on a fresh unpopulated replacement store (`sales === 0 && journal_entries === 0 && stock_movements === 0`), while `sqlite-backup.test.ts` continues asserting rejection of mismatched tenant IDs by default and mismatched `code`/`currency` always (`7/7` passed).
- **Lockout Emergency Export ([apps/web/public/app.js](file:///d:/Store%20Manager/apps/web/public/app.js)):** Unauthenticated `MACHINE_MISMATCH` / `EXPIRED` / `CLOCK_TAMPERED` lockout screens now provide `#license-open-login-btn` so an `OWNER` can authenticate, enter emergency backup mode (`#license-unlicensed-backup-banner`), and download/restore `.rfbackup` archives (verified on real `EXPIRED` server state in Playwright E2E Test #6).
- **Updated Operations & DR SOP ([docs/SINGLE_DEVICE_DEPLOYMENT_AND_OPERATIONS_AR.md](file:///d:/Store%20Manager/docs/SINGLE_DEVICE_DEPLOYMENT_AND_OPERATIONS_AR.md)):** Replaced all outdated Node.js / plaintext `.sqlite` copy steps with the packaged Electron `%APPDATA%\RetailOS`, unsigned SmartScreen pilot guidance + Ed25519 manifest check, offline `dailyBackupKey` custody, cloud mirror verification, `MACHINE_MISMATCH` replacement-PC recovery, and `CLOCK_TAMPERED` SOP.

### 3. P2 — Stocktake Monetary Snapshot `BigInt` Coercions (`PASS`)
- Verified schema (`021_stocktake_sessions.ts`: `unit_wac` & `retail_price` integer minor piasters), `syncStocktakeDraftTotals`, `loadStocktakeSessionDetail`, `commitStocktake`, `export.csv`, and UI `money()` all consume integer minor units (`BigInt`).
- Replaced all 6 `Math.max(0, Number(...))` snapshot coercions in [apps/web/server.mjs](file:///d:/Store%20Manager/apps/web/server.mjs) (`stocktake_lines` creation, scan, and `addVariantId`) with `toNonNegativeBigInt()`, preserving exact integer precision (`unitCost: '500000000000'`, `retailPrice: '1234567890123'`) verified in `app-flow.test.mjs`.

---

## Verified Un-Cached Quality Gates & Test Results (Executed After Final Code Edit)

| Check / Suite | Scope | Result (Actual Observed Output) |
| :--- | :--- | :--- |
| `pnpm exec turbo run build --force` | All 6 workspace build targets | **6 / 6 successful** (`0 cached`, `22.263s`) |
| `pnpm exec turbo run lint --force` | Syntax + ESLint (`--max-warnings 0`) across 7 packages | **10 / 10 successful** (`0 cached`, `0 warnings`, `1m32.43s`) |
| `pnpm exec turbo run typecheck --force` | TypeScript `--noEmit` across TS packages | **9 / 9 successful** (`0 cached`, `23.288s`) |
| `pnpm exec turbo run test --concurrency=1 --force` | All 5 test suites (`@retailos/core`: 34, `application`: 5, `infrastructure`: 50, `web`: 16, `desktop`: 9) | **114 / 114 tests passed** (`9 / 9 tasks`, `0 failed`, `0 skipped`, `3m38.697s`) |
| `pnpm --filter @retailos/web test:e2e` | Chromium real-browser E2E (incl. new Test #6: `503` retry & `EXPIRED` lockout export) | **6 / 6 passed** (`57.0s`) |
| `pnpm --filter @retailos/desktop desktop:dist:win` | Clean NSIS packaging with `RETAILOS_REQUIRE_SIGNED_MANIFEST=1` | **`RetailOS-Setup-0.1.0-x64.exe` built (`132,740,278` bytes)**; `verifyStagedRuntimeIntegrity` **`{ checked: true, verifiedFiles: 123 }`**, `hasWebData: false`, `hasPrivateKey: false` |

> **Accepted Windows Signing Decision:** `RetailOS-Setup-0.1.0-x64.exe` and `RetailOS.exe` remain **unsigned (no Authenticode certificate)** for pilot deployment. Windows SmartScreen / **Unknown Publisher** warnings are expected until commercial Authenticode code signing is added post-pilot; runtime code integrity is enforced by the Ed25519-signed 123-file `integrity-manifest.json`.

---

## Required Physical Pilot Rehearsal Checklist (Before Declaring Store Live-Ready)

1. **Clean Windows 10/11 Install (`NOT VERIFIED`):** Copy `apps/desktop/release/RetailOS-Setup-0.1.0-x64.exe` to a clean target Windows machine -> acknowledge expected Windows SmartScreen / Unknown Publisher prompt -> complete install -> verify app runs without Node.js installed and writes state under `%APPDATA%\RetailOS`.
2. **Offline License & Boot Check (`NOT VERIFIED`):** Disconnect internet -> launch **RetailOS** -> issue/activate `ROS1...` token for displayed `Machine ID` -> reboot Windows offline and verify clean startup (`ACTIVE`, balanced reports).
3. **Owner Setup & `dailyBackupKey` Custody (`NOT VERIFIED`):** Set a custom master backup passphrase at Setup (or rotate via **النسخ الاحتياطي**) -> store it offline (password manager + printed safe copy, **never** inside cloud drive).
4. **Live Cloud Sync (`NOT VERIFIED`):** Configure external mirror to active `OneDrive\RafBackups` or `Google Drive\RafBackups` -> click **حفظ نسخة يومية فورية الآن** -> verify Google Drive / OneDrive web portal shows **only** `retailos-daily-YYYY-MM-DD.rfbackup` and `retailos-latest.rfbackup` (zero `.sqlite`, `-wal`, or `-shm` files).
5. **Cloud-Downloaded Replacement-PC Restore (`NOT VERIFIED`):** Record 1 test sale -> download `retailos-latest.rfbackup` from OneDrive / Google Drive onto a second clean machine/user profile -> install RetailOS, activate target token, complete temp setup -> restore downloaded `.rfbackup` via UI using `dailyBackupKey` -> enter target `Machine ID` token again if `MACHINE_MISMATCH` appears -> verify test sale restored and Trial Balance balanced (`SUM(debits) === SUM(credits)`).

---

## Final Recommendation

### **`NOT READY`**

All targeted technical fixes (`P1-1`, `P1-4` including versioned DPAPI key preservation & replacement-PC cross-tenant restore, and `P2` 6 stocktake `BigInt` coercions) are implemented and verified across **114/114** un-cached monorepo tests, **6/6** Playwright browser E2E tests, and a freshly packaged **123-file Ed25519 manifest-verified** `RetailOS-Setup-0.1.0-x64.exe`.

However, automated/mocked tests do **not** establish real-world operational readiness on their own: clean-Windows NSIS installation/upgrade, live OneDrive/Google Drive cloud upload behavior, and actual cloud-downloaded replacement-PC restoration remain **`NOT VERIFIED`** until you execute the 5-step Physical Pilot Rehearsal Checklist above.
