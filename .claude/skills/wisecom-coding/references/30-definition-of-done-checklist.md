# 30. Definition of Done Checklist

Apply this checklist at the change's risk tier. Trivial/local work needs local contract inspection and targeted checks, not the full checklist. Moderate behavioral changes use applicable sections. Business-critical, stateful, or security-sensitive changes require review of the complete checklist against affected behavior; mark genuinely inapplicable items as such instead of expanding scope. No tier waives security, data integrity, or repository-required checks.

### Behavior

- [ ] The implementation satisfies the stated acceptance criteria.
- [ ] Important domain invariants remain true.
- [ ] Edge cases relevant to the change are handled.
- [ ] Failure does not incorrectly report success.
- [ ] Existing public behavior is preserved unless intentionally changed.

### Names and readability

- [ ] Names reveal intent and do not misrepresent types/behavior.
- [ ] No unnecessary abbreviations or mental mapping.
- [ ] High-level names use domain language.
- [ ] Vague Manager/Handler/Processor names have been challenged.
- [ ] Function and variable scope is appropriately narrow.

### Functions and modules

- [ ] Each function has one coherent abstraction.
- [ ] Hidden side effects have been removed or made explicit.
- [ ] Boolean mode flags are justified or replaced.
- [ ] Parameter lists are readable at call sites.
- [ ] Repeated type switches have been examined.
- [ ] Modules/classes have a clear primary responsibility.
- [ ] Public API surface is no larger than necessary.

### Data and state

- [ ] Important states are represented explicitly.
- [ ] Units/identifiers that could be confused are distinguishable.
- [ ] State transitions enforce their invariants.
- [ ] Shared mutable state is minimized.
- [ ] Read-modify-write paths are safe under concurrency where required.

### Type safety

- [ ] Untrusted external data is runtime-validated before becoming trusted domain data.
- [ ] Null/absence is explicit rather than hidden behind sentinels or unsafe assumptions.
- [ ] Finite states use enums/unions/sealed variants or an equivalent constrained representation where practical.
- [ ] Important IDs, units, money, authority-bearing values, and validated concepts cannot be accidentally interchanged.
- [ ] Universal/dynamic values and unchecked casts are confined to narrow boundaries.
- [ ] Public contracts are explicit; generated schema types do not bypass semantic validation.
- [ ] Expected failures are machine-readable and visible to callers.
- [ ] Strict type/checker diagnostics were not weakened merely to make the change compile.

### Scaling and growth

- [ ] Any new scaling mechanism addresses a stated growth dimension or measured bottleneck.
- [ ] Stateful behavior does not accidentally bind correctness to one process/instance.
- [ ] Async queues/workers have bounded concurrency, backlog, retry, idempotency, and poison-message behavior.
- [ ] Backpressure/load-shedding behavior is defined for overload.
- [ ] Data ownership and consistency boundaries are explicit.
- [ ] New service boundaries buy independent scaling/deployment/isolation rather than merely moving code across a network.
- [ ] Contract/schema changes can be rolled out compatibly.
- [ ] Scale-in/shutdown cannot silently lose accepted work.
- [ ] Autoscaling/capacity assumptions account for downstream limits and measurable saturation.
- [ ] Added distribution has corresponding telemetry, security controls, and operational ownership.

### Errors and resilience

- [ ] Expected business outcomes are distinguishable from infrastructure failures.
- [ ] Resources are released on every failure path.
- [ ] Caught errors are actually handled/translated/contextualized.
- [ ] Original error causes are preserved where useful.
- [ ] Remote calls have appropriate timeout/deadline behavior.
- [ ] Retries are bounded, back off, and are safe/idempotent.
- [ ] Duplicate messages/requests cannot create dangerous duplicate effects.

### Boundaries

- [ ] Third-party SDK details do not unnecessarily leak into business logic.
- [ ] Vendor errors are translated at the boundary where useful.
- [ ] Tests can replace external dependencies with fakes/stubs at the owned boundary.

### Comments and formatting

- [ ] Comments explain intent/constraints, not obvious syntax.
- [ ] No stale or misleading comments.
- [ ] TODOs are actionable.
- [ ] No commented-out historical code.
- [ ] Formatter/linter output is clean.
- [ ] Unrelated formatting churn is absent.

### Tests

- [ ] New/changed important behavior is tested.
- [ ] Regression fixes have regression coverage where practical.
- [ ] Tests are deterministic and independent.
- [ ] Tests describe one concept each.
- [ ] Incidental setup is hidden without hiding relevant values.
- [ ] Important failure/boundary cases are covered.

### Security

- [ ] Untrusted inputs are syntactically and semantically validated.
- [ ] Sensitive operations enforce authorization server-side/trusted-side.
- [ ] SQL/other interpreter inputs use safe parameterization/context encoding.
- [ ] No new hard-coded secrets.
- [ ] Secrets/tokens/passwords are not logged.
- [ ] Resource sizes/depth/runtime are bounded where hostile input is possible.
- [ ] Cryptographic code uses established primitives/libraries.

### Operability and performance

- [ ] Important production failures are observable.
- [ ] Logs are structured enough to diagnose the operation.
- [ ] Relevant correlation IDs are propagated.
- [ ] No obvious N+1 or unbounded memory/I/O behavior was introduced.
- [ ] Performance complexity is acceptable for expected input scale.
- [ ] Any non-obvious optimization is justified by requirement or measurement.

### Verification

- [ ] Formatter was run or formatting was verified.
- [ ] Linter passed where available.
- [ ] Type checker passed where available.
- [ ] Relevant tests passed.
- [ ] Build passed where relevant.
- [ ] The final diff was reviewed manually.
- [ ] No debug output, disabled tests, temp files, or accidental dependencies remain.
- [ ] Any check that could not be run is stated explicitly rather than assumed.
