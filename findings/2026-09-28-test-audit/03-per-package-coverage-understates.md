# Coverage reports only count a package's own tests, so drive reads 26% and types 16% when both are above 90%

**Triage:** RECORD (high confidence, `test`, `code smell`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Problem or motivation

Each package's `vitest.config.ts` sets `coverage.include: ['src/**/*.ts']`, relative to that
package. Shared code is mostly exercised through other packages: `drive` through `onedrive` and
`sharepoint`, `core` and `types` through everyone. Those runs are not counted, so `pnpm run
test:coverage` reports numbers that point work at the wrong places.

| Package      | Per-package lines | Merged lines | Merged branches |
| ------------ | ----------------- | ------------ | --------------- |
| `drive`      | 26.1%             | 91.1%        | 85.2%           |
| `types`      | 16.2%             | 94.8%        | 87.5%           |
| `core`       | 88.2%             | 92.8%        | 82.3%           |
| `m365-graph` | 76.7%             | 89.4%        | 86.2%           |
| `onedrive`   | 84.3%             | 85.6%        | 74.1%           |
| `sharepoint` | 79.0%             | 80.4%        | 64.9%           |
| `s3`         | 75.4%             | 80.0%        | 64.7%           |
| `outlook`    | 88.9%             | 90.4%        | 80.8%           |
| `cli`        | 60.4%             | 64.1%        | 53.4%           |
| `sdk`        | 96.7%             | 96.7%        | 94.8%           |

The per-package run lists 17 `drive` files at 0%, including `verify-snapshot.ts`,
`upload-session.ts` and `version-restore.ts`. Merged, none of them is at 0%, and the real gaps
are elsewhere (#444).

It also hides one file that really is at 0%: `core/src/services/shared/owner-id-migration.ts`
(50 lines, 4% merged) copies and deletes storage keys to move owners from email to object id
paths, and nothing in `src` calls it. It is exported from the `core` services barrel only. Either
it is dead and should go, or a caller is missing.

## Proposed solution

Collect coverage for the workspace's `src` from every package's run and merge it, for example
by passing `coverage.allowExternal: true` with an absolute include of
`packages/*/src/**/*.{ts,tsx}` and merging the `coverage-final.json` files, or with a root-level
Vitest workspace coverage run.

## Scope

Tooling, all packages.

## Acceptance criteria

- `pnpm run test:coverage` (or a documented equivalent) reports merged numbers per package.
- `owner-id-migration.ts` is either removed with its barrel export, or wired to a caller and
  tested.
- `docs/development/` says which coverage number to read.
