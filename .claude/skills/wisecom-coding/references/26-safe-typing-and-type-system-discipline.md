# 26. Safe Typing and Type-System Discipline

Types are not decoration. They are one of the cheapest places to encode assumptions, restrict invalid operations, and move defects from runtime into development time.

Different languages provide different guarantees. Some enforce a strong static type system at compile time. Some combine static and runtime checks. Some provide optional or gradual typing. Some expose escape hatches such as unchecked casts, dynamic values, reflection, raw pointers, or unsafe operations. The exact syntax changes, but the engineering goal does not:

Make illegal or nonsensical states difficult to construct, make valid operations obvious, and force uncertainty to be resolved at a clear boundary.

An AI coding agent MUST use the strongest useful guarantees available in the repository without fighting the language or replacing clear code with type-system puzzles.

## 26.1 Treat types as executable design constraints

A useful type answers a real question about the program:

- Can this value be absent?
- Which values are legal?
- Which operations are valid?
- Is this identifier interchangeable with another identifier?
- Has this input been validated?
- Is this state mutable?
- Can this value cross a thread/task/process boundary safely?
- Can this operation fail, and what failures are expected?

Avoid types that merely rename a primitive without adding any semantic protection, unless the name itself materially improves the public contract.

Prefer types that remove ambiguity.

Weak model:

```
function transfer(from: String, to: String, amount: Decimal)
```

Stronger model:

```
function transfer(
    from: AccountId,
    to: AccountId,
    amount: PositiveMoney
) -> TransferResult
```

The stronger signature narrows the set of values the implementation must defend against. It does not eliminate runtime validation at external boundaries; it moves already-validated assumptions into a form that internal code can trust.

## 26.2 Convert untrusted data into trusted types at boundaries

Network payloads, JSON, database rows, queue messages, environment variables, command-line arguments, and files are not trustworthy merely because the host language assigned them a convenient shape.

Use the sequence:

```
raw external value
    -> parse
    -> validate syntax
    -> validate semantics
    -> construct trusted domain type
    -> use trusted type internally
```

Do not repeatedly re-check the same primitive throughout the core logic if a boundary can establish the invariant once.

Example:

```
rawEmail: String

parseEmail(rawEmail) -> Result<EmailAddress, ValidationError>

sendReceipt(to: EmailAddress, receipt: Receipt)
```

After EmailAddress has been constructed successfully, code inside the trusted domain should not need to ask whether it contains an @, is too long, or violates the application's accepted format.

This is sometimes described as "parse, then trust the parsed representation." The exact implementation may be a constructor, factory, schema validator, decoder, parser, smart constructor, refinement, value object, or generated contract type.

## 26.3 Static typing does not replace runtime validation

A compile-time type checker can only reason about the information available to it. External data can violate the declared schema. A database can contain legacy rows. A remote service can deploy a breaking change. Deserialization can produce unexpected values. In gradually typed languages, annotations may not be enforced at runtime at all.

Therefore:

- MUST validate untrusted external data at runtime.
- SHOULD convert validated values into trusted internal types immediately.
- MUST NOT treat a type assertion/cast as runtime validation unless the language/runtime actually checks it.
- SHOULD keep decoding errors distinct from valid domain failures.

The rule is:

Runtime validation establishes truth at a boundary; static typing preserves that truth through the program.

## 26.4 Make absence explicit

If a value can legitimately be absent, the type SHOULD say so.

Depending on the language this may be represented as:

- Optional<User>
- User?
- Option<User>
- Maybe<User>
- User | null

Avoid using magic sentinels such as:

```
""
0
-1
"N/A"
null hidden inside an allegedly non-null type
```

unless the external protocol itself requires them and the adapter translates them immediately.

Distinguish different meanings of absence when the domain cares:

- NotProvided
- Unknown
- NotApplicable
- Deleted
- NotYetLoaded

These are not always equivalent. If the distinction changes behavior, represent it explicitly rather than overloading one null-like value.

If a language offers null-safety analysis, enable its strict mode for production code where practical. If the language has no compile-time null safety, establish repository conventions and static-analysis rules that approximate it.

## 26.5 Prefer exhaustive finite-state models

When a concept has a finite set of legitimate variants, model it as a closed set rather than an open string.

Weak:

```
status: String
```

Better:

```
OrderStatus =
    Pending
  | Paid
  | Shipped
  | Cancelled
```

Stronger when variants carry different data:

```
PaymentState =
    Pending { startedAt }
  | Authorized { authorizationId, amount }
  | Captured { captureId, amount }
  | Failed { reason }
```

Languages expose this idea as enums, tagged/discriminated unions, algebraic data types, sealed hierarchies, variants, or sum types.

When the language supports exhaustiveness checking, prefer a form that makes the compiler complain when a new variant is added but existing logic has not been updated.

Do not add a catch-all/default branch merely to silence an exhaustiveness error when every known case should be handled explicitly. A catch-all is appropriate only when unknown future variants are intentionally supported, such as version-tolerant protocol decoding.

