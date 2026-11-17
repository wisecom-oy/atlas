# 8. Data, Objects, and Abstraction

## 8.1 Hide representation when behavior matters

Public fields expose storage decisions as API decisions.

A rectangle whose callers freely mutate width and height cannot enforce invariants or change its representation without breaking callers.

However, replacing public fields with trivial getters/setters does not automatically create abstraction. This still exposes the same representation:

```
getWidth()
setWidth()
getHeight()
setHeight()
```

Prefer domain operations when the domain has behavior:

```
rectangle.resize(newSize);
vehicle.fuelRemainingPercent();
```

The interface exposes useful meaning rather than raw storage mechanics.

## 8.2 Distinguish objects from data structures

A behavior-rich object hides representation and exposes operations.

A data structure/DTO intentionally exposes fields because its job is to carry data.

Do not force DTOs to pretend to be rich objects. Plain data is appropriate at serialization boundaries, API payloads, events, query results, and configuration.

The important part is deliberate design.

## 8.3 Understand the object/data trade-off

Procedural/data-oriented design and polymorphic OO optimize different axes of change.

With plain shapes plus external geometry functions:

- adding a new operation can be easy;

- adding a new shape type may require editing every operation.

With a Shape interface and per-shape methods:

- adding a new shape type can be easy;

- adding a new operation may require editing every shape implementation.

Choose based on the likely direction of change. Do not apply OO as a universal preference.

## 8.4 Avoid train-wreck navigation

Code such as:

```
context.getOptions().getScratchDirectory().getAbsolutePath();
```

couples the caller to several internal relationships.

For behavior-rich objects, prefer telling the owner what you need:

```
context.createScratchFile(name);
```

This is closely related to the Law of Demeter and "tell, don't ask."

Direct field chains on plain immutable DTOs are less concerning, but still consider whether the caller is learning too much about structure.

## 8.5 Be cautious with hybrid objects

An Active Record-like object that mixes:

- persistence (save, delete),

- business rules (applyDiscount),

- remote calls,

- formatting,

can become tightly coupled as complexity grows.

Small systems may accept this trade-off. Larger domains generally benefit from separating:

- domain behavior;

- repositories/persistence;

- infrastructure clients;

- presentation/serialization.

Do not split layers solely for architectural fashion; split when independent concerns genuinely evolve or need separate testing.

## 8.6 Model impossible states out where practical

Types can replace defensive branches.

Instead of:

```
type Payment = {
  status: string;
  paidAt?: Date;
  failureReason?: string;
};
```

prefer a discriminated model:

```
type Payment =
  | { status: "pending" }
  | { status: "paid"; paidAt: Date }
  | { status: "failed"; failureReason: string };
```

Now a paid payment cannot accidentally exist without paidAt in typed code.

## 8.7 Preserve units and semantic types

Plain numbers are easy to mix up.

Where mistakes are costly, distinguish concepts such as:

- milliseconds vs seconds;

- cents vs euros;

- meters vs millimeters;

- user ID vs tenant ID;

- plaintext vs ciphertext;

- raw input vs validated input.

Use branded/newtype wrappers, value objects, or explicit suffixes such as timeoutMs when the language does not provide stronger units.
