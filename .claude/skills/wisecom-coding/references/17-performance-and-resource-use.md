# 17. Performance and Resource Use

Performance work should be driven by requirements and measurement, not folklore.

## 17.1 First choose the correct algorithm and data structure

A clean implementation of an unnecessarily quadratic algorithm can still fail in production.

Reason about expected input scale:

- lookup-heavy membership -> often a set/map;
- ordered range access -> ordered/indexed structure;
- repeated database lookups -> batch/query join;
- streaming large objects -> avoid full buffering;
- bounded queue -> prevent unbounded memory growth.

## 17.2 Measure before micro-optimizing

Use profiling, traces, query plans, metrics, and benchmarks to find actual bottlenecks.

Do not make code cryptic to save a theoretical allocation that has no measurable impact.

## 17.3 Think in complexity and constants

Know the rough time/space complexity of important paths, but also account for real costs:

- network round trips;
- disk I/O;
- serialization;
- database planning/indexes;
- encryption/compression;
- memory allocation and GC;
- lock contention.

A nominally O(n) loop that performs n remote calls is usually more important than an in-memory O(n log n) sort.

## 17.4 Avoid N+1 I/O

Bad:

```javascript
for (const order of orders) {
  order.customer = await customers.find(order.customerId);
}
```

Prefer batching, joins, dataloading, or prefetching where supported.

## 17.5 Stream large data

Do not read multi-gigabyte files/objects into memory merely because the API allows arrayBuffer().

Use bounded streaming pipelines when possible. Respect backpressure. Define maximum chunk/buffer sizes.

## 17.6 Cache only with an invalidation model

Before adding a cache, answer:

- what key uniquely identifies the value?
- how long may it be stale?
- who invalidates it?
- what happens on cache failure?
- is stampede protection needed?
- can sensitive data leak across tenants/users through the key?

A cache is replicated state. Treat it as a consistency decision, not a free speed switch.

## 17.7 Performance tests should protect important budgets

For genuinely performance-critical logic, capture a meaningful budget or benchmark so later changes do not accidentally regress it.

Avoid fragile nanosecond-level unit assertions on shared CI infrastructure. Test at a granularity that reflects product requirements.
