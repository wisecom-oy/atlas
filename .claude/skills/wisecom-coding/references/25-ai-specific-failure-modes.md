# 25. AI-Specific Failure Modes

Coding agents can produce plausible code faster than they can verify it. Counter this explicitly.

## 25.1 Never hallucinate an API

Before using an unfamiliar function, package, CLI flag, configuration key, or SDK method:

- search the installed code/types/docs;
- inspect the dependency version;
- confirm the signature;
- copy established repository usage when available.

Do not invent a method because its name seems likely.

## 25.2 Do not infer unseen code

If correctness depends on a type, schema, migration, caller, or helper, inspect it. Do not assume its behavior from the filename alone.

## 25.3 Preserve repository conventions

Before adding a new pattern, find examples of:

- error types;
- logging;
- dependency injection;
- validation;
- tests;
- database access;
- configuration;
- API responses.

Use the established style unless it is the source of the bug or clearly inadequate.

## 25.4 Avoid speculative architecture

Do not create factories, repositories, interfaces, event buses, strategy registries, or plugin systems for hypothetical future requirements.

Add an abstraction when it solves a current volatility, testing, ownership, or duplication problem.

## 25.5 Do not "improve" public behavior silently

An AI may notice what looks inconsistent and normalize it. That can be a breaking change.

Treat existing external behavior as a contract until requirements/tests establish otherwise.

## 25.6 Do not weaken tests to make code pass

When a test fails after an implementation change:

- determine whether the implementation or expectation is wrong;
- inspect the requirement/history/context;
- update the test only if the intended behavior truly changed.

Never delete, skip, loosen, or blanket-update snapshots simply to get green CI.

## 25.7 Do not suppress type/lint errors without understanding them

Avoid reflexive:

```
as any
// @ts-ignore
eslint-disable
```

First fix the model or boundary. Suppression is acceptable only when the type/tool cannot express a known-safe condition, and the reason should be local and clear.

## 25.8 Keep the diff proportional to the task

A two-line bug should not normally produce a 20-file architecture migration.

If a broader change is required for correctness, explain why and keep it coherent.

## 25.9 Verify destructive operations

Before migrations, file deletion, data rewrites, bulk updates, or forceful Git operations:

- inspect target scope;
- use dry-run/transaction/backup when available;
- make predicates exact;
- verify expected counts;
- preserve rollback path.

## 25.10 Never claim verification you did not perform

Report facts precisely:

Good:

```
pnpm test --filter pricing passed: 42 tests.
```

Good:

```
I could not run the integration suite because the required Postgres service is unavailable; the unit suite and typecheck pass.
```

Bad:

```
This should definitely work.
```
