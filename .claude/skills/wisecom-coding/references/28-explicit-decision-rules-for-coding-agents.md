# 28. Explicit Decision Rules for Coding Agents

These rules turn the principles above into triggers an agent can execute.

### Naming

IF a reader must inspect implementation to distinguish two similarly named functions, THEN rename them around the actual distinction.

IF a variable crosses more than a few obvious lines, THEN prefer a descriptive name over a single letter.

IF a name contains Manager, Handler, Processor, Data, or Info, THEN verify that the word identifies a real domain responsibility; otherwise choose a more specific noun.

IF a high-level function name contains a threshold or mechanism, THEN ask whether a domain outcome name would remain stable when policy changes.

IF an identifier encodes a static type (strName, iCount), THEN remove the encoding unless repository convention genuinely requires it.

### Functions

IF a function mixes policy and low-level mechanics, THEN extract the lower-level operation behind a meaningful name.

IF a function performs unrelated state changes, THEN split responsibilities or make the combined command explicit.

IF a boolean parameter chooses major behavior, THEN prefer separate named operations or an explicit mode/option.

IF a call has many positional arguments, THEN inspect whether they form a coherent value object/options object. Do not refactor solely based on count.

IF a query/predicate also mutates hidden state, THEN separate the effect or rename the function to reveal the command.

IF the same discriminator switch is repeated across several modules, THEN consider polymorphism/strategy or central dispatch.

### Duplication

IF duplicated code represents the same business rule and must change together, THEN centralize it.

IF code only looks similar but represents different policies, THEN tolerate duplication rather than creating a false abstraction.

### Comments

IF a comment only restates the next line, THEN delete it.

IF a comment explains why a surprising constraint exists, THEN keep it concise and maintain it.

IF a TODO has no action or removal condition, THEN make it actionable or delete it.

IF old code is commented out, THEN delete it and rely on version control.

### Data and objects

IF callers navigate deep object chains to accomplish a domain operation, THEN consider moving the operation to the object that owns the knowledge.

IF a type is only a transport DTO, THEN plain data is acceptable; do not manufacture behavior merely to look object-oriented.

IF several fields are conditionally required based on a status, THEN consider a discriminated union/state-specific type.

IF two numeric concepts have different units/identities, THEN encode that distinction in names or types.

### Errors

IF absence/fallback is a normal case, THEN do not use an exception merely for control flow.

IF a caller must branch on a domain outcome, THEN represent it explicitly.

IF catching an error cannot recover, translate, add context, clean up, or terminate at a boundary, THEN do not catch it there.

IF a resource is acquired, THEN design deterministic release on every exit path.

IF an external SDK error leaks into core business modules, THEN translate it at the adapter boundary.

### External dependencies

IF a vendor SDK is imported from several business modules, THEN introduce an owned boundary/adaptor unless direct coupling is intentionally trivial/stable.

IF tests need live third-party credentials to test business logic, THEN the dependency boundary is probably too tight.

### Tests

IF a production bug is reproduced, THEN add a regression test before or with the fix when practical.

IF a test name describes several unrelated behaviors, THEN split it.

IF test setup hides the important values among boilerplate, THEN introduce builders/helpers/DSL.

IF tests share mutable state or depend on order, THEN isolate them.

IF a unit test performs uncontrolled network/time/random operations, THEN inject or control those dependencies.

### Security

IF data crosses from an untrusted source, THEN validate syntax and semantics at the trusted boundary.

IF user input reaches SQL, THEN parameterize it; never build the query by concatenation.

IF a sensitive operation receives an authenticated principal, THEN still perform authorization for the action/resource.

IF a value is a password/token/key/secret, THEN do not log it and do not commit it.

IF cryptographic behavior is required, THEN use a standard reviewed primitive/library; do not invent one.

IF a parser/upload/endpoint accepts potentially large input, THEN define size/depth/time limits.

### Concurrency and reliability

IF code reads state and later writes based on that state, THEN ask what happens if another actor changes it in between.

IF a remote write may be retried after an ambiguous failure, THEN establish idempotency before automatic retry.

IF a failure is retryable, THEN use bounded attempts/deadline plus backoff and jitter.

IF a database uses serializable/deadlock-detecting transactions, THEN handle the documented retryable abort path.

IF a message can be redelivered, THEN make the consumer idempotent or deduplicate.

IF two systems must reflect one logical state transition, THEN plan for partial failure (outbox, compensation, workflow state, etc.).

### Type safety

IF external/untyped data enters trusted code, THEN parse and runtime-validate it before constructing the domain type.

IF a value can legitimately be absent, THEN represent absence explicitly rather than with a magic sentinel.

IF a concept has a finite set of states, THEN prefer an enum/sealed union/tagged variant or equivalent representation that supports exhaustive handling.

IF identifiers or units share the same primitive representation but are not interchangeable, THEN introduce semantic types where confusion would be costly.

IF an unchecked cast/assertion is needed, THEN first attempt narrowing, checked conversion, parsing, or a validated constructor; isolate unavoidable unsafe code.

IF a dynamic/universal value crosses a boundary, THEN narrow it there rather than allowing it to spread through the domain.

IF a type checker accepts external data, THEN remember that this does not replace runtime validation unless the runtime actually enforces the contract.

### Scaling and architecture growth

IF scale is cited as a reason for architectural complexity, THEN identify the exact growth dimension and expected/observed numbers.

IF a codebase is difficult to change, THEN establish module/domain ownership before introducing network services.

IF application instances can be made interchangeable, THEN prefer horizontal replication before decomposing merely for throughput.

IF one workload has a materially different resource profile, THEN isolate and scale that workload independently, often through bounded asynchronous work.

IF producers can outrun consumers, THEN define backpressure, queue limits, quotas, or load shedding before increasing concurrency.

IF a service is proposed, THEN require a clear benefit such as independent deployment, scaling, security/failure isolation, or ownership.

IF a new network boundary is introduced, THEN define data ownership, timeout/retry/idempotency, contract evolution, telemetry, and security behavior.

IF autoscaling is introduced, THEN choose a demand/saturation signal tied to the workload and account for downstream limits and graceful scale-in.

### Performance

IF a loop performs network/database I/O per item, THEN look for batching or set-based operations.

IF an operation buffers unbounded input, THEN add limits or streaming.

IF optimization makes code materially more complex, THEN require measurement or a known performance budget.

IF adding a cache, THEN define invalidation, staleness, key isolation, and failure behavior first.

### Observability

IF a production failure would be difficult to diagnose, THEN add a structured event/metric/trace at the responsible boundary.

IF telemetry includes untrusted text, THEN sanitize/structure it.

IF a log field may contain a secret or sensitive token, THEN remove/redact it.
