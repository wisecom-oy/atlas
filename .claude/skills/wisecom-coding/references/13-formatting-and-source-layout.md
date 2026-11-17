# 13. Formatting and Source Layout

Formatting is not decoration. It reduces the amount of structure the reader has to reconstruct.

## 13.1 Make files read top-down

Place high-level entry points before the lower-level helpers they delegate to when language/framework conventions permit it.

Example reading flow:

- processUserReport

- fetchUserData

- buildReport

- formatScore

- saveReport

A reader should encounter the story before the implementation details.

## 13.2 Keep related code close

Place:

- a helper near its callers;

- a variable near first meaningful use;

- a constant near the policy it controls unless broadly shared;

- tests near the behavior they describe according to repository convention.

Distance is a cognitive cost.

## 13.3 Use whitespace to expose groups

Blank lines should separate conceptual blocks:

- imports;

- fields;

- constructor;

- public operations;

- private helpers;

- distinct phases inside a function.

Avoid both dense walls of code and arbitrary blank-line noise.

## 13.4 Minimize variable scope

Do not declare every local at the top of a function.

Bad:

```
let skippedLog: Logger;
let result: Result;
let index: number;
// 40 lines before all are used
```

Prefer declaration near use. Narrow scope reduces the number of live concepts and prevents accidental reuse.

Class-level dependencies and true instance state belong at class scope because their lifetime is the object lifetime.

## 13.5 Automate style

Use the repository formatter and linter. Do not spend code-review attention debating quote marks, indentation, semicolons, or line wrapping that a tool can decide consistently.

Consistency is more valuable than personal formatting preference.

## 13.6 Avoid unrelated formatting churn

A functional change should not reformat hundreds of unrelated lines unless the task is explicitly a formatting migration. Large noisy diffs hide real changes and create merge conflicts.
