# A plain http:// S3 endpoint is accepted without a warning, and the security docs do not mention the exposure

**Triage:** RECORD (high confidence, `security`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Problem or motivation

The CLI (`config-keys.ts:52`) and the SDK (`instance-config.ts:52`) both accept an `http://`
S3 endpoint and say nothing about it. Local MinIO is the legitimate reason to allow it.

Content stays protected over plain HTTP: it is AES-256-GCM ciphertext bound to its key, and
SigV4 never sends the secret key. What a network attacker still gets:

- Every object key in clear, which includes owner identifiers (mailbox addresses on Outlook
  paths, `docs/security.md:204`) and the plaintext content hashes described in #446.
- The access key id and the request pattern: which owners are backed up, when, and how much.
- The ability to answer a `PutObject` with a forged `200`. The backup then reports success for
  objects that were never stored, and nothing notices until the next `verify`.

The Graph client refuses to run with TLS verification disabled
(`graph-client.factory.ts:80`). The storage side has no equivalent, and neither
`docs/security.md` nor `docs/self-hosting.md` mentions the difference.

## Proposed solution

Warn once per run when the endpoint is `http://` and the host is not loopback, naming what is
exposed, and document it in `docs/security.md` and `docs/self-hosting.md`. Refusing outright
would break the documented local MinIO setup.

## Scope

Storage, CLI and SDK configuration.

## Acceptance criteria

- A non-loopback `http://` endpoint produces one warning per run that names the exposure.
- A loopback `http://` endpoint (the Docker MinIO setup) does not warn.
- `docs/security.md` and `docs/self-hosting.md` state what plain HTTP exposes and recommend TLS
  for any remote endpoint.
