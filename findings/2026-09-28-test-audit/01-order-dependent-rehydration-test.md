# workload-tenant-rehydration.test.ts fails in 2 of 5 shuffled runs: one test permanently overrides a module mock that clearAllMocks does not reset

**Triage:** RECORD (high confidence, `test`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

`rehydrate_all_owners recovers every owner found on the replica` passes in file order and fails
whenever `rehydrate_all_sites recovers every site found on the replica` runs before it.

The file mocks `rehydrate_manifests` at module level to resolve 4 objects and 400 bytes. The
SharePoint test replaces that with `vi.mocked(rehydrate_manifests).mockResolvedValue(...)`
returning 30 objects. The `beforeEach` resets with `vi.clearAllMocks()`, which clears call
history but keeps implementations, so the 30-object value leaks into every later test. The
OneDrive test then counts 2 × 30 instead of 2 × 4.

CI is green only because Vitest runs a file's tests in declaration order. Adding a test above
it, running with `-t`, or turning on `sequence.shuffle` exposes it.

## Steps to reproduce

```bash
cd packages/core
pnpm exec vitest run tests/unit/services/replication/workload-tenant-rehydration.test.ts \
  --sequence.shuffle --sequence.seed=3
```

```
FAIL  ... > rehydrate_all_owners recovers every owner found on the replica
AssertionError: expected 60 to be 8 // Object.is equality
 ❯ tests/unit/services/replication/workload-tenant-rehydration.test.ts:170:35
```

Seeds `3`, `15838` and `31676` fail; `1` and `2` pass.

## Expected

Each test passes regardless of order.

## Actual

The OneDrive count depends on whether the SharePoint test ran first.

## Code references

- `packages/core/tests/unit/services/replication/workload-tenant-rehydration.test.ts:25`, the
  module-level default.
- `:121`, `vi.clearAllMocks()` in `beforeEach`.
- `:251`, `mockResolvedValue` in the SharePoint test.
- `:170`, the assertion that fails.

## How it was found

The full unit suite (1,894 tests in 281 files) was run five times per package with
`--sequence.shuffle` and seeds 7919 × n. This was the only failure across the 50 package runs.

## Acceptance criteria

- The SharePoint test uses `mockResolvedValueOnce`, or `beforeEach` restores the default
  implementation, so no test's mock value outlives it.
- The file passes with `--sequence.shuffle` for seeds `3`, `15838` and `31676`.
- Optional: run the unit suite with `sequence.shuffle` in CI (or once nightly) so the next
  order dependency is caught when it is written.
