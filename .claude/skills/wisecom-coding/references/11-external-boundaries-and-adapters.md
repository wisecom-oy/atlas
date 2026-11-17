# 11. External Boundaries and Adapters

Third-party code changes on its schedule, not yours.

## 11.1 Own the interface your application depends on

Bad architecture:

- checkout imports Stripe SDK directly;

- refunds import Stripe SDK directly;

- receipt generation imports Stripe SDK directly;

- tests mock vendor-specific methods everywhere.

Preferred architecture:

```
interface Payments {
  charge(input: ChargeRequest): Promise<Receipt>;
  refund(paymentId: PaymentId, amount: Money): Promise<Refund>;
}
```

A StripePaymentsAdapter implements that interface and contains Stripe-specific details.

Application code depends on Payments, not on Stripe.

## 11.2 Translate dependency errors at the boundary

Do not leak SdkClientException, NoSuchKeyException, provider status codes, or transport internals throughout business logic.

Map them into errors the application owns:

```
class ObjectNotFound extends Error {}
class StorageUnavailable extends Error {}
```

Preserve the original cause for diagnostics.

## 11.3 Keep policy out of adapters when possible

An adapter should translate between your interface and the external API. It should not silently decide business policy such as:

- whether a failed payment should be retried;

- whether a missing customer should be recreated;

- whether a 409 means the order is accepted.

Keep business policy in an application/domain layer where it is testable and visible.

## 11.4 Dependency injection enables local tests

Inject the owned interface:

```
class CheckoutService {
  constructor(private readonly payments: Payments) {}
}
```

Tests can supply a fake:

```
const payments = new FakePayments();
```

A unit test should not need a live payment account merely to test discount logic.

## 11.5 Wrap volatile libraries, not everything

A wrapper has value when it creates an owned stability boundary, normalizes errors, limits API surface, or improves testability.

Do not create a one-line wrapper around every standard-library call. Indirection without a reason makes code harder to navigate.
