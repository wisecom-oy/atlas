# 23. Code Review

Code review exists to improve correctness and long-term code health, not to pursue theoretical perfection.

## 23.1 Review in this order

- Purpose - does the change solve the intended problem?

- Correctness - are normal and edge cases correct?

- Security/data integrity - are trust boundaries, authorization, injection, secrets, transactions, and concurrency handled?

- Design - is responsibility in the correct module and is complexity justified?

- Tests - do tests prove important behavior and failure paths?

- Readability - names, functions, flow, comments, API surface.

- Operability - will production failures be diagnosable?

- Performance - any obvious or measured scalability issues?

- Style - formatter/linter should handle most of this.

## 23.2 Prefer small focused changes

Small diffs are easier to:

- reason about;
- test;
- review;
- revert;
- merge;
- attribute when a regression appears.

Do not mix unrelated cleanup, dependency upgrades, formatting migrations, and feature behavior unless they genuinely need to be atomic.

## 23.3 Improve code health incrementally

A review does not need to turn an old subsystem into ideal architecture before a safe bug fix can merge.

Require the change to leave code no worse and preferably better in the area it touches. Create separate work for large unrelated redesigns.

## 23.4 Review the diff, not only the final files

The diff reveals:

- accidental deletions;
- broad renames;
- copied secrets;
- disabled tests;
- debug logging;
- changed defaults;
- API widening;
- unexpected dependency changes.

## 23.5 Comments should explain risk, not taste

Useful review comment:

```
This check happens before the update but is not atomic; two workers can both observe available stock. Can we make the decrement conditional in the database transaction?
```

Weak review comment:

```
I would have named this differently.
```

When requesting a change, explain the correctness, maintainability, security, or consistency reason.
