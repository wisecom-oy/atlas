# 3. AI Coding Agent Operating Procedure

An AI coding agent MUST treat coding as a verification loop rather than text generation.

Scale this procedure to the affected behavior, not the number of changed lines:

- Trivial/local changes: inspect the local contract and affected callers; run targeted checks. No exhaustive chapter loading or full failure-mode checklist.
- Moderate behavioral changes: load relevant chapters, inspect and update behavioral tests where needed, and check applicable completion criteria.
- Business-critical, stateful, or security-sensitive changes: perform a full failure-mode review of affected behavior and review the complete definition of done.

Escalate when inspection reveals broader impact or uncertain invariants. Always preserve security, data integrity, and repository-required checks; do not analyze unrelated systems merely to fill a checklist.

## 3.1 Before editing

- Read the task literally. Identify the requested behavior, constraints, compatibility requirements, and acceptance criteria.

- Inspect relevant repository context. Read nearby code, types, tests, configuration, package manifests, and established patterns before inventing a design.
- Existing repository invariants, architecture, tests, public contracts, and documented conventions outrank generic stylistic guidance unless the task explicitly changes them.


- Locate the ownership boundary. Determine which module should own the behavior. Do not place logic in a convenient file merely because it is easy to edit.

- Identify invariants. Ask what must remain true before and after the operation.

- Identify trust boundaries. Mark data arriving from users, networks, databases, files, queues, third-party services, environment variables, and other processes.

- Identify side effects. List database writes, file operations, network calls, queue messages, caches, logs, external payments, emails, and state mutations.

- Identify failure modes. Consider validation failure, missing data, authorization failure, timeout, dependency failure, partial completion, concurrency, duplicate delivery, cancellation, and resource exhaustion.

- Identify type guarantees. Determine which inputs are untrusted, which values may be absent, which states are finite, and where unchecked casts/dynamic values could bypass invariants.

- Identify scale assumptions. For performance- or architecture-sensitive work, determine expected load, bottlenecks, state ownership, idempotency, backpressure, and whether the current deployment unit can simply scale horizontally.

- Find existing tests. Prefer extending the existing test language and helpers over introducing a separate testing style.

- Plan the smallest coherent change. A correct local change is preferable to a broad cleanup unrelated to the task.

## 3.2 During implementation

- Add or update a test that captures the important behavior when practical.

- Implement the simplest correct path.

- Make names express domain intent.

- Keep state changes explicit.

- Keep high-level orchestration at one abstraction level.

- Isolate third-party APIs and infrastructure mechanics behind owned boundaries.

- Validate untrusted input at the trusted boundary.

- Preserve cleanup and transactional guarantees on failure.

- Add observability where a production failure would otherwise be opaque.

- Refactor only after the behavior is protected enough to change safely.

## 3.3 Before declaring completion

The agent MUST run the checks that are available and relevant:

- formatter;

- linter;

- type checker;

- unit tests;

- relevant integration tests;

- build;

- targeted security/static-analysis checks when configured.

Use the repository's documented commands and existing CI/tooling. Required merge checks enforce mechanically checkable constraints; skill instructions alone do not. Do not disable checks or bypass gates. Report missing enforcement and unobserved CI results without introducing a new pipeline unless the task calls for it.

Then review the actual diff. Check for accidental edits, dead code, debug output, stale comments, disabled tests, copied secrets, unhandled errors, widened API surface, and unnecessary dependencies.

Never claim that code compiles, tests pass, or a command succeeded unless that result was actually observed.
