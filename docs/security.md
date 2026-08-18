# Security Model

Atlas uses **envelope encryption** to isolate tenants cryptographically. This page explains the full encryption architecture, what is protected, what is not, and the security properties you can rely on.

## Key Hierarchy

```
Master passphrase (env var or SDK config)
    |
    v
scrypt(passphrase, [tenant_id + per-wrap random salt], N=65536, r=8, p=1)  -->  KEK (256-bit)
    |
    v
KEK wraps/unwraps a random DEK (AES-256-GCM, header authenticated as AAD)
    |
    v
DEK encrypts all data + manifests for that tenant
```

The wrapped DEK at `_meta/dek.enc` is a **versioned blob**: a self-describing header (KDF id, scrypt parameters including a 32-byte random salt) followed by the encrypted DEK. Each time the DEK is re-wrapped, a fresh salt is generated. The header is authenticated as additional data (AAD) on the GCM envelope, so version or parameter tampering is detected on unwrap.

### Why Envelope Encryption

Envelope encryption separates the key that protects your data (DEK) from the key that protects that key (KEK). This means:

- The DEK is a random 256-bit key with maximum entropy -- it does not depend on passphrase strength.
- The KEK is derived from your passphrase and only used to wrap/unwrap the DEK.
- If you need to change the passphrase in the future, only the DEK wrapper needs to be re-encrypted -- not every object in storage.

### KEK Derivation: scrypt

The KEK is derived using **scrypt**, a memory-hard key derivation function designed to resist brute-force attacks from GPUs and custom hardware (ASICs). Unlike simpler hash functions, scrypt requires a large amount of RAM for each derivation attempt, making parallel attacks expensive.

Parameters used by Atlas for **new** DEK wraps:

| Parameter           | Value                          | Purpose                                                                                   |
| ------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| N (cost)            | 65536                          | CPU/memory cost factor (2^16, OWASP recommendation for sensitive workloads)               |
| r (block size)      | 8                              | Memory usage multiplier                                                                   |
| p (parallelism)     | 1                              | Sequential derivation (no parallel lanes)                                                 |
| Salt                | 32-byte random + tenant domain | Per-wrap random salt combined with length-prefixed `tenant_id` for cross-tenant isolation |
| Output              | 32 bytes (256 bits)            | AES-256 key length                                                                        |
| Minimum N on unwrap | 16384                          | Blobs with weaker parameters are rejected                                                 |

The **tenant-domain salt** ensures that the same passphrase and random salt produce different KEKs for different tenants. A fresh random salt is generated on every DEK wrap, so re-wrapping the DEK after a passphrase change uses new scrypt parameters without relying on a separate `_meta/kek_params.json` file.

### DEK: Data Encryption Key

- **Generated once** per tenant: a cryptographically random 256-bit key.
- **Stored wrapped** as a versioned blob at `_meta/dek.enc` in the tenant's S3 bucket (KDF parameters and encrypted DEK in one self-describing object).
- **Never stored in plaintext** -- only exists in memory during a backup/restore run.
- **Re-derived on every run**: Atlas reads `_meta/dek.enc`, derives the KEK from the passphrase, unwraps the DEK, and holds it in memory for the session.

::: danger Passphrase Is Irrecoverable
There is **no key rotation mechanism** and **no recovery path**. If you lose the passphrase, the DEK cannot be unwrapped, and all data for that tenant is permanently inaccessible. Changing the passphrase without migrating the wrapped DEK will cause GCM authentication failures when Atlas tries to unwrap `_meta/dek.enc`.

**Treat the passphrase as critically as the data itself.** Store it in a password manager, a sealed envelope in a safe, or a secrets management system -- but never lose it.
:::

## Encryption Details

### Algorithm: AES-256-GCM

Every encrypt operation uses **AES-256-GCM** (Galois/Counter Mode), which provides both confidentiality and authenticity in a single pass:

