# 4. Start With the Contract, Not the Implementation

Good code begins before the first function.

## 4.1 State observable behavior

Describe the operation in terms a caller can verify.

Weak requirement:

Add order processing.

Better:

When an authenticated customer submits an order with valid inventory, reserve stock, create exactly one order, charge the authorized amount, and return the created order. A repeated request with the same idempotency key must not create a second charge.

The second version exposes invariants and failure semantics before code exists.

## 4.2 Write down invariants

An invariant is a fact that the system must preserve.

Examples:

- account balance cannot become negative unless overdraft is explicitly allowed;

- an invoice total equals the sum of authoritative line values plus taxes and discounts;

- a user cannot access another tenant's private resource without authorization;

- a job can be completed at most once;

- inventory cannot fall below zero;

- a refresh token must belong to the user/session that presents it;

- an encrypted object must be authenticated before plaintext is trusted.

Put enforcement where the invariant can actually be guaranteed. A UI validation check does not enforce a server invariant. A check performed before a non-atomic write may not enforce a concurrency-sensitive invariant.

## 4.3 Distinguish domain outcomes from infrastructure failures

Expected domain outcomes are part of normal behavior:

```
type ReserveStockResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "OUT_OF_STOCK" | "PRODUCT_NOT_FOUND" };
```


Infrastructure failures are different:

- database unavailable;

- network timeout;

- corrupted response;

- disk full;

- malformed dependency payload.

Do not hide one category inside the other. Callers need to know which outcomes they should branch on and which failures should propagate to an error boundary.

## 4.4 Make assumptions explicit

If a task depends on an assumption, encode it in one of four places:

- a type;

- a validation rule;

- a test;

- a concise comment explaining an external constraint that code cannot express.

Do not leave critical assumptions only in an AI's reasoning or a developer's memory.
