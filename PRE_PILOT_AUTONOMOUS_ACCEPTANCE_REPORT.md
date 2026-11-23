# RetailOS — Autonomous Pre-Pilot Windows Acceptance Test Report

**Execution Window:** 2026-11-19 `17:36`–`18:07` Africa/Cairo (`2026-11-19T15:36:04Z`–`16:07:28Z`)  
**Audited Installer:** `apps/desktop/release/RetailOS-Setup-0.1.0-x64.exe`  
**Production DB Protection:** Confirmed untouched (`apps/web/data/retailos.sqlite` never accessed or modified; all tests executed inside an isolated temporary folder under `%TEMP%\retailos-acc-20261119-173844`, cleanly uninstalled afterward).  
**Final Verdict:** **`NOT READY`** *(Critical **P0** packaging defect discovered preventing the installed `RetailOS.exe` Electron desktop GUI from booting; plus physical Windows network-adapter disable, secondary physical PC, and live cloud web-portal sync/download remain `BLOCKED` / `NOT VERIFIED`.)*

---

## 1. Environment & Packaged Artifact Details

| Parameter | Observed Value |
| :--- | :--- |
| **Operating System** | Microsoft Windows 10 Pro (`10.0.19045`, Build `19045`, `64-bit`) |
| **Execution Account** | `desktop-8egblrn\dar_mr` (Standard non-Administrator user: `isAdmin: false`) |
| **Installer File** | `apps/desktop/release/RetailOS-Setup-0.1.0-x64.exe` (`132,740,278` bytes) |
| **Installer SHA-256** | `3871F8D58589084173E0C5DF532470AA02DD9880F375DA06038A6BE923BE1E26` |
| **Installed Binary (`RetailOS.exe`) SHA-256** | `B0AD1F967D20DB7A84DAFE8F9170D41AA0C4F924F521EB32AD816397DB491D9B` |
| **Authenticode Signature Status** | `NotSigned` *(Accepted pilot policy; Windows Defender SmartScreen / Unknown Publisher prompt expected on interactive store PC install)* |
| **Embedded Desktop Runtime** | Electron `45.3.3` / Embedded Node `24.22.3` (`ELECTRON_RUN_AS_NODE=1`) |
| **System Host State After Cleanup** | Uninstalled cleanly (`Uninstall RetailOS.exe /S` exit `0`), `0` leftover processes, `%APPDATA%\RetailOS` untouched (`false`), temp root deleted (`true`) |

---

## 2. Executive Test Matrix (Phases 1–7)

