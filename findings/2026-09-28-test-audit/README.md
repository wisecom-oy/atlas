# Test audit, 2026-09-28

Audit of the unit suite at commit `4d6ee39` (v5.2.2): 1,894 tests in 281 files across 10
packages, all passing.

| #         | Finding                                                                                | Priority | Labels               |
| --------- | -------------------------------------------------------------------------------------- | -------- | -------------------- |
| 01 (#443) | [Order-dependent rehydration test](01-order-dependent-rehydration-test.md)             | low      | `test`               |
| 02 (#444) | [Drive Graph adapters thinly tested](02-drive-graph-adapter-coverage.md)               | medium   | `test`               |
| 03 (#445) | [Per-package coverage understates shared code](03-per-package-coverage-understates.md) | low      | `test`, `code smell` |

Also added as evidence to #438: `s3-delta-cursor-repository.test.ts:84`, `:96` and `:105` pin
the swallow-and-return-`undefined` behaviour that issue asks to change.

## Method

**Flakiness.** Every package's suite ran five times with `--sequence.shuffle` (seeds 7919 × n),
50 package runs in all. One test failed, in 2 of 5 runs (01). The timing-based tests were then
run 15 times under that parallel load: `throttle-fence.test.ts` and `trim-slashes.test.ts`
passed every time. The slash-trim ratio, which flaked once in CI before commit `5f01588`, now
measures 10.1 to 12.1 against its 40 bound.

**Coverage.** Collected once per package (what `test:coverage` reports), then again with
coverage gathered across package boundaries and merged, which is the number that reflects what
runs (03). Gaps were read from the merged data.

**Low-value tests.** A TypeScript AST scan of every `it` and `test` for bodies with no
assertion, tautologies, and bodies whose only matchers are weak (`toBeDefined`, `toBeTruthy`,
`not.toThrow`, `toHaveBeenCalled`, `toBeInstanceOf`). Plus test files that import nothing from
`src`, and tests that mock their own subject.

## Checked and dropped

- No `it.skip`, `.only` or `.todo` anywhere.
- No tautological assertions, and no test mocks the module it tests.
- One test body has no `expect` (`sliding-window-limiter.test.ts:43`). Its `await` is the
  assertion: a hang fails on the 15 second timeout.
- 35 tests assert only weak matchers. Read one by one, they are negative cases (`not.toThrow`
  where not throwing is the behaviour) or error-class checks (`toBeInstanceOf(NotFoundError)`),
  which is the right assertion for them.
- Two test files import nothing from `src`. `postinstall-takeover.test.ts` spawns the real
  script, and `cli-sdk-parity.test.ts` checks the CLI and SDK wiring statically. Both are useful.
- Fake timers are restored inline rather than in `afterEach` in three Outlook adapter tests.
  All three restore in `finally`, so a failed assertion cannot leak them.
- CLI command handlers are at 10% to 55%. They are thin presentation over services that are
  covered, and the exit code mapping they rely on (`fatal-error.ts`) is tested.