## 26.6 Model state transitions, not just state labels

A type can prevent invalid transitions as well as invalid values.

Weak API:

```
order.status = "shipped"
```

Better API:

```
ship(order: PaidOrder, shipment: Shipment) -> ShippedOrder
```

or:

```
order.ship(shipment) -> Result<ShippedOrder, CannotShip>
```

The implementation style depends on the language and domain complexity. Do not create a separate type for every trivial boolean. Use transition-specific types when they materially prevent expensive mistakes, especially in security, payments, workflow engines, infrastructure provisioning, destructive operations, and multi-stage protocols.

## 26.7 Distinguish semantically different primitives

Primitive representation does not imply semantic interchangeability.

These may all be represented as strings but SHOULD NOT automatically be interchangeable:

- UserId
- OrderId
- TenantId
- EmailAddress
- CurrencyCode
- FilePath
- AccessToken

Likewise, these may all be numeric:

- Meters
- Milliseconds
- Bytes
- Percent
- Money
- SequenceNumber

Use nominal types, newtypes, wrappers, opaque types, branded types, value objects, constrained types, or distinct classes/structs when confusing values would cause a meaningful defect.

A function accepting Duration is safer than one accepting an unexplained integer. A function accepting UserId is safer than one accepting any string.

Do not over-wrap harmless local values. Apply semantic typing where it protects boundaries, units, identifiers, authority, money, time, or important invariants.

## 26.8 Prefer narrowing and proof over assertion

An unchecked assertion tells the checker to trust the programmer. A narrowing operation gives the checker evidence.

Prefer:

```
if value is Customer:
    processCustomer(value)
```

or:

```
customer = parseCustomer(value)?
processCustomer(customer)
```

rather than the conceptual equivalent of:

```
processCustomer(value as Customer)   // trust me
```

The syntax differs by language, but the decision is universal:

- SHOULD prove a value has the required type through control flow, parsing, pattern matching, checked conversion, or a validated constructor.
- SHOULD NOT use unchecked casts to bridge a modeling gap that can be expressed safely.
- MUST isolate truly unavoidable unsafe casts at a narrow boundary and document the invariant that makes them safe.

## 26.9 Treat universal/dynamic types as contaminated until narrowed

Many languages have a top-like escape hatch: any, dynamic objects, untyped maps, generic object values, raw pointers, reflection values, foreign-function pointers, or equivalent mechanisms.

These are sometimes necessary at boundaries. They should not spread through the domain.

Use this pattern:

```
untyped/dynamic boundary
    -> inspect/validate/narrow
    -> typed representation
    -> normal application code
```

Avoid APIs that accept or return universal types when the actual set of supported values is known.

Bad:

```
setOption(key: String, value: Any)
```

Better:

```
setRetryLimit(value: RetryLimit)
setTimeout(value: Duration)
setCachePolicy(value: CachePolicy)
```

The second design exposes domain operations and lets tools verify them.

## 26.10 Use generics to preserve relationships

Generic types are most useful when they express a relationship that should remain true.

Examples:

- List<T> -> T
- Repository<Entity, Id>
- Result<Success, Error>
- Page<Item>
- Serializer<T> -> Serialized<T>

A generic parameter SHOULD constrain or connect values. Avoid generic abstraction that merely makes code look reusable.

Weak generic design:

```
Processor<TInput, TOutput, TContext, TOptions, TMetadata, TState>
```

when every caller uses one concrete combination.

Prefer concrete domain types until multiple real use cases demonstrate a stable abstraction.

Be aware that languages differ in variance, type erasure, runtime reification, generic constraints, and inference. Do not assume a runtime can inspect a generic argument merely because the source code contains it.

## 26.11 Use type inference locally; be explicit at contracts

Inference reduces noise when the type is obvious from a local expression.

```
count = items.length
```

Public boundaries benefit from explicit contracts:

```
calculateTotal(order: Order) -> Money
```

As a general rule:

- local implementation details MAY rely heavily on inference;
- exported/public function parameters and results SHOULD clearly expose their contract;
- persisted schemas, serialized messages, external APIs, and plugin interfaces MUST have an explicit versioned contract;
- complex inferred types SHOULD be named if readers cannot reasonably understand them at the call site.

Do not make public APIs depend on accidental inferred shapes that are difficult to evolve compatibly.

## 26.12 Failure is part of the type contract

Expected outcomes SHOULD be visible to callers.

Conceptually:

```
createUser(input) -> Result<User, UserAlreadyExists | InvalidUser>
```

or a language-native equivalent.

Unexpected infrastructure failures may still use exceptions, error values, panic boundaries, or runtime faults depending on language conventions. The important distinction is semantic:

- expected business alternatives are part of normal control flow;
- exceptional infrastructure/programming failures should not masquerade as successful domain outcomes;
- callers should not parse error strings to discover machine-readable state.

This aligns with Chapter 10: choose the failure representation that makes callers handle the cases they genuinely own.

## 26.13 Separate mutable and immutable views where useful

