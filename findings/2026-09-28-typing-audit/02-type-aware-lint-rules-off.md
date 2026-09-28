# Lint: type-aware rules are off, and the multi-project parser setup cannot resolve 538 references needed to turn them on

**Triage:** RECORD (high confidence, `code smell`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Problem or motivation

The compiler side is strict: `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are all on, and `src` contains no `@ts-ignore`, no
`eslint-disable`, and no explicit `any`. What the compiler cannot see is `any` arriving from
outside: `JSON.parse`, and the Microsoft Graph client, whose `.get()` returns `any`. ESLint has
the rules that catch those flows, and `eslint.config.js` already passes `parserOptions.project`,
but none of the type-aware rules are enabled. `no-explicit-any` is a warning.

The consequence is not hypothetical. `Manifest.created_at` is typed `Date` and is a string at
runtime because it comes out of `JSON.parse(...) as Manifest` (#441), and nothing in
CI can notice.

Running the type-aware rules once against `packages/*/src`, after `pnpm run build`:

| Rule                                               | Hits | Notes                                                                                                                               |
| -------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `no-floating-promises`, `no-misused-promises`      | 0    | Clean. Worth locking in.                                                                                                            |
| `only-throw-error`, `prefer-promise-reject-errors` | 0    | Clean. Worth locking in.                                                                                                            |
| `no-unsafe-*`                                      | 597  | 538 are "type could not be resolved" (below); the rest are real `any` flows                                                         |
| `no-unnecessary-type-assertion`                    | 11   | For example `ref.storage_key!` after a guard that already narrowed it (`blob-restore.ts:56`, `:87`, `:95`, and the SharePoint twin) |
| `restrict-template-expressions`                    | 8    | `unknown` interpolated into messages                                                                                                |
| `switch-exhaustiveness-check`                      | 1    | `graph-attachment-mapper.ts:42`, covered by a `default`                                                                             |

The real `any` flows are Graph responses read with no type at all, for example
`graph-user-identity-resolver.adapter.ts:17-25`, where `response.id` becomes the
`object_id` that names the OneDrive storage prefix, and `graph-mailbox-discovery.adapter.ts:101`
and `:124`.

538 hits are not real `any`. They are imports the lint program could not resolve: 362 in
`core`, 91 in `sharepoint`, 84 in `onedrive`. `tsc` resolves the same imports through each
package's `paths`, so the build is fine. The lint program, built from
`project: ['./packages/*/tsconfig.json']`, assigns some files to a project where
`@wisecom/atlas-types` does not resolve. Enabling `no-unsafe-*` today would bury the real hits
under these.

## Proposed solution

1. Make the lint program resolve what `tsc` resolves, for example with
   `parserOptions.projectService` or a per-package `tsconfigRootDir`, until
   `no-unsafe-call` reports no "could not be resolved" hits.
2. Enable `no-floating-promises`, `no-misused-promises`, `only-throw-error` and
   `prefer-promise-reject-errors` as errors. All four are clean today, so this only prevents
   regressions.
3. Enable `no-unsafe-*` and `no-unnecessary-type-assertion`, and give Graph responses a declared
   shape at the adapter boundary (the pattern `graph-mailbox-response-mappers.ts` already uses)
   rather than reading fields off `any`.

## Alternatives considered

Leaving it as is. The costs are the ones above: `JSON.parse` and Graph responses are the two
places where the declared type and the runtime value can disagree, and they are exactly where no
check runs.

## Scope

Tooling, all packages.

## Acceptance criteria

- A type-aware lint run reports no "type could not be resolved" diagnostics.
- The four promise and throw rules are errors in `eslint.config.js`, and the run is clean.
- `no-unsafe-*` is enabled, or each remaining hit is either typed or listed in the issue with a
  reason.
- `pnpm run lint` still completes in CI without a prior build, or the workflow builds first.
