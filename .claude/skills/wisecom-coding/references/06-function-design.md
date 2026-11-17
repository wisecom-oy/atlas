# 6. Function Design

Functions are the primary unit of local reasoning. A good function has a clear purpose, explicit inputs, predictable effects, and a narrow failure surface.

## 6.1 Do one conceptual thing

A function SHOULD operate at one conceptual level.

Bad:

```
async function processOrder(order: Order) {
  // validate stock
  // calculate totals
  // call payment provider
  // write database rows
  // construct email HTML
  // send warehouse notification
}
```

Better:

```
async function processOrder(order: Order) {
  await validateOrder(order);
  const total = calculateOrderTotal(order);
  const payment = await chargeOrder(order, total);
  const savedOrder = await saveOrder(order, payment);
  await notifyWarehouse(savedOrder);
  return savedOrder;
}
```

The orchestration remains high-level. Each subordinate function handles its own lower-level detail.

"One thing" does not mean "one statement." It means the function's steps belong to one coherent abstraction.

## 6.2 Keep functions small enough to understand at a glance

There is no correct universal line limit. Use these signals instead:

A function is probably too large when it:

- changes abstraction level repeatedly;

- needs section comments to explain internal phases;

- contains deeply nested conditionals;

- owns several unrelated state changes;

- has multiple independent reasons to change;

- cannot be named without and, or, process, or another vague umbrella term;

- is difficult to test without setting up unrelated concerns.

Extract meaningful concepts, not arbitrary chunks of lines.

## 6.3 Follow the step-down rule

Source should read top-down from policy to mechanism.

```
async function processOrder(input: OrderInput) {
  const order = await createValidatedOrder(input);
  const total = calculateTotal(order);
  await collectPayment(order, total);
  await startFulfillment(order);
}

function calculateTotal(order: Order) {
  const subtotal = sumLineItems(order.items);
  const discounted = applyDiscount(subtotal, order.discount);
  return addTax(discounted, order.taxRegion);
}
```

A reader can stop at the level they need.

## 6.4 Prefer few positional parameters

Every positional argument is something the caller must remember.

Hard to read:

```
createUser("John Doe", "john.doe@example.com", 42, "Example City", true);
```

Clearer:

```
createUser({
  name: "John Doe",
  email: "john.doe@example.com",
  age: 42,
  city: "Example City",
  isPremium: true,
});
```

However, do not mechanically replace every three-argument function with an object. Strongly related values can be natural:

```
moveTo(x, y);
setRgb(red, green, blue);
```

Ask whether the arguments form one recognizable concept and whether call sites are unambiguous.

## 6.5 Move context to the owner

Instead of passing an infrastructure object into every function:

```
sendEmail(message, smtp);
```

prefer behavior owned by the contextual object:

```
smtp.sendEmail(message);
```

Likewise, a service with a stable dependency should generally receive that dependency at construction rather than passing it through every call.

## 6.6 Avoid boolean mode flags

A boolean argument often creates two functions hidden inside one signature:

```
createUser(true);
```

The call site does not explain what true means.

Prefer explicit operations:

```
createAdminUser();
createMemberUser();
```

or a meaningful enum/options object when there are legitimate modes:

```
createUser({ role: "admin" });
```

A boolean is fine when the meaning is obvious from domain language and does not split unrelated workflows, but treat it as a design smell.

## 6.7 Make side effects explicit

A query-shaped name must not secretly mutate unrelated state.

Bad:

```
if (userLoggedIn(user)) {
  // function also updates lastSeen and initializes session
}
```

Better:

```
if (isUserLoggedIn(user)) {
  updateLastSeen(user.id);
}
```

Or, if both actions are genuinely one command:

```
authenticateAndInitializeSession(credentials);
```

The name should reveal mutation.

## 6.8 Use command-query separation where useful

A query returns information. A command changes state.

Ambiguous:

```
if (settings.set("role", "admin")) {
  ...
}
```

Does the return value mean the key existed, the write succeeded, or the value changed?

Clearer:

```
if (!settings.has("role")) {
  settings.set("role", "admin");
}
```

CQS is a clarity heuristic, not an absolute ban on methods that both mutate and return useful data. For example, Map.delete(key): boolean can be a perfectly clear atomic operation. The contract matters.

## 6.9 Separate happy-path logic from error-policy logic

Error handling should not drown the algorithm in repeated checks.

Bad:

```
const account = await createAccount(input);
if (!account.ok) return mapError(account.error);
const profile = await createProfile(account.value);
if (!profile.ok) return mapError(profile.error);
const email = await sendWelcomeEmail(profile.value);
if (!email.ok) return mapError(email.error);
```

Depending on language and failure semantics, centralize the policy:

```
try {
  return await performRegistration(input);
} catch (error) {
  throw mapRegistrationError(error);
}
```

or compose typed results so that expected domain errors remain explicit without repeating mapping boilerplate.

## 6.10 Avoid repeated type switches

If the same discriminator switch appears in many operations, behavior likely belongs with the type or a strategy.

Repeated:

```
switch (employee.type) { ... } // calculatePay
switch (employee.type) { ... } // benefits
switch (employee.type) { ... } // report
```

Prefer an interface when type-specific behavior is open-ended:

```
interface Employee {
  calculatePay(): Money;
  getBenefits(): Benefits;
  generateReport(): Report;
}
```

A factory may contain one centralized switch to create the correct implementation.

Do not replace every switch with polymorphism. A stable finite state machine, parser, protocol discriminator, or simple exhaustive union may be clearer as an explicit switch. The smell is repeated type branching distributed across the codebase.

## 6.11 Use DRY carefully

If several functions duplicate the same policy, centralize it:

```
async function fetchJson<T>(endpoint: string, timeoutMs = 5_000): Promise<T> {
  // authoritative timeout, status handling, parsing, etc.
}
```

Then callers do not independently implement timeout and error policy.

But DRY means "one authoritative representation of a concept," not "no repeated lines." Two blocks that happen to look similar may encode different business rules and may diverge later.

Prefer this sequence:

- tolerate small duplication while the concepts are uncertain;

- observe whether the behavior changes together;

- extract only when the shared concept is real;

- keep extension points no more general than current evidence requires.

An incorrect abstraction creates coupling that is harder to remove than straightforward duplication.

## 6.12 Clean code is written iteratively

The first implementation may be messy because the problem is still being discovered. That is acceptable if the process continues:

- make behavior work;

- protect it with tests;

- identify concepts;

- improve names;

- extract coherent functions;

- remove unnecessary nesting;

- remove real duplication;

- align levels of abstraction;

- run tests after each meaningful refactor.

Do not confuse "first draft works" with "change is complete."
