# 20. API Design

## 20.1 Make invalid usage hard

Prefer APIs that guide callers toward correct behavior.

Weak:

```
updateUser(id, fields: Record<string, unknown>)
```

Stronger:

```
updateUserProfile(id, input: UpdateUserProfileInput)
```

with a schema/type that exposes only mutable fields.

## 20.2 Use domain-specific operations over generic mutation

Instead of:

```
setStatus(orderId, "cancelled")
```

prefer:

```
cancelOrder(orderId, reason)
```

The operation can enforce transition rules and trigger required effects.

## 20.3 Be explicit about pagination

List APIs should define:

- ordering;
- stable cursor/key semantics;
- maximum/default page size;
- filters;
- behavior when underlying data changes.

Offset pagination can be fine for small/stable data; cursor/keyset pagination is often more robust for large changing datasets.

## 20.4 Make units explicit

Prefer timeoutMs, sizeBytes, distanceMm, or semantic value objects when raw numbers cross an API boundary.

## 20.5 Version contracts deliberately

For externally consumed APIs/events:

- distinguish additive compatible changes from breaking changes;
- avoid silently changing field meaning;
- make consumers tolerant of documented evolution where appropriate;
- deprecate with a migration path;
- contract-test critical integrations.