| Test ID | Phase & Check | Result | Mode (Real Packaged / Simulation / Blocked) | Evidence Summary |
| :--- | :--- | :---: | :--- | :--- |
| `ACC-P1-01` | Silent NSIS Install into Isolated Temp Path | **`PASS`** | Real Installer | `RetailOS-Setup-0.1.0-x64.exe /S /D=...` exited `0`; `RetailOS.exe`, `app.asar`, `resources/web`, `Uninstall RetailOS.exe` verified |
| `ACC-P1-02` | Staged Bundle Cleanliness & Ed25519 Integrity Manifest | **`PASS`** | Real Installed Files | `verifyStagedRuntimeIntegrity` -> `{ checked: true, verifiedFiles: 123 }`; `hasSqliteInWeb: false`, `hasKeygenOrPem: false` |
| `ACC-P1-03` | Packaged `RetailOS.exe` Desktop GUI Launch (`app.asar`) | **`FAIL`** *(P0)* | Real Installed Binary | **`RetailOS.exe` fails to boot GUI / create `.retailos-control.json`**. `app.asar/dist/runtime.js` crashes with `ERR_MODULE_NOT_FOUND: Cannot find package '@retailos/infrastructure'` |
| `ACC-P1-04` | Embedded Node Server Execution Without System Node on `PATH` | **`PASS`** | Real Installed `RetailOS.exe` (`ELECTRON_RUN_AS_NODE=1`) + `resources/web/server.mjs` | Launched `resources/web/server.mjs` using `RetailOS.exe` (`Node 24.22.3`) with `C:\Windows\System32` PATH only in `3828 ms`; strict `127.0.0.1` loopback listener verified |
| `ACC-P1-05` | Clean NSIS Uninstall | **`PASS`** | Real Uninstaller | `Uninstall RetailOS.exe /S` exited `0`; `0` remaining processes & `0` HKCU uninstall entries |
| `ACC-P2-01` | Hardware Adapter Network Disconnect Toggle | **`BLOCKED`** | Windows OS Non-Admin | `Disable-NetAdapter -Name "Wi-Fi"` denied (`PermissionDenied / Windows System Error 5` — `isAdmin: false`); confirmed `0` external outbound TCP connections from local server |
| `ACC-P2-02` | Unlicensed Fail-Closed Enforcement & Activation | **`PASS`** | Packaged `resources/web/server.mjs` | Initial status `UNLICENSED`, invalid token rejected (`400`), unlicensed product creation blocked (`402 LICENSE_REQUIRED`), synthetic 1-day test token activated (`ACTIVE`) |
| `ACC-P2-03` | Hardware Unavailable `503` UI & Desktop DPAPI Persistence Live | **`NOT VERIFIED`** | Blocked by `ACC-P1-03` / Integrity Lock | Cannot test live Electron DPAPI `.bin` or inject hardware faults into installed `RetailOS.exe` due to `ACC-P1-03` `app.asar` crash and manifest sealing *(previously covered only via mocked unit/Playwright route tests)* |
| `ACC-P3-01` | Full 13-Step Business Workflow & Multi-Role RBAC | **`PASS`** | Packaged `resources/web/server.mjs` + Chromium | Setup, Owner/Manager/Cashier/Auditor RBAC (`403` on Auditor shift & Cashier P&L/discount), multi-size/color variants, partial-paid purchase, `410` `/inventory/receive` guard, POS single & split sales + idempotent replay, return, exchange, supplier return, shift open/end/close (`-2.00 EGP` variance), direct & monthly expenses, treasury transfer, daily/monthly reports all passed |
| `ACC-P4-01` | Full Double-Entry GL, Inventory WAC, & P&L Integrity Audit | **`PASS`** | Direct Read-Only SQLite Inspection + API | Trial Balance balanced (`1156533 === 1156533` minor), `0` unbalanced/orphan/duplicate journals, `0` negative stock, `0` WAC residual, unpaid confirmed expense excluded from P&L (`0` vs `500.00 EGP` pending) |
| `ACC-P5-01` | Master Backup Passphrase, Rotation Preservation, & Corruption Rejection | **`PASS`** | Packaged `resources/web/server.mjs` (`RFBK1`) | Mirror contained **only** `.rfbackup` files (`0` SQLite/WAL/SHM/plaintext keys); rotation preserved old key (`historicalKeysCount: 1`); old & new backups decrypt cleanly; wrong passphrase, flipped-byte corruption, and 50%-truncated archive all rejected |
| `ACC-P6-01` | Replacement-PC / Cross-Profile DPAPI & License Isolation | **`PARTIAL / NOT VERIFIED`** | Isolated Server & Mock DPAPI Simulation | Simulated separate DPAPI key (`PC1` vs `PC2`) rejected cross-profile decryption; restored backup DB into fresh store (`3` sales, balanced GL `1156533 === 1156533`, auth/license enforced); **real Windows secondary OS user & physical second computer NOT VERIFIED** |
| `ACC-P7-01` | Live Cloud Web Sync & Cloud-Downloaded Restore | **`NOT VERIFIED`** | No Authenticated Cloud Session | No authorized Google Drive / OneDrive web portal authentication available to confirm remote upload completion or cloud portal download |

---

## 3. Critical Defect Discovered

### `[P0-ACC-01]` Packaged Desktop Executable (`RetailOS.exe`) Fails to Launch (`app.asar` Missing `@retailos/infrastructure`)
- **Severity:** **P0 — Release Blocker**
- **Affected Files (Read-Only Finding — Not Edited):**
  - `apps/desktop/src/runtime.ts:15`: `import { EMBEDDED_LICENSE_PUBLIC_KEY_PEM } from '@retailos/infrastructure';`
  - `apps/desktop/electron-builder.json:12-19`: `"files": ["dist/main.js", "dist/runtime.js", "dist/preload.cjs", "package.json", "!node_modules/**/*", ...]`
