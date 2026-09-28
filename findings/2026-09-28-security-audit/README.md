# Security audit against Kerckhoffs's principle, 2026-09-28

Kerckhoffs's principle: a system must stay secure when everything about it except the key is
public. Atlas is open source, so the design, formats, parameters and storage layout are public by
definition. The only secret is the tenant passphrase and the data key (DEK) it unwraps. The
attacker in this audit can read the code, and can read (and for integrity questions, write) the
backup bucket, but does not hold the passphrase.

Audited at commit `4d6ee39` (v5.2.2).

| #         | Finding                                                                                               | Priority | Labels            |
| --------- | ----------------------------------------------------------------------------------------------------- | -------- | ----------------- |
| 01 (#446) | [Object keys are the unkeyed plaintext SHA-256](01-plaintext-hash-in-object-keys.md)                  | medium   | `bug`, `security` |
| 02 (#447) | [CLI creates a tenant key under any passphrase length](02-cli-bootstraps-key-under-any-passphrase.md) | medium   | `bug`, `security` |
| 03 (#448) | [Plain `http://` S3 endpoint accepted silently](03-plain-http-s3-endpoint.md)                         | low      | `security`        |

Added as evidence to #436: `validate_dek_match` leaves its key service undestroyed and the two
unwrapped data keys unzeroed when the second unwrap throws.

## What holds

| Area                           | Verdict                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KDF                            | scrypt N=65536, r=8, p=1, 32-byte random salt per wrap, tenant id as a length-prefixed domain separator. Parameters live in the blob and are bounds-checked (N from 2^14 to 2^20), so publishing them costs nothing and a crafted blob cannot force a huge allocation. |
| DEK wrap                       | AES-256-GCM with the blob header (version, KDF id, parameters) as AAD, so the parameters cannot be downgraded. KEK zeroed in `finally`.                                                                                                                                |
| Content cipher                 | AES-256-GCM, random 96-bit IV per object from `randomBytes`, versioned header plus the key's directory as AAD (#350), so an object cannot be moved across owners or purposes.                                                                                          |
| Integrity                      | Plaintext SHA-256 in the encrypted manifest, compared in constant time before restore writes anything (#340). Manifests are checked against the key that named them.                                                                                                   |
| Legacy objects                 | Headerless objects decrypt without AAD and can be moved. `docs/security.md` documents this limit in full, including that dedup keeps old objects unbound.                                                                                                              |
| Replay and rollback            | Not prevented by the cipher. Documented as the job of Object Lock and versioning.                                                                                                                                                                                      |
| Governance mode                | Bypass with `s3:BypassGovernanceRetention` documented in `docs/operations/immutability.md`.                                                                                                                                                                            |
| DEK usage ceiling and rotation | Tracked in #396 and #397.                                                                                                                                                                                                                                              |
| Secrets in argv                | Replication and rehydration secret options accept `-` to read stdin.                                                                                                                                                                                                   |
| Secrets in logs                | No log line interpolates a passphrase, client secret, S3 secret, DEK or KEK.                                                                                                                                                                                           |
| Graph transport                | Refuses to run with `NODE_TLS_REJECT_UNAUTHORIZED=0`.                                                                                                                                                                                                                  |
| Local config store             | AES-256-GCM, key in the OS keyring, or a `0600` file with a warning. Threat model documented. The macOS keychain path passes the store key through argv once at setup, which the code comments on.                                                                     |
| Randomness                     | Every key, IV and salt comes from `crypto.randomBytes`. `Math.random` is used only for retry jitter.                                                                                                                                                                   |
| Rehydration                    | Refuses to replace a primary's DEK unless the bucket holds nothing else (#26).                                                                                                                                                                                         |