- **Confidentiality**: the plaintext is encrypted and unreadable without the key.
- **Authenticity**: a 16-byte authentication tag is computed over the ciphertext, meaning any tampering (even a single flipped bit) is detected on decryption and causes an immediate failure.

### Ciphertext Format

```
[12-byte IV][16-byte GCM auth tag][ciphertext]
```

Every encrypt operation generates a **fresh random 12-byte IV** (initialization vector). This is critical for GCM security -- reusing an IV with the same key would be catastrophic, potentially exposing the XOR of two plaintexts and compromising the authentication key. Atlas generates a new random IV for every single object it encrypts.

### What Is Encrypted at Rest

| Data                                       | Encrypted | Notes                                                                      |
| ------------------------------------------ | --------- | -------------------------------------------------------------------------- |
| Email message bodies                       | Yes       | Stored as encrypted JSON under `data/{mailbox}/{sha256}`                   |
| Attachments                                | Yes       | Stored as encrypted blobs under `attachments/{mailbox}/{sha256}`           |
| Manifests                                  | Yes       | Contains subjects, folder names, delta URLs, checksums                     |
| OneDrive file blobs                        | Yes       | Keys under `onedrive/data/{owner_id}/{sha256}`                             |
| OneDrive manifests / indexes / delta state | Yes       | Under `onedrive/manifests`, `onedrive/index`, `onedrive/_meta`             |
| Wrapped DEK                                | Yes       | `_meta/dek.enc` is encrypted with the KEK                                  |
| S3 object metadata                         | **No**    | `x-message-id` on mailbox objects is visible to anyone with S3 read access |

Mailbox objects carry `x-message-id` in S3 metadata for operational diagnostics. OneDrive objects no longer store file identifiers, version identifiers, or plaintext checksums in unencrypted metadata -- all such metadata is stored inside encrypted manifests and version indexes.

Manifests deserve special attention: they contain email subjects, folder display names, and Microsoft Graph delta URLs. All of this metadata is encrypted with the same DEK, so subject lines and folder names are never exposed at rest in the S3 bucket.

### OneDrive blobs and sidecars

OneDrive file ciphertext uses keys such as `onedrive/data/{owner_id}/{sha256}` (see [OneDrive Backup](./onedrive-backup.md)). The `{owner_id}` segment is the **Entra object ID**, not an SMTP address, so bucket listings do not reveal which email account owns a subtree unless an attacker can correlate Graph IDs.

OneDrive data blobs carry no unencrypted S3 metadata. File identifiers, version identifiers, and plaintext checksums are stored exclusively inside encrypted manifests and version indexes, preventing known-plaintext fingerprinting via S3 `HeadObject`/`ListObjects` access.

## User identity in storage paths

**OneDrive (CLI `atlas onedrive`)** always resolves interactive owner inputs that look like email/UPN to an Entra object ID (`GET /users/{email}` with `id` selected) before computing S3 prefixes. Passing a bare UUID to `--owner` skips resolution and must match the user's directory object ID.

**Mailbox backup** still namespaces `data/`, `attachments/`, and `manifests/` by the mailbox identifier wired into the sync job (today this is commonly the primary SMTP address from discovery). That is a separate layout from OneDrive's object-ID paths. Operators who rely on privacy through opaque IDs should prefer object IDs for new automation and be aware older mailbox prefixes may still contain human-readable addresses.

There is **no built-in S3 object rename** between email-keyed and ID-keyed mailbox prefixes in the open-source CLI as shipped; migrating layout is an operational exercise (re-backup, copy, or custom tooling) if you need to align naming.

## Integrity Validation

Atlas validates data integrity at three independent layers. Each layer catches a different class of failure:

