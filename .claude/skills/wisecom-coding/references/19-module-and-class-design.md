# 19. Module and Class Design

## 19.1 Give each module one primary reason to change

A class named OrderManager that calculates totals, applies discounts, charges cards, issues refunds, writes storage, sends emails, and mutates status has several unrelated axes of change.

Prefer cohesive responsibilities such as:

- OrderPricing
- OrderPayment
- OrderRepository
- OrderNotifier

Do not create dozens of one-method classes purely to satisfy SRP. Split when the responsibilities are independently meaningful.

## 19.2 Public APIs should use domain vocabulary

Instead of exposing a generic email primitive:

- notifier.send(to, subject, body);

an order-focused notifier can expose:

- notifier.orderConfirmed(order);
- notifier.orderShipped(order);
- notifier.orderRefunded(order);

Keep template mechanics private. The caller says what happened, not how to construct the message.

## 19.3 Keep the public surface small

Every public method becomes something callers can depend on.

Default helpers to private/internal. Expose only operations required across the boundary.

A small public API:

- reduces coupling;
- permits refactoring internals;
- narrows security/test surface;
- makes ownership easier to understand.

## 19.4 Prefer composition for capabilities

Inheritance is useful when there is a genuine substitutable "is-a" relationship and the hierarchy is stable.

Prefer composition when you merely need to reuse behavior or combine independent capabilities.

A shared base class created only to remove five repeated lines often produces hidden coupling.

## 19.5 Avoid god modules

Warning signs:

- vague name;
- hundreds/thousands of unrelated lines;
- imports from every subsystem;
- many unrelated public methods;
- unrelated tests require instantiating the same class;
- one change routinely causes merge conflicts.

Split by stable responsibility or domain capability, not by arbitrary line count.

## 19.6 Dependency direction matters

High-level business policy should not depend directly on volatile infrastructure details.

A useful direction is:

- Domain/Application -> owned interfaces <- Infrastructure adapters

This is not a mandate for ceremonial "Clean Architecture" layers in every small project. The essential idea is to keep volatile external mechanisms from leaking into the core policy everywhere.
