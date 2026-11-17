# 12. Comments and Documentation

Comments are useful when they preserve information that the code cannot communicate by itself. They are harmful when they duplicate or contradict the code.

## 12.1 Prefer expressive code over explanatory narration

Bad:

```
// If cart has no items, return zero
if (cart.items.length === 0) return 0;
```

The comment adds no information.

Better code needs no narration:

```
if (cart.isEmpty()) return Money.zero();
```

## 12.2 Explain why, not what

Useful:

```
// Keep the free-tier limit low enough to prevent bulk abuse without
// penalizing normal interactive use. Product decision: BILLING-184.
const FREE_TIER_REQUEST_LIMIT = 5;
```

The code shows the number. The comment preserves the reason and source of the constraint.

Good comments can explain:

- business rationale;

- external compatibility constraints;

- security assumptions;

- non-obvious performance trade-offs;

- unusual algorithms or protocol behavior;

- temporary workarounds with a removal condition;

- dangerous operational constraints.

## 12.3 Comments must remain true

A stale comment is worse than no comment because it creates false confidence.

If code changes, update or remove nearby comments in the same change.

Treat comments as maintained source, not historical notes.

## 12.4 Warnings are appropriate when the danger is real

Examples:

```
// Not thread-safe. Create one formatter per request.
```

```
// This integration test performs a full dataset import and is intentionally
// excluded from the fast local suite.
```

Warnings should be specific enough to change behavior.

## 12.5 TODOs need an action and exit condition

Weak:

```
// TODO fix this
```

Useful:

```
// TODO: Remove this retry workaround after Chromium issue #114883 is fixed
// in the minimum supported browser version.
```

A TODO SHOULD identify at least one of:

- intended action;

- issue/ticket;

- owner if the repository uses owners;

- trigger/removal condition;

- reason the work cannot be completed now.

Do not use TODO as a hiding place for known correctness or security defects that must be fixed before release.

## 12.6 Public API documentation is a contract

Public APIs often need documentation even when implementation is clear.

Document information callers need:

- purpose;

- parameter semantics and units;

- return semantics;

- expected errors/exceptions;

- side effects;

- concurrency/thread-safety constraints;

- lifecycle/ownership requirements;

- examples when usage is non-obvious.

Do not fill public docs with implementation narration that can change without affecting callers.

## 12.7 Keep legal/license notices when required

License and attribution headers can be legally necessary. Do not remove them merely because they are not executable code.

## 12.8 Delete noise

Remove comments such as:

```
// increment counter
counter++;
```

```
// get username
const username = user.username;
```

Redundant comments create comment blindness and double the material that can become stale.

## 12.9 Replace magic-equation comments with named concepts

Weak:

```
const capacity = dataLength * 4 + 12; // room for header and padding
```

Better:

```
const ENCODED_BYTES_PER_INPUT_BYTE = 4;
const HEADER_BYTES = 8;
const PADDING_BYTES = 4;

const capacity =
  dataLength * ENCODED_BYTES_PER_INPUT_BYTE +
  HEADER_BYTES +
  PADDING_BYTES;
```

The names make the equation inspectable. A comment can still explain why those protocol constants exist if that is not obvious.

## 12.10 Source control is the history

Delete commented-out code, date-based change logs, and old implementations.

Do not keep this:

```
// Old implementation retained here
// function calculateTotalOld(...) { ... }
```

Version control already preserves history and authorship. The working tree should represent current truth.

## 12.11 Avoid decorative comment clutter

Large banners such as:

```
// ==========================================
// =============== HELPERS ==================
// ==========================================
```

usually indicate that the file may be carrying too many responsibilities.

Prefer structural decomposition.

Small ecosystem-standard navigation markers such as // MARK: can be useful when a framework/community genuinely uses them.

## 12.12 Keep comments plain and actionable

Avoid biographies of old debugging sessions, giant prose histories, or HTML-heavy documentation for simple internal helpers.

Instead of:

```
R.J. thought this might race, then I tried X, then Sam suggested Y...
```

write the current truth:

```
// This call can exceed 5 s when the upstream index is rebuilding.
// Keep the timeout above the provider's documented 4 s maintenance window.
```

Link to a ticket/design document if historical context still matters.