| Layer         | Mechanism                           | What It Catches                                          | When                                 |
| ------------- | ----------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| **Plaintext** | SHA-256 checksum stored in manifest | Corruption before encryption, application bugs           | Backup, verify, save                 |
| **Transport** | `Content-MD5` header on S3 PUT      | Network corruption during upload (bit flips, truncation) | Every upload (S3 rejects mismatches) |
| **At-rest**   | AES-256-GCM authentication tag      | Storage-level tampering or corruption                    | Every decrypt operation              |

### How Verification Works

When you run `atlas outlook verify`, Atlas performs a full integrity check for a snapshot:

1. Downloads each encrypted object from S3.
2. Decrypts it with the tenant DEK (GCM auth tag validates ciphertext integrity).
3. Computes SHA-256 of the decrypted plaintext.
4. Compares against the checksum stored in the manifest using **constant-time comparison** (`timingSafeEqual`) to prevent timing attacks.

Currently, `atlas outlook verify` checks **message body entries** listed in the manifest. Attachments are implicitly protected by GCM authentication during any decrypt operation (backup, restore, save).

### Content-MD5 on Uploads

Every object uploaded to S3 includes a `Content-MD5` header computed from the **ciphertext** (not the plaintext). This is a transport integrity check -- if a network error corrupts the data in flight, S3 will reject the upload with a checksum mismatch. This is separate from the application-layer SHA-256, which validates the original plaintext content.

## Erasure

Deletion is a security control, not a housekeeping convenience: an erasure request answered incorrectly is a compliance failure that looks like a success.

### Versions are the data

Every Atlas delete removes the object **and each of its noncurrent versions**, addressing them by version id. On a bucket with versioning enabled -- mandatory for Object Lock, so present in every immutability deployment -- a `DeleteObject` call that omits the version id writes a delete marker instead of erasing anything. The object vanishes from listings, the reported count goes up, and the plaintext is still one `GetObject?versionId=` away. Delete markers themselves are swept too, but never counted as erased data, because removing one uncovers versions rather than destroying them.

### A tenant purge sweeps the bucket

`purge_tenant` enumerates the whole bucket rather than a list of known prefixes. Prefix lists go stale as workloads are added -- the tenant tree now holds Outlook, OneDrive, SharePoint, and the identity registry -- and a stale list erases less than the operator was told.

The encrypted DEK is deleted last, and only when the sweep reports nothing left. Removing the key first would produce the worst available outcome: ciphertext that can no longer be restored and cannot be reported as erased either.

### Retained versus failed

A refused delete is classified as **retained** only when the backend names Object Lock as the reason -- AWS answers `AccessDenied: Access Denied because object protected by object lock`, MinIO answers `InvalidRequest: Object is WORM protected and cannot be overwritten`. Retained objects become deletable when their retention window expires, so the operator can wait.

Everything else is a **failure**: a missing `s3:DeleteObjectVersion` permission, an unreachable endpoint, a bucket policy. None of those resolve on their own. Reporting an IAM gap as "retained" would tell an operator that an erasure is on track when nothing is scheduled to happen, so the classifier errs toward failure -- a false alarm costs an investigation, a false all-clear costs the erasure.

## Replication Security

### Shared Encryption Model

Atlas replication uses a shared encryption model: all storage targets (primary and secondary) share the same master passphrase and the same per-tenant DEK. Ciphertext is copied byte-for-byte during replication -- no decryption or re-encryption occurs.

This means:

- **One passphrase protects all copies.** Compromising the passphrase compromises data on every target.
- **One DEK per tenant across all targets.** The wrapped DEK (`_meta/dek.enc`) is copied to each target on first replication.

### Access Isolation

While encryption keys are shared, **S3 access credentials should be separate per target**. Use independent IAM principals for each storage endpoint:

- Primary MinIO: `atlas-primary` user with full read/write
- Offsite MinIO: `atlas-offsite` user with full read/write
- Cloud S3: dedicated IAM role with scoped permissions

If an attacker compromises one target's S3 credentials, they can read that target's data (which is encrypted) but cannot reach other targets. Combined with a strong passphrase, this provides defense in depth.

