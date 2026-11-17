# 7. Control Flow

## 7.1 Prefer straightforward happy paths

Use guard clauses for invalid or terminal conditions when they reduce nesting.

```
function calculatePrice(order: Order): Money {
  if (order.items.length === 0) return Money.zero();
  if (order.isCancelled) throw new InvalidOrderState("cancelled");

  const subtotal = sumItems(order.items);
  return applyPricingRules(order, subtotal);
}
```

Avoid converting every branch into early returns if it fragments a small, naturally structured decision.

## 7.2 Keep nesting shallow

Deep nesting increases the number of conditions a reader must hold simultaneously.

When nesting becomes difficult, consider:

- guard clauses;

- extracted predicates;

- extracted operations;

- state machines;

- lookup tables;

- polymorphism/strategies;

- explicit result types.

## 7.3 Prefer positive domain predicates

This is often easier:

```
if (user.canEdit(post)) { ... }
```

than stacked negation:

```
if (!user.isBlocked && !post.isLocked && !user.isReadOnly) { ... }
```

The domain predicate centralizes the rule and gives it a stable name.

## 7.4 Make exhaustive decisions exhaustive

For closed unions/enums, use compiler-assisted exhaustiveness where possible. A new state should create a compile-time failure rather than silently fall through.

```
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
```

This is especially useful for state machines and business statuses.