- **Reproduction & Exact Failure Output:**
  1. Install `apps/desktop/release/RetailOS-Setup-0.1.0-x64.exe` into an isolated folder.
  2. Launch `RetailOS.exe` GUI (hung `>4s` without creating `userData`, `desktop.log`, or `.retailos-control.json`).
  3. Inspect module loading in `app.asar` via `RetailOS.exe` (`ELECTRON_RUN_AS_NODE=1`):
     ```text
     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@retailos/infrastructure' imported from
     C:\Users\DAR_MR\AppData\Local\Temp\retailos-acc-20261119-173844\app\resources\app.asar\dist\runtime.js
     ```
- **Impact:** Any user installing `RetailOS-Setup-0.1.0-x64.exe` on a clean Windows machine cannot start the desktop application at all. All workspace automated tests passed only because `apps/desktop/tests/desktop-host.test.mjs` resolves `@retailos/infrastructure` from monorepo workspace `node_modules`, whereas `electron-builder` strips `node_modules` from `app.asar`.
- **Status:** Source code intentionally unmodified per strict acceptance rules; awaiting approval before remediation.

---

## 4. Phase 1–2 Detailed Evidence & Sanitized Commands

### Commands Executed (Sanitized)
```powershell
# Phase 1 Environment & Hash Check
powershell -NoProfile -ExecutionPolicy Bypass -File "...\scratch\phase1-env.ps1"

# Phase 1 Isolated Silent Install
RetailOS-Setup-0.1.0-x64.exe /S /D=C:\Users\DAR_MR\AppData\Local\Temp\retailos-acc-20261119-173844\app

# Autonomous Acceptance Harness (Phases 1-6 against installed files)
node "...\scratch\run-packaged-acceptance.mjs"

# Phase 1 Clean Uninstall & Host Verification
powershell -NoProfile -ExecutionPolicy Bypass -File "...\scratch\cleanup-uninstall.ps1"
```

### Observed Environment & Isolation Proof
- Embedded Node check via installed `RetailOS.exe` with `PATH=C:\Windows\System32;C:\Windows`: **`24.22.3 / electron 45.3.3`**.
- Installed `resources/web` integrity verification: **`{ checked: true, verifiedFiles: 123 }`**, `hasSqliteInWeb: false`, `hasKeygenOrPem: false`.
- Loopback binding on spawned packaged web server (`PID 14196`): **`127.0.0.1:4391` only**, `outboundConnectionsFromServer: 0`.
- Licensing gate (`ACC-P2-02`): initial status `UNLICENSED`, bad `ROS1` signature rejected (`400`), unlicensed `POST /api/products` blocked (`402 LICENSE_REQUIRED`), synthetic 1-day test token activated (`ACTIVE`, token masked).

---

## 5. Phase 3 & Phase 4 — Financial Integrity & Workflow Reconciliation

All 13 business operations completed cleanly against the installed `resources/web/server.mjs` running on `RetailOS.exe` embedded Node (`ELECTRON_RUN_AS_NODE=1`), with synthetic EGP minor units (`100 minor = 1.00 EGP`):

