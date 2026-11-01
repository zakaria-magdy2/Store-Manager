# RetailOS — Project Documentation Policy

> [!IMPORTANT]
> **MANDATORY POLICY FOR ALL AI AGENTS AND ENGINEERS WORKING ON RETAILOS**
> Every AI agent or human developer contributing to this repository must strictly adhere to the rules outlined below.

---

## 1. Rule of Grounded Reality (No Hallucinated Progress)
- **Always Inspect Before Acting**: Before starting any task, inspect the actual directory structure and source files.
- **Never Assume Planned Features Are Built**: Even if a feature is detailed in the architecture blueprint, it does NOT exist until verified in the actual repository files.
- **Never Claim Work Was Completed Without Verification**: You must run the appropriate build, test, or lint commands and inspect the exit code and output before reporting completion.

---

## 2. Reading Protocol for New AI Sessions
When beginning a new session or resuming work, you must execute the following reading protocol in order:
1. Read `PROJECT_DOCUMENTATION_POLICY.md` (this file).
2. Read `PROJECT_CONTEXT.md` to identify:
   - The current project state.
   - The latest completed task.
   - The exact stopping point.
   - The approved architectural constraints.
3. Read `docs/architecture/ARCHITECTURE_DECISIONS.md` to understand why decisions were made.
4. Verify the actual files in `packages/` and `apps/` to ground yourself in the real code state.

---

## 3. Documentation Maintenance Mandate
After completing any meaningful task, module, or phase:
1. **Update `PROJECT_CONTEXT.md`**:
   - Update the current project status and phase progress table.
   - Record the latest completed task.
   - Specify the exact stopping point and the unambiguous next step.
   - Document any newly identified edge cases or technical constraints.
2. **Update `docs/architecture/ARCHITECTURE_DECISIONS.md`**:
   - If an architectural choice was approved, log it under the approved ADR section.
3. **Update `CHANGELOG.md`**:
   - Record newly created or modified files.
   - Record tests executed and their real outcomes (e.g. `24 passed, 0 failed`).
4. **Never Ask the User to Maintain Documentation**:
   - You (the AI agent) must update the Markdown files inside the project folder directly.

---

## 4. Architectural Invariants (Non-Negotiable)
1. **Clean Architecture Boundary**:
   - `packages/core` contains pure domain models and rules. It has **zero dependencies** on Electron, React, or database drivers.
2. **Financial Precision**:
   - No floating-point math (`parseFloat`, `Number(amount)`) is permitted in financial calculations.
   - All amounts are stored as `BIGINT` minor units and computed using the `Money` value object or native `BigInt`.
   - VAT is explicitly out of scope.
3. **Database Isolation**:
   - The Electron renderer process must never have direct database access. All persistence is orchestrated in the Node main process via secure, typed IPC handlers.
4. **Immutability of Historical Accounting**:
   - Completed sales, historical cost snapshots (`unit_cost_snapshot`), and posted journal entries must never be modified or deleted. Corrections must occur via compensating reversal entries.
5. **Operating Expense & Cash Separation**:
   - Daily reports amortize monthly recurring commitments over actual calendar days in the month.
   - Paying a monthly bill must be recorded as an accrued liability settlement (balance sheet movement), NEVER as a direct daily expense on the payment date, preventing double-counting.
   - Operating Profit (accrual) must remain strictly decoupled from Cash Flow (liquidity).
