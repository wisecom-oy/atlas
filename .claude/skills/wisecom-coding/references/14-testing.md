# 14. Testing

Tests are executable descriptions of behavior and a safety system for change.

## 14.1 Test behavior, not implementation trivia

Prefer:

- it("rejects a registration when the email already exists", ...)

over:

- it("calls repository.findByEmail once", ...)

unless the call itself is the contract or an important integration requirement.

Tests coupled to private implementation make harmless refactoring expensive.

## 14.2 The TDD loop

The classic three laws of TDD are:

- do not write production code until a test fails;
- write only enough test to demonstrate the next failure;
- write only enough production code to make the test pass.

A practical loop is:

- Red - add a small failing behavioral test.
- Green - implement the simplest correct behavior.
- Refactor - improve structure while keeping the suite green.

This is especially effective for business rules, parsers, state transitions, bug fixes, and algorithms.

For exploratory spikes, generated prototypes, or difficult integration discovery, exploration may come first. Before the change becomes production code, capture the important behavior in durable tests.

## 14.3 Keep test code clean

Test code is maintained code.

A tangled test suite becomes expensive, then slow, then ignored, and eventually stops protecting the application.

Apply the same standards to tests:

- meaningful names;
- clear setup;
- small helpers;
- deliberate duplication/abstraction;
- no mysterious constants;
- deterministic behavior;
- no dead tests.

## 14.4 Tests enable refactoring

A good characterization/behavior suite lets implementation change radically while observable behavior stays stable.

This is one of the largest values of tests: they improve changeability.

When refactoring legacy code:

- capture current required behavior;
- distinguish required behavior from accidental bugs if possible;
- refactor in small steps;
- keep tests green;
- add tests for newly discovered edge cases.

## 14.5 Hide incidental setup

A test should emphasize the values relevant to the behavior.

Hard to read:

```
// dozens of lines constructing HTTP server, database fixtures,
// auth tokens, headers, and unrelated fields
```

Better:

```
givenCustomer("customer-1");
givenOrder({ id: "order-1", customerId: "customer-1" });

const response = await getOrders("customer-1");

expectOrderIds(response, ["order-1"]);
```

Use builders, factories, fixtures, or a small test DSL to hide noise. Do not hide the values that actually matter to the assertion.

## 14.6 Use Arrange / Act / Assert or Given / When / Then

Either structure helps tests read as behavior:

```javascript
it("rejects an expired card", () => {
  // Arrange / Given
  const today = new Date("2026-09-13");
  const card = cardExpiring("2026-08");

  // Act / When
  const result = validateCard(card, today);

  // Assert / Then
  expect(result).toEqual({ ok: false, reason: "EXPIRED" });
});
```

Comments for the three sections are optional if spacing and helper names already make the phases obvious.

## 14.7 One concept per test

A test may contain several assertions if they jointly prove one concept.

Good:

```javascript
it("creates an unverified member", () => {
  expect(user.role).toBe("member");
  expect(user.verifiedAt).toBeNull();
});
```

Separate concept:

- it("never exposes the password in the returned user", ...)

Separate concept:

- it("rejects an email that is already registered", ...)

When one assertion fails, the test name should tell the maintainer what behavior broke.

## 14.8 F.I.R.S.T. tests

Good unit tests should generally be:

- **Fast** - Developers should run them frequently.

- **Independent** - One test must not rely on another test running first or mutating shared state.

- **Repeatable** - The same code and inputs should produce the same result locally and in CI. Control time, random seeds, environment, and external services where necessary.

- **Self-validating** - The test should automatically pass or fail. No manual log inspection should be required.

- **Timely** - Write tests close to the behavior they protect. Tests added months later often reveal that the design has become difficult to isolate.

## 14.9 Use the right test level

- **Unit tests** - Use for pure logic, domain rules, parsers, transformations, state transitions, and failure mapping.

- **Integration tests** - Use for boundaries whose real behavior matters: database mappings, queues, object storage, serialization, framework routing, adapters.

- **Contract tests** - Use to verify the assumptions between services/providers when interface drift is a risk.

- **End-to-end tests** - Use sparingly for critical user flows across the assembled system. They provide broad confidence but are slower and harder to diagnose.

Do not try to prove everything through end-to-end tests.

## 14.10 Test boundaries and failures

For important logic, include:

- minimum/maximum values;
- empty collections;
- unknown/missing records;
- duplicate requests;
- malformed input;
- unauthorized users;
- timeout/dependency failure;
- concurrency conflict where relevant;
- partial-state recovery;
- exact boundary transitions (<, <=, >, >=);
- time-zone/daylight-saving boundaries when time matters.

## 14.11 Bug fixes should usually gain a regression test

A bug demonstrates that the existing suite did not capture an important behavior.

Preferred sequence:

- reproduce the bug with a failing test;
- implement the fix;
- verify the test now passes;
- retain the test to prevent recurrence.