### Synthetic Operations Executed
1. Created Store Owner + `STORE_MANAGER`, `CASHIER`, and `AUDITOR` employees; verified RBAC blocks (`AUDITOR` shift start `403`, `CASHIER` P&L report `403`, `CASHIER` discounted checkout `403`).
2. Created categorized apparel product (`ACC-TSHIRT`) with Size (`M`/`L`) and Color (`أسود`/`أبيض`) variants (`250.00 EGP` and `300.00 EGP`).
3. Posted opening balances: Cash Drawer `500.00 EGP`, Safe `2,000.00 EGP`, Bank `3,000.00 EGP`.
4. Confirmed `POST /api/inventory/receive` returns `410` (coupled stock + AP receipt via `POST /api/purchases` only).
5. Recorded Purchase (`10 × 100.00 + 10 × 120.00 = 2,200.00 EGP`), paid `1,200.00 EGP` via Bank + `400.00 EGP` installment via Cash Drawer, and processed Supplier Return (`2 × 120.00 = 240.00 EGP` AP credit) → remaining AP = `360.00 EGP`.
6. Opened shifts; verified underpaid POS checkout rejects (`400`); executed discounted Sale #1 (`3 × 250.00 - 50.00 = 700.00 EGP` Cash) twice with same `idempotencyKey` (proving `idempotentSaleRowCount = 1` with identical sale ID); executed split Sale #2 (`2 × 300.00 = 600.00 EGP`: `250.00 CASH + 350.00 CARD`).
7. Processed Customer Return (`1` unit from Sale #1, pro-rata net refund `233.33 EGP` / `23,333` minor) and Exchange (`1` White `300.00 EGP` returned for `1` Black `250.00 EGP`, `50.00 EGP` net cash refund).
8. Recorded Paid Direct Expense (`30.00 EGP` Cash Drawer), **Confirmed Unpaid Monthly Rent (`500.00 EGP` — excluded from P&L)**, and Confirmed + Paid Monthly Utilities (`100.00 EGP` Cash Safe).
9. Transferred `150.00 EGP` from Cash Drawer (`1010`) to Cash Safe (`1015`), ended Cashier shift, and closed Accounting Drawer with intentional `-2.00 EGP` shortage (`200` minor → `SHORTAGE`).

### Financial Reconciliation Table (Exact Observed Minor Units & EGP)

| Audit Check | Ledger / SQLite / Trial Balance | Report API (`P&L` / `Financial Map` / Subledger) | Variance | Verdict |
| :--- | :--- | :--- | :---: | :---: |
| **Trial Balance Total Debits = Credits** | `1,156,533` minor (`11,565.33 EGP`) | `1,156,533` minor (`11,565.33 EGP`) | **`0`** | **`PASS`** |
| **Raw SQLite `journal_lines` Equality** | Debits `1,156,533` = Credits `1,156,533` | Unbalanced `0`, Orphans `0`, Duplicate Keys `0` | **`0`** | **`PASS`** |
| **Net Sales (`4010 - 4020 - 4030`)** | `101,667` minor (`1,016.67 EGP`) | P&L `netSales` = `101,667` (`1,016.67 EGP`) | **`0`** | **`PASS`** |
| **COGS (`5010 + 5090`)** | `42,000 + 0 = 42,000` (`420.00 EGP`) | P&L `cogs` = `42,000` (`420.00 EGP`) | **`0`** | **`PASS`** |
| **Inventory Valuation (`1300` vs `qty * wac_cost`)** | GL `1300` = `154,000` (`1,540.00 EGP`) | `SUM(qty * wac_cost)` = `154,000`; negative stock `0` | **`0`** | **`PASS`** |
| **Liquid Cash & Bank (`1010 + 1015 + 1020`)** | `58,467 + 205,000 + 215,000 = 478,467` | Financial Map `runningFinalCash` = `478,467` (`4,784.67 EGP`) | **`0`** | **`PASS`** |
| **Supplier Payables (`2010`)** | Net Credit `36,000` (`360.00 EGP`) | `220,000 - 120,000 - 40,000 - 24,000 = 36,000` | **`0`** | **`PASS`** |
| **Expenses (`6090`) & Shift Variance** | GL `6090` = `13,200` (`132.00 EGP`) | P&L Direct `3,000` + Monthly Paid `10,000` + Shortage `200` = `13,200` | **`0`** | **`PASS`** |
| **Unpaid Monthly Expense Recognition** | Confirmed Rent `50,000` unpaid | Before payment: `monthlyExpenses = 0`, `pendingUnpaidObligations = 50,000` | **`0`** | **`PASS`** |
| **Net Operating Profit** | GL Derived = `46,467` (`464.67 EGP`) | Day P&L `46,467` = Month P&L `46,467` = FinMap `46,467` | **`0`** | **`PASS`** |

---

## 6. Backup, Recovery & Cross-Profile Evidence (Phases 5–6)

- **Mirror Hygiene:** Local mirror directory contained strictly `["retailos-daily-2026-11-19.rfbackup", "retailos-latest.rfbackup"]` (`mirrorContainsOnlyRfbackup: true`), with zero `.sqlite`, `-wal`, `-shm`, `.tmp-*`, or plaintext key files (`noPlaintextKeysInDataDir: true`).
- **Master Passphrase Rotation & Old-Key Preservation:** Rotating the synthetic master passphrase preserved Key #1 in history (`keyRotationHistoricalPreservedCount: 1`), returned both Key #2 and historical Key #1 via Owner-verified `/api/backups/daily/key-export`, kept the pre-rotation `.rfbackup` decryptable via Key #1 (`oldBackupRestorableWithKey1: true`), and decrypted the post-rotation `.rfbackup` via Key #2 (`newBackupRestorableWithKey2: true`).
- **Corruption & Tamper Rejections:** Wrong passphrase (`wrongPassRejected: true`), mid-file byte corruption (`corruptArchiveRejected: true` + `POST /api/backups/restore` returned HTTP `400`), and 50%-truncated archive (`truncatedArchiveRejected: true`) were all cleanly rejected.
- **Cross-Profile / Replacement-PC Simulation:**
  - Simulated cross-profile DPAPI decryption (`PC1` blob on `PC2`) rejected cleanly (`dpapiCrossProfileDecryptionBlocked: true`).
  - Restoring the `.rfbackup` into a clean replacement DB with a distinct tenant UUID (`allowReplacementTenantId: true`) succeeded, preserving all `3` completed sales and exact GL equality (`1,156,533 === 1,156,533`), while blocking unauthenticated operational writes.
  - **Gap / Caveat:** Desktop `safeStorage` DPAPI keyring persistence (`daily-backup-keyring.bin` inside Electron main) and real secondary Windows user / second physical PC execution remain **`NOT VERIFIED`** due to `[P0-ACC-01]` and single-host non-admin constraints.

---

## 7. Captured GUI Screenshots (Sensitive Values Excluded)

1. Unlicensed Gate (`acc_01_packaged_license_gate.png`): [acc_01_packaged_license_gate.png](file:///C:/Users/DAR_MR/.gemini/antigravity/brain/335741ff-4d28-4719-983e-962b34bb2d70/screenshots/acc_01_packaged_license_gate.png)
2. Dashboard Post-Activation & Sales (`acc_02_packaged_dashboard.png`): [acc_02_packaged_dashboard.png](file:///C:/Users/DAR_MR/.gemini/antigravity/brain/335741ff-4d28-4719-983e-962b34bb2d70/screenshots/acc_02_packaged_dashboard.png)
3. POS Screen (`acc_03_packaged_pos.png`): [acc_03_packaged_pos.png](file:///C:/Users/DAR_MR/.gemini/antigravity/brain/335741ff-4d28-4719-983e-962b34bb2d70/screenshots/acc_03_packaged_pos.png)
4. P&L Financial Report (`acc_04_packaged_reports.png` — confirms `1016.67` Net Sales, `420.00` COGS, `132.00` Expenses + Shift Shortage, `464.67` Net Profit, `500.00` Unpaid Obligations alert): [acc_04_packaged_reports.png](file:///C:/Users/DAR_MR/.gemini/antigravity/brain/335741ff-4d28-4719-983e-962b34bb2d70/screenshots/acc_04_packaged_reports.png)
5. Backup Safety Screen (`acc_05_packaged_backups.png`): [acc_05_packaged_backups.png](file:///C:/Users/DAR_MR/.gemini/antigravity/brain/335741ff-4d28-4719-983e-962b34bb2d70/screenshots/acc_05_packaged_backups.png)

---

## 8. Final Verdict & Next Actions

### **`NOT READY`**

1. **Must Fix `[P0-ACC-01]` (Awaiting Approval Before Editing Source Code):** Resolve `@retailos/infrastructure` resolution failure inside packaged `resources/app.asar/dist/runtime.js` (e.g., inline/load `EMBEDDED_LICENSE_PUBLIC_KEY_PEM` cleanly without requiring workspace `node_modules` inside `app.asar`, then rebuild and re-test actual `RetailOS.exe` desktop GUI launch + Windows DPAPI `license-watermark.bin` / `daily-backup.bin` / `daily-backup-keyring.bin`).
2. **Remaining Non-Automatable Physical Checks (`BLOCKED` / `NOT VERIFIED`):** Admin/physical network disconnect offline launch check, real Windows secondary-user/second-PC replacement test, and live Google Drive / OneDrive authenticated upload & portal download restore.
