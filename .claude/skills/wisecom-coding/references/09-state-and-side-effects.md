# 9. State and Side Effects

## 9.1 Make mutation ownership obvious

State is easier to reason about when few components can mutate it.

Prefer:

- immutable values by default;

- local mutation over shared mutation;

- one authoritative owner for mutable state;

- explicit state transition methods;

- narrow database write paths.

Avoid "action at a distance" where calling a helper unexpectedly changes global/session/cache state.

## 9.2 Separate calculation from effect

Pure computation is easy to test and reuse.

Instead of embedding pricing math inside a database transaction, compute the pricing decision separately when possible:

```
const pricing = calculatePricing(order, rules);
await repository.persistPricing(order.id, pricing);
```

This also makes it clear which step can fail for business reasons and which for infrastructure reasons.

## 9.3 Centralize important transitions

If an order can transition from pending to paid, do not let arbitrary callers set order.status = "paid".

Prefer:

```
order.markPaid(receipt);
```

That operation can enforce:

- only pending orders can be paid;

- receipt is required;

- paid timestamp is assigned;

- domain events are recorded.
