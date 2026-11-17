# 5. Naming

Names are part of the program's design. A good name removes mental translation.

## 5.1 Reveal intent

A name SHOULD tell the reader what a value means or what an operation accomplishes.

Bad:

```
const d = 30;
const x = users.filter(u => u.a);
```

Better:

```
const sessionExpiryDays = 30;
const activeUsers = users.filter(user => user.isActive);
```

Prefer names such as:

- maxLoginAttempts

- unreadMessageCount

- activeUserAccounts

- generationTimestamp

- qualifiesForFreeShipping

over names that require decoding.

## 5.2 Avoid disinformation

A name MUST NOT imply a type, unit, lifecycle, or guarantee that is not true.

Do not call a value accountList if it is a map, iterator, query, or single object. Do not call a timestamp createdDate if it can include time-zone-sensitive time. Do not call an operation validate if it also writes data.

Avoid visually ambiguous identifiers such as l, I, O, and 0 where confusion is plausible.

## 5.3 Make meaningful distinctions

Do not create groups of near-synonyms that force the reader to inspect implementation to understand the difference:

```
getUser()
getUserInfo()
getUserData()
```

If the operations are different, name the actual difference:

```
getUserProfile()
getUserPermissions()
getUserBillingSummary()
```

Likewise, generic class suffixes such as Manager, Handler, Processor, Data, and Info are warning signs when they conceal responsibility.

OrderManager says little. OrderPricing, OrderPayment, and OrderFulfillment reveal ownership.

## 5.4 Use pronounceable names

Code is discussed verbally. A name that cannot be pronounced is harder to remember and review.

Prefer:

- generationTimestamp

- processor

- userRecords

- dataRecord

over compressed forms such as genymdhms, prcssr, or usrRcrds.

Use abbreviations only when they are standard vocabulary in the codebase or domain: id, url, http, cpu, ttl, sku, and similar well-understood terms.

## 5.5 Use searchable names

Wide-scope or important concepts SHOULD have names that can be searched directly.

Bad:

```
if (attempts > 7) { ... }
```

Better:

```
const MAX_LOGIN_ATTEMPTS = 7;
if (attempts > MAX_LOGIN_ATTEMPTS) { ... }
```

Name important constants when the value has meaning, policy, units, or reuse. Do not create a constant for every literal merely to eliminate literals.

A loop index i inside three obvious lines is fine. i passed through several functions is not.

## 5.6 Avoid type encodings

Do not encode obvious static types into identifiers:

```
strFirstName
iAge
bIsLoggedIn
```

Prefer:

```
firstName
age
isLoggedIn
```

Modern type systems and IDEs already expose types. Prefixes become stale when the representation changes.

## 5.7 Avoid mental mapping

The reader should not need a private dictionary such as:

- n means customer name;

- c means retry count;

- r means pending report;

- p means price.

Prefer direct vocabulary when the scope is large enough to benefit from it.

## 5.8 Match naming altitude to abstraction level

High-level names describe why or what. Low-level names can describe how.

Bad high-level name:

```
isCartOver50(cart)
```

Better:

```
qualifiesForFreeShipping(cart)
```

The threshold may later become 75 euros, customer-tier dependent, or campaign dependent. The domain name can remain stable while implementation changes.

Low-level helpers may be mechanical:

```
trimAndLowercase(value)
writeToRedis(key, value)
parseCsvRow(line)
```

## 5.9 Let context shorten names

A narrow, obvious namespace supplies context:

```
CsvImporter.open()
CsvImporter.read()
CsvImporter.close()
JSON.parse()
File.open()
Math.log()
```

Do not repeat context that the containing type already communicates:

```
CsvImporter.openCsvImporterFile() // redundant
```

Conversely, a globally visible constant should be more descriptive than a two-letter local.

Rule: the wider the scope, the more descriptive the name generally needs to be.

## 5.10 Boolean names should read as predicates

Prefer:

```
isActive

hasPermission

canRetry

shouldRefresh

requiresApproval
```

Avoid ambiguous state words such as status, flag, or enabledValue when a predicate is intended.
