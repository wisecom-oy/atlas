# 16. Concurrency, Transactions, and Distributed Effects

Many clean-looking functions are wrong under concurrency. Ask whether another request, worker, process, or service can change the same state between read and write.

## 16.1 Identify atomic invariants

This is unsafe when two requests can execute concurrently:

```javascript
const stock = await getStock(productId);
if (stock >= quantity) {
  await setStock(productId, stock - quantity);
}
```

Both requests can observe the same stock and oversell.

Use an atomic database operation, row lock, optimistic version check, serializable transaction, or other concurrency primitive appropriate to the storage system.

## 16.2 Use transactions for one consistency boundary

A transaction is useful when several reads/writes must commit as one state transition.

Keep transactions:

- as short as practical;
- free of unnecessary network calls;
- explicit about isolation requirements;
- retry-aware if the database can abort serialization/deadlock conflicts.

Do not hold a database transaction open while waiting on a slow email or payment API unless the architecture deliberately requires that coupling.

## 16.3 Know that isolation levels differ

Do not assume "inside a transaction" means serial execution. Databases expose isolation levels with different visibility and anomaly guarantees.

If correctness depends on another transaction not modifying a row or predicate between your read and write, select the appropriate mechanism rather than relying on intuition.

Serializable transactions can still abort due to serialization conflicts; the application may need to retry the whole transaction.

## 16.4 Use optimistic concurrency when conflicts are rare

A version column can protect update intent:

```sql
UPDATE documents
SET body = $1, version = version + 1
WHERE id = $2 AND version = $3;
```

If zero rows update, someone else changed the document. Return a conflict or reload/retry according to product semantics.

## 16.5 Assume messages can be delivered more than once

Queues and distributed systems commonly provide at-least-once behavior or can redeliver after ambiguous failures.

Consumers SHOULD be idempotent where duplicate effects are dangerous.

Techniques include:

- event/message IDs stored in an inbox table;
- unique database constraints;
- compare-and-set state transitions;
- idempotency keys;
- deduplication records with a defined retention period.

## 16.6 Design retries with idempotency

An operation is idempotent when repeating the same intended operation produces no additional intended effect after the first successful application.

Safe-looking reads are often naturally idempotent. Writes may require design.

For example, a payment API can accept an idempotency key so a timeout followed by a retry does not create a second charge.

Never blindly retry a non-idempotent operation after an ambiguous failure.

## 16.7 Retry only transient failures

Potentially retryable:

- connection reset;
- temporary dependency unavailability;
- rate limit with retry guidance;
- serialization/deadlock conflict;
- timeout where operation semantics make retry safe.

Usually not retryable without changed input/state:

- invalid request;
- authentication failure;
- authorization failure;
- invariant violation;
- malformed data;
- permanent not-found where absence is final.

## 16.8 Bound retries

A retry loop MUST have a stop condition.

Use:

- max attempts or overall deadline;
- exponential backoff;
- jitter to avoid synchronized retry storms;
- cancellation propagation;
- idempotency when effects may have occurred.

A retry without a timeout/deadline can convert a dependency incident into thread, connection, or queue exhaustion.

## 16.9 Timeouts are part of API design

Every remote operation should have a deliberate timeout/deadline strategy. "Use the library default" is acceptable only when that default is known and appropriate.

Distinguish:

- connect timeout;
- request/read timeout;
- overall workflow deadline;
- background-job maximum runtime.

Propagate remaining deadlines downstream when the stack supports it.

## 16.10 Handle cancellation

Long-running work should stop when the caller/job is cancelled if continuing has no value.

Propagate AbortSignal, cancellation tokens, contexts, or equivalent mechanisms through I/O layers.

Do not catch a cancellation and transform it into a generic success or retry unless policy explicitly requires it.

## 16.11 Use durable patterns for cross-system consistency

A database commit and a message broker publish are not one atomic transaction by default.

For important workflows, consider an outbox pattern:

- commit business change and outbox event in one database transaction;
- publisher sends committed outbox records;
- mark them published or tolerate duplicate sends;
- consumer is idempotent.

Similarly, long multi-service workflows may require explicit saga/compensation semantics rather than pretending to have a global transaction.
