# 31. Compact Agent Instruction Block

The following is a condensed version suitable for embedding directly into an AI coding-agent rule file.

Write code for correctness first, then security/data integrity, clarity, testability,
simplicity, maintainability, operability, performance, and consistency.

Existing repository invariants, architecture, tests, public contracts, and documented
conventions outrank generic stylistic guidance unless the task explicitly changes them.
Surface conflicting evidence or unsafe behavior; do not silently redesign contracts.

Scale depth by impact, not diff size: trivial/local changes need local contract
inspection and targeted checks; moderate behavioral changes need relevant chapters,
tests, and applicable completion criteria; business-critical, stateful, or
security-sensitive changes need a full failure-mode review of affected behavior
and the complete definition of done. Escalate on uncertain invariants. Do not
analyze unrelated systems or waive security, integrity, or repository-required checks.

### Before editing:

- Read the requirement, nearby code, types, tests, config, and repository conventions.
- Identify the owning module, invariants, trust boundaries, side effects, failure modes,
  transaction/concurrency risks, and third-party dependencies.
- Make the smallest coherent change; do not redesign unrelated code.
- If the change sends email or serves public web pages, routes, redirects, robots,
  sitemaps, metadata, or crawler rules, apply the email-deliverability or
  SEO/AI-discovery chapter even when the user did not mention it.

### While coding:

- Use intention-revealing, pronounceable, searchable names.
- Do not use misleading type words, type prefixes, vague near-synonyms, or unnecessary
  abbreviations.
- Match name abstraction to context: domain names at high levels, mechanism names at
  low levels. Wider scope requires more descriptive names.
- Keep functions at one conceptual level and small enough to reason about locally.
- Prefer few, meaningful parameters; group related parameters when that makes call
  sites clearer. Do not apply an arbitrary parameter-count rule.
- Avoid boolean mode flags and hidden side effects. Make mutations explicit.
- Prefer queries that observe and commands that mutate unless an atomic combined
  contract is clearer.
- Keep high-level orchestration separate from low-level mechanics.
- Centralize true duplicated policy but do not abstract coincidentally similar code.
- Use data structures/DTOs when data is the purpose; use behavior-rich objects when
  invariants/behavior belong with the data. Choose OO vs data-oriented design based
  on the likely axis of change.
- Avoid deep object navigation and generic god classes/modules.
- Represent important states, units, and domain outcomes explicitly in types.
- Treat errors as part of the API. Use explicit results for expected business outcomes
  and appropriate exceptions/errors for exceptional/infrastructure failures.
- Define cleanup/resource lifetime with the happy path. Never swallow failures.
- Wrap volatile third-party APIs behind application-owned boundaries when that reduces
  coupling, translates errors, or improves testability.
- Validate all untrusted input at the trusted boundary, including semantic constraints.
- Enforce authorization independently of authentication.
- Parameterize SQL and other interpreters; never concatenate untrusted input into code.
- Never hard-code or log secrets. Never invent cryptography.
- Assume concurrency: protect read-modify-write invariants atomically.
- Make duplicate delivery/retries safe where needed. Retry only transient errors with
  bounded attempts/deadline, exponential backoff, jitter, and idempotency.
- Give remote work explicit timeout/cancellation behavior.
- Bound hostile/untrusted resource usage.
- Measure before complex optimization; avoid N+1 I/O and unbounded buffering.
- Add useful structured logs/metrics/traces at production-relevant boundaries without
  leaking secrets.
- Treat types as design constraints: make absence, finite states, identifiers, units, and
  expected failures explicit. Parse/validate external data before constructing trusted
  domain types. Prefer narrowing/proof over unchecked casts; contain dynamic/untyped values
  at boundaries. Static types never replace runtime validation of external data.
- Use the strictest useful compiler/type-checker mode. Do not silence type errors with broad
  escape hatches when the model can express the invariant safely.
- Scale the actual constrained dimension. Prefer a modular monolith and interchangeable
  instances until independent deployment/scaling/isolation justifies distribution. Identify
  bottlenecks before adding capacity; define backpressure, idempotency, data ownership,
  contract evolution, graceful shutdown, and observability before adding async/services.

### Comments:

- Prefer expressive code.
- Keep comments that explain why, warnings, external constraints, legal requirements,
  public API contracts, or actionable TODOs.
- Delete redundant, stale, misleading, decorative, historical, and commented-out code.

### Tests:

- Test observable behavior rather than private implementation details.
- Use Red/Green/Refactor where useful.
- Keep tests fast, independent, repeatable, self-validating, and close to the behavior.
- Keep one concept per test; multiple assertions are fine when they prove that concept.
- Hide incidental setup with helpers/builders while keeping important values visible.
- Add regression tests for fixed bugs when practical.
- Use unit, integration, contract, and end-to-end tests at the appropriate boundaries.

### Before completion:

- Run available formatter, linter, typecheck, tests, build, and configured security
  checks relevant to the change, plus all repository-required checks.
- Treat the skill as reasoning policy, repository rules as project-specific constraints,
  and CI/tooling as enforcement. Reuse documented commands and required merge gates;
  never bypass them or weaken checks to pass. Report missing enforcement or unobserved
  CI results. Add enforcement only when the task calls for it.
- Inspect the final diff for accidental edits, debug output, stale comments, disabled
  tests, secrets, unsafe error handling, excessive API surface, and unrelated changes.
- Never claim a check passed unless it was actually run and observed.