### DEK Mismatch Protection

Atlas validates encryption key consistency before every replication and rehydration. If the primary tenant was purged and re-initialized (generating a new DEK), replication to a target with the old DEK is refused with an explicit error. This prevents a scenario where objects encrypted with different keys coexist on the same target, making older objects permanently undecryptable.

### Replica Marker

Atlas writes a marker file (`_meta/replica.marker`) on each target during first replication. If a user accidentally runs `atlas outlook backup` against a replica target, Atlas detects the marker and logs a warning. This guards against accidental violation of the primary-is-truth principle, which could lead to data inconsistency.

### Replication Status Encryption

Replication status sidecar files stored under `_meta/replication/` in the primary bucket are encrypted with the tenant DEK. Target endpoints, checksums, and error messages are not exposed at rest in S3.

## S3 Permissions by Command Class

Atlas splits its storage access in two, so a browsing operator never needs write credentials:

| Command class                                                                                                 | S3 actions required                                                                                        | Provisioning |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------ |
| Read-only: `outlook list`, `outlook read`, `outlook status`, `outlook verify`, `onedrive list`, `sharepoint list`, `stats`, `list-users` | `s3:GetObject`, `s3:ListBucket`                                                                             | None         |
| Write: `backup`, `restore`, `save`, `replicate`, `rehydrate`, `delete`                                          | the above plus `s3:CreateBucket`, `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, lifecycle/lock configuration | Yes          |

Read-only commands load the tenant context without provisioning: the bucket is never created and a missing `_meta/dek.enc` is never generated. Browsing a tenant that has never been backed up — a mistyped `-t`, or a tenant id from another environment — fails with `No backups found for tenant <id>` instead of leaving behind a lifecycle-configured bucket containing nothing but key material. That matters for two reasons: a wrapped DEK written on a read path is an audit-log surprise in a compliance-facing product, and buckets born from typos are indistinguishable from real tenants when reviewing storage.

Grant a monitoring or audit principal the read-only row only. If it holds `s3:CreateBucket`, that is a leftover from Atlas versions before 2.1.0-beta and can be revoked.

## Configuration File Security

### Filesystem Permission Check

`atlas.config.json` may contain `encryption_passphrase` and `client_secret` in plaintext. On Unix systems, Atlas checks the file's permissions at load time and logs a warning if the file is group- or world-readable (i.e., any bits in `0o077` are set):

```
WARN Config file /home/user/atlas.config.json has overly permissive permissions (mode 0644). Recommended: chmod 600 /home/user/atlas.config.json
```

This check is skipped on Windows where Unix permission bits do not apply. The check is advisory (warning, not error) to avoid breaking existing deployments, but operators are strongly encouraged to restrict config files to owner-only access (`chmod 600`).

Environment variables (`ATLAS_*`) and `.env` files avoid the JSON file but remain readable from the process environment and from plaintext dotfiles — the exact locations credential-stealing malware sweeps first.

### Encrypted Secure Store

`atlas config` stores configuration in `~/.atlas/config.enc`, encrypted with AES-256-GCM (12-byte IV, 16-byte auth tag, layout `[iv][tag][ciphertext]`). The 256-bit store key is held in the OS keyring — macOS Keychain (`security`) or libsecret (`secret-tool`) on Linux — so a disk or dotfile sweep yields only ciphertext, and tampering with the store file fails authentication at load time rather than silently feeding Atlas modified settings.

Threat model: the store defends against offline file exfiltration and environment-variable grabbing by unprivileged malware. It does **not** defend against malware running interactively as the logged-in user (which can invoke the keyring the same way Atlas does), nor against an attacker with root. On systems without a keyring the store key falls back to `~/.atlas/config.key` (mode `0600`, with a warning) — equivalent to file-permission security, still one step above plaintext env files because the config values themselves are never on disk in the clear.