Mutation is easier to reason about when authority to mutate is explicit.

Prefer immutable values for:

- identifiers;
- configuration snapshots;
- messages/events;
- validated value objects;
- money/units;
- data shared across tasks where mutation would require coordination.

Use mutation where it models the problem clearly, but keep ownership narrow.

Some type systems can express borrowed references, read-only views, immutable collections, ownership, move semantics, Sendable/thread-safe values, or other concurrency constraints. Use those mechanisms when available instead of re-implementing their guarantees with comments.

An escape hatch that disables memory/thread safety MUST remain isolated and receive extra review.

## 26.14 Keep serialization types separate from domain types when contracts differ

External representation and internal meaning evolve for different reasons.

For non-trivial systems, consider separating:

- ApiCreateOrderRequest
- CreateOrderCommand
- Order
- OrderCreatedEventV2
- OrderRow

They may contain similar fields, but they have different contracts:

- API DTO: untrusted external compatibility contract;
- command: validated application intent;
- domain object: invariants and behavior;
- event: durable integration contract;
- persistence row: storage representation.

Do not duplicate types mechanically. Split them when sharing one structure would couple independent evolution or let an untrusted/partial representation bypass domain validation.

## 26.15 Generated schema types are not automatically trusted domain values

OpenAPI, Protocol Buffers, GraphQL, JSON Schema, database clients, RPC frameworks, and code generators can provide excellent structural typing. They do not necessarily establish business validity.

Generated type:

```
amount: Decimal
currency: String
```

Domain type:

```
Money { positiveAmount, supportedCurrency }
```

Generated contracts SHOULD be used to prevent structural drift across boundaries, but domain constructors still own semantic rules.

## 26.16 Use strict compiler/checker modes intentionally

When a language or type checker provides stricter modes, a production repository SHOULD generally enable the strongest mode that the codebase can sustain without a flood of meaningless suppression.

Typical categories include:

- nullability checking;
- implicit conversion/coercion warnings;
- unchecked cast warnings;
- exhaustiveness checking;
- unreachable/dead-code diagnostics;
- definite initialization;
- unsafe operation warnings;
- variance/generic constraint checks;
- unused-result warnings;
- strict optional/property handling.

Treat new type errors as design feedback first, tool annoyance second.

Do not globally weaken strictness because one integration is poorly typed. Isolate the weak boundary and normalize it there.

## 26.17 Gradually typed and dynamic languages still need type discipline

A language does not need mandatory static types to benefit from this chapter.

In dynamic or gradually typed code:

- annotate public/module boundaries;
- use the project's static checker in strict mode where practical;
- validate external input at runtime;
- use constrained domain constructors/value objects;
- avoid dictionaries/maps with undocumented arbitrary shapes for core domain data;
- use enums/tagged objects for finite states;
- keep dynamic reflection/metaprogramming behind narrow APIs;
- test runtime assumptions the checker cannot verify.

If annotations are not runtime-enforced, never confuse "the checker accepts this" with "external data is valid."

## 26.18 Avoid type-system cleverness that damages readability

A technically powerful type can still be a bad design if only its author can understand it.

Do not encode an entire business process into nested generics, conditional types, type-level arithmetic, macro machinery, or template metaprogramming merely because the language allows it.

Use advanced typing when it creates one of these concrete benefits:

- prevents an important invalid state;
- eliminates unsafe casts;
- makes an API self-documenting;
- makes exhaustive handling possible;
- lets a reusable library preserve useful relationships;
- removes a meaningful class of runtime failures.

Otherwise prefer simpler runtime code plus explicit validation and tests.

## 26.19 Migrate toward safety incrementally

Large codebases often contain legacy untyped/weakly typed regions. Do not require a flag-day rewrite.

A practical migration path is:

- turn on diagnostics in warning/report mode;
- type new and changed code first;
- establish typed boundaries around legacy modules;
- replace universal/dynamic types with unknown/opaque input where the language supports that distinction;
- eliminate unchecked casts in high-risk flows;
- introduce null-safety and exhaustiveness module by module;
- tighten CI so new violations cannot increase;
- gradually convert remaining warnings to errors.

The objective is monotonically increasing assurance without freezing feature delivery.

## 26.20 Safe-typing checklist

Before considering a typed change complete, ask:

- Can invalid external input enter the domain without runtime validation?
- Is null/absence represented explicitly?
- Are finite states represented as a finite type rather than arbitrary strings?
- Could two identifiers, units, or authority-bearing values be accidentally swapped?
- Did I use a cast/assertion where I could prove or parse the value instead?
- Did an untyped/dynamic value leak beyond the boundary that created it?
- Does a generic parameter express a useful relationship?
- Are public contracts explicit and stable?
- Are expected failures machine-readable and visible to callers?
- Is mutation ownership clear?
- Does generated schema typing still require semantic validation?
- Did I weaken compiler/type-checker settings rather than fix the model?
- If unsafe behavior is unavoidable, is it narrow, justified, and tested?
