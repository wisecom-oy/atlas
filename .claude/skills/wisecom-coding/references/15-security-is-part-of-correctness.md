# 15. Security Is Part of Correctness

Security is not a final cleanup pass. Code is incorrect if an untrusted actor can make it violate its intended authorization, integrity, confidentiality, or availability properties.

## 15.1 Treat every external value as untrusted until validated

External values include:

- HTTP request bodies, query strings, headers, and cookies;
- uploaded files;
- queue/event payloads;
- data returned by third-party services;
- environment/configuration values;
- database values originally supplied by users;
- command-line arguments;
- deserialized objects.

Validate as early as practical at the trusted boundary.

Validation SHOULD cover two different dimensions:

Syntactic validation

Is the value structurally valid?

Examples:

- correct type;
- parseable UUID;
- valid enum member;
- correct string format;
- length within bounds;
- numeric range;
- object schema.

Semantic validation

Is the structurally valid value allowed in this context?

Examples:

- startDate <= endDate;
- requested quantity does not exceed policy limit;
- referenced tenant belongs to the authenticated principal;
- state transition is legal;
- filename/type is allowed for this endpoint.

Prefer allowlists/ranges/schema rules over trying to enumerate every bad input.

## 15.2 Client-side validation is UX, not a security boundary

Validate on the server/trusted component even if the browser/mobile app already validates. Clients can be modified or bypassed.

## 15.3 Keep authentication and authorization separate

Authentication answers who are you?

Authorization answers may this principal perform this action on this resource?

A valid login does not imply permission to access arbitrary object IDs.

Enforce authorization on the trusted side for every sensitive operation. Prefer policy helpers that express the domain:

```
if (!permissions.canEditProject(actor, project)) {
  throw new ForbiddenError();
}
```

Do not rely on a hidden UI button as authorization.

## 15.4 Prevent injection by separating data from code

For SQL, use prepared/parameterized statements rather than string concatenation.

Bad:

```
const sql = `SELECT * FROM users WHERE email = '${email}'`;
```

Correct pattern:

```
await db.query("SELECT * FROM users WHERE email = $1", [email]);
```

Apply the same principle to other interpreters:

- shell commands;
- HTML/JavaScript;
- LDAP;
- templates;
- regular expressions constructed from user input;
- path expressions.

Use the API's parameterization/escaping mechanism for the exact output context.

## 15.5 Avoid shelling out with untrusted strings

Prefer library APIs. If a process must be launched, pass arguments as structured argument arrays rather than constructing a shell command. Validate any user-controlled values and avoid invoking a shell unless its semantics are actually required.

## 15.6 Manage secrets as secrets

MUST NOT hard-code production credentials, API keys, private keys, or tokens in source code.

Secrets should have a controlled lifecycle:

- secure creation;
- least-privilege distribution;
- rotation;
- revocation;
- auditability;
- secure destruction.

Do not write secrets to logs, exceptions, test snapshots, analytics, build artifacts, or client-visible errors.

Configuration is not automatically safe merely because it comes from an environment variable. Treat secret-bearing configuration differently from normal configuration.

## 15.7 Never invent cryptography

Use mature, reviewed libraries and standard protocols.

Do not design custom encryption algorithms, custom MAC constructions, custom password hashing, or home-grown key derivation.

For stored encrypted data, prefer authenticated encryption modes/constructions so ciphertext integrity is verified as well as confidentiality. Keep keys separate from ciphertext according to the threat model and use an appropriate key-management system for serious deployments.

## 15.8 Passwords are not encrypted data

Passwords normally need one-way password hashing with a modern password-hashing function and per-password salt, not reversible encryption. Follow the platform/security standard in use rather than inventing parameters.

## 15.9 Validate file uploads by policy, not filename alone

Depending on risk, consider:

- explicit allowed content types/extensions;
- content inspection where necessary;
- maximum size;
- filename normalization;
- generated storage names;
- storage outside executable/static roots;
- malware scanning for relevant systems;
- decompression/archive limits;
- access control on retrieval.

Never trust ../../-style paths or an uploaded filename as a safe storage path.

## 15.10 Protect against resource abuse

Correctness includes bounded resource use.

Set reasonable limits on:

- request body size;
- batch size;
- pagination size;
- decompressed size;
- recursion/depth;
- regex complexity;
- concurrent work;
- retry count;
- queue message size;
- stream buffering;
- execution time.

A function that works only for honest small inputs may still be unsafe in production.

## 15.11 Return safe errors

External clients usually need a stable error code/message, not stack traces, SQL strings, file paths, provider secrets, or internal topology.

Keep detailed diagnostics in protected server-side telemetry.
