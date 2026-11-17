# 1. Priority Order

Existing repository invariants, architecture, tests, public contracts, and documented conventions outrank generic stylistic guidance unless the task explicitly changes them. Do not use a local bug fix as permission to redesign architecture or weaken tests. Surface conflicting evidence or unsafe behavior rather than silently changing the contract.

When principles conflict, use this order of precedence:

- Correctness - implement the required behavior and preserve the system's invariants.

- Security and data integrity - prevent unauthorized behavior, corruption, secret exposure, and unsafe trust assumptions.

- Clarity - make intent, ownership, state changes, and failure behavior obvious.

- Testability - make important behavior easy to verify automatically.

- Simplicity - use the least complicated design that satisfies the real requirements.

- Maintainability - make future changes local and predictable.

- Operability - make production behavior observable and failures diagnosable.

- Performance - meet measured performance requirements without sacrificing correctness unnecessarily.

- Consistency - follow the repository's established conventions unless the task explicitly changes them.

Do not sacrifice correctness to make code shorter. Do not sacrifice security to make an API convenient. Do not introduce architectural machinery merely to satisfy a stylistic rule.
