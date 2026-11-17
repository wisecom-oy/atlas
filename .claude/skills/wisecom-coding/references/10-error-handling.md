# 10. Error Handling

Errors are part of the API contract, not an afterthought.

## 10.1 Do not use vague return codes

Strings such as:

- "sent"

- "blocked"

- "closed"

- "expired"

invite ad hoc branching and typo-prone contracts.

Use:

- typed results for expected outcomes;

- structured domain errors;

- exceptions for exceptional failures where idiomatic;

- discriminated unions/enums instead of arbitrary strings.

## 10.2 Exceptions vs Result types

Use the mechanism that best communicates the domain.

A useful default:

- Expected business outcome: explicit return type. Example: insufficient funds, username taken, item out of stock.

- Programming error/invariant violation: fail loudly.

- Infrastructure failure: propagate through an error boundary, usually with typed/wrapped errors.

- Cancellation/timeouts: preserve as distinct operational outcomes where callers need different policy.

Do not return null or false for several unrelated reasons.

## 10.3 Establish failure and cleanup boundaries early

When code acquires a resource, design its release path at the same time.

Examples:

- lock -> finally release;

- file -> context manager/using/RAII;

- transaction -> commit or rollback;

- stream -> close/cancel;

- temporary resource -> deterministic cleanup.

Define the failure boundary and resource lifetime before filling in the happy-path details.

## 10.4 Preserve the original cause

When wrapping an error, keep cause/context when the language supports it:

```
throw new StorageFailure("Failed to read invoice attachment", { cause: error });
```

Do not erase the information needed for diagnosis.

## 10.5 Add useful context once

An error should gain information as it crosses a boundary, not receive the same message at every stack level.

Useful context includes:

- operation;

- safe resource identifier;

- dependency name;

- request/correlation ID;

- state relevant to diagnosis but not secrets.

Avoid logging and rethrowing the same error at every layer; this creates duplicate noise.

## 10.6 Do not catch errors you cannot handle

A catch block that only hides failure is dangerous:

```
try {
  await writeCriticalData();
} catch {
  // ignore
}
```

Catch when you can:

- recover;

- translate into an owned error type;

- add meaningful context;

- perform cleanup;

- enforce a boundary response.

Otherwise let the failure propagate.

## 10.7 Use special-case objects for normal fallback behavior

If "no regional tax rule" means "use standard tax," it is not necessarily an exception.

Instead of throwing and catching for control flow, the lookup can return a StandardTaxRule implementation.

This removes repeated null/error branching.

Do not use a Null Object/Special Case when absence itself is semantically important or should stop processing.

## 10.8 Never silently convert partial success into success

If step 3 of 4 fails after irreversible external effects, the caller needs a truthful state.

Use one or more of:

- transaction;

- compensation;

- durable workflow state;

- outbox/inbox pattern;

- idempotent retry;

- explicit partial/pending status.

A function returning success after losing a critical side effect is a correctness bug.
