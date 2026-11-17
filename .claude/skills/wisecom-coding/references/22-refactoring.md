# 22. Refactoring

Refactoring changes internal structure while preserving intended behavior.

## 22.1 Protect behavior first

Before a risky refactor, ensure important behavior is covered. In legacy code, characterization tests may be the first step.

## 22.2 Refactor in small semantic steps

Examples:

- rename concept;
- extract function;
- move function;
- introduce interface;
- change implementation behind interface;
- remove obsolete path.

Keep the program buildable/testable between steps where practical.

## 22.3 Refactor smells, not aesthetics

High-value targets include:

- duplicated business policy;
- hidden side effects;
- ambiguous names;
- repeated type switches;
- overly broad public API;
- long dependency chains;
- mixed abstraction levels;
- untestable hard-coded external clients;
- invalid states represented by loose primitives;
- transaction/concurrency hazards.

Do not rewrite stable code merely because an alternative style looks more elegant.

## 22.4 Preserve behavior intentionally

When code is messy, distinguish:

- behavior to preserve;
- bug to correct;
- incidental implementation detail free to change.

Do not accidentally "fix" a behavior that external consumers depend on without making the compatibility decision explicit.
