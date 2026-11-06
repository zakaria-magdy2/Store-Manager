# Engineering Quality Gates

These rules apply to every change in RetailOS. A change is ready to merge only
when the relevant tests are included and all workspace quality commands pass.

## 1. Lint rules

- ESLint is the source of truth for linting. Run `pnpm run lint`; it must finish
  with zero errors and zero warnings.
- Do not weaken or disable a shared rule to make a change pass. A necessary
  exception must be narrow and include a same-line explanation of why it is safe.
- Do not use `any`, leave unused variables, or leave unhandled promises.
- Financial code must use `Money` and `bigint` minor units. Do not convert money
  through `Number`, `parseFloat`, `parseInt`, or floating-point rounding.
- Keep imports type-only when the imported symbol is used only as a type.
- Lint does not replace TypeScript validation. Run `pnpm run typecheck` as a
  separate gate.

## 2. Unit tests

- Put pure domain tests in `packages/core/tests/` and application service tests
  in `packages/application/tests/`.
- Unit tests must not open a database, contact the network, read the clock
  without a controlled date, or access real hardware. Replace ports with small,
  deterministic fakes.
- Cover observable business rules, boundary values, and failure behavior. Avoid
  tests that only mirror private implementation details.
- Every bug fix must add a regression case that fails before the fix.
- Use Vitest and descriptive `*.test.ts` names. Tests must be repeatable and
  independent of execution order.

## 3. Integration tests

- Put persistence and adapter integration tests in
  `packages/infrastructure/tests/`.
- Use a real in-memory SQLite database, run the registered migrations, and test
  the production repository/adapter path. Do not replace SQL behavior with mocks
  in an integration test.
- Cover transaction boundaries and rollback, tenant/store isolation, database
  constraints, append-only rules, and idempotent retry behavior where relevant.
- Close every database manager in `afterEach` and await the close operation.
- External devices may be represented by a recording byte transport; tests must
  assert the bytes sent and must never require a physical printer or scanner.

## Required workspace gates

Run all four commands before merging a change:

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

The `Quality Gates / Lint, typecheck, test, build` workflow runs on every pull
request and push. Configure that workflow as a required branch-protection check
to block merges when a gate fails. Do not mark a phase or acceptance criterion
complete based only on lint or typecheck results. Coverage percentages are not
currently enforced; establish a measured baseline before setting numeric
thresholds.

## Security gates

Follow [`SECURITY_POLICY.md`](SECURITY_POLICY.md). The `Security` workflow runs
CodeQL analysis and production dependency audit on pushes, pull requests, and a
weekly schedule; dependency review blocks new high or critical vulnerable
dependencies. Configure these checks as required branch-protection checks.
Enable secret scanning and push protection in repository settings where
available. A successful CI run does not replace those host-level controls or a
release security review.
