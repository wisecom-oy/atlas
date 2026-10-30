---
description: 'How Atlas protects backups: the passphrase-driven key hierarchy, per-object integrity checks before restore, what is and is not protected, and the limits.'
---

# Security model

Atlas encrypts each tenant's backup data with a key that only the tenant's passphrase can unlock, and it checks every object's integrity before restoring it. This page explains the design, what is and is not protected, and the limits you need to plan around.

## Key hierarchy

```
passphrase
  → scrypt (tenant salt, N=65536, r=8, p=1) → KEK (256-bit)
  → KEK wraps the DEK (AES-256-GCM, header as AAD)
  → DEK encrypts every object and manifest for the tenant
```

- **DEK (data encryption key).** A random 256-bit key generated once per tenant. It is stored wrapped at `_meta/dek.enc` in the tenant bucket and exists in plaintext only in memory during a run.
- **KEK (key encryption key).** Derived from the passphrase. It only wraps and unwraps the DEK.

The split keeps the passphrase out of the data path. The DEK is random, so its strength does not depend on the passphrase, and changing the passphrase rewrites one small object rather than every backup. The wrapped blob is self-describing: it carries the KDF identifier, the scrypt parameters, and a 32-byte random salt. The header is authenticated as additional data, so tampering with the parameters fails on unwrap.

## KEK derivation: scrypt

Atlas uses scrypt, a memory-hard function that makes GPU and ASIC guessing expensive. Parameters for new DEK wraps:

| Parameter           | Value                  | Purpose                                                                  |
| ------------------- | ---------------------- | ------------------------------------------------------------------------ |
| N (cost)            | 65536                  | CPU and memory cost (2^16)                                               |
| r (block size)      | 8                      | Memory multiplier                                                        |
| p (parallelism)     | 1                      | Sequential derivation                                                    |
| Salt                | 32 random bytes        | Fresh on every wrap, including re-wraps. Combined with the tenant ID so the same passphrase yields different KEKs per tenant |
| Output              | 32 bytes               | AES-256 key                                                              |
| Minimum N on unwrap | 16384                  | Blobs with weaker parameters are rejected                                |

A re-wrap picks up the current parameters automatically. Until then, a tenant keeps the parameters it was created with.

Derivation runs on Node's libuv threadpool, so it does not block the host process's event loop. Each derivation uses roughly 64 MiB and takes about 90 to 110 ms. With Node's default pool of 4 threads, peak scrypt memory is about 256 MiB. Raising `UV_THREADPOOL_SIZE` raises that ceiling at the cost of more memory. The derived key is zeroed as soon as the wrap or unwrap completes.

The wrapped DEK sits next to the data with its KDF parameters in plaintext. Anyone with read access to the bucket can run an offline guessing attack, so the passphrase's length and entropy are the whole defence. Atlas refuses to wrap a key under a passphrase shorter than **14 UTF-8 bytes**. This applies to first-time key creation, `atlas keys rewrap`, the SDK `encryptionPassphrase` option, and `atlas config set encryption.passphrase`. Keys already wrapped under a shorter passphrase still open, with a warning on every run.

Byte length is a floor, not an entropy guarantee. For production, use at least five random words or 20 random characters.

::: danger A lost passphrase cannot be recovered
There is no recovery path. Without the passphrase the DEK cannot be unwrapped, and every backup for that tenant is permanently unreadable. Changing `ATLAS_ENCRYPTION_PASSPHRASE` without re-wrapping the stored key causes authentication failures on the next run. Run `atlas keys rewrap --new-passphrase` first, and change the configured value only after it succeeds. Store the passphrase in a password manager or a secrets vault, with a second copy kept offline.
:::

The SDK's `validate()` method checks S3 `HeadBucket` access on the tenant bucket, unwraps the existing `_meta/dek.enc` with the configured passphrase when one exists, and acquires a Graph token. A wrong passphrase fails with `WrongPassphraseError`. A tenant with no key yet passes that step. It writes nothing and does not confirm that writes are permitted or that Graph consent is in place.

## Rewrapping the passphrase

```bash
atlas keys rewrap --new-passphrase
```

`atlas keys rewrap` derives a new KEK and rewrites `_meta/dek.enc` under it. The DEK inside is unchanged, so no data objects are re-encrypted and every snapshot stays readable. It is a single object write regardless of tenant size.

The command rotates the wrapper, not the key. It defeats a leaked passphrase, because whoever holds the old one can no longer open the current wrapper. It does not help against someone who already has the DEK or plaintext decrypted with it. For that case, see [Rotating the data key](#rotating-the-data-key).

The order of operations protects the tenant. Atlas unwraps the stored key with the current passphrase before writing anything. After the write, it reads the blob back, unwraps it with the new passphrase, and compares the result with the key it wrote. If verification fails, it restores the previous wrapper and confirms that it still opens before reporting the error. Keep both passphrases until a read succeeds with the new one.

::: warning Revocation is not immediate on a versioned bucket
Atlas enables bucket versioning and expires noncurrent versions after 30 days. A re-wrap does not remove the previous `_meta/dek.enc` version. Until that version expires, anyone holding the old passphrase and `s3:GetObjectVersion` can still unwrap the DEK.

Treat a re-wrap as complete only after the old version is gone. Delete the noncurrent versions of `_meta/dek.enc` explicitly where policy and Object Lock allow it. Otherwise, revoke the leaked principal's `s3:GetObjectVersion`, which closes the window immediately.
:::

## Rotating the data key

Rotating the DEK means starting a new bucket, because Atlas names the bucket `atlas-<tenant-id>` and a bucket holds one DEK.

```bash
# 1. Point Atlas at storage where atlas-<tenant-id> does not exist yet
atlas config set s3.endpoint https://new-s3.example.com
atlas config set s3.access-key <new-access-key>
pbpaste | atlas config set s3.secret-key -
pbpaste | atlas config set encryption.passphrase -

# 2. Back up every mailbox, drive, and site again; the first run generates the new DEK
atlas outlook backup -m user@company.com
```

The new bucket must sit on a different endpoint or S3 account. The first backup generates a random DEK and wraps it under the new passphrase. It has no delta cursors to start from, so it is a full enumeration with the time and throttling cost of a first backup.

Earlier snapshots stay in the old bucket under the old DEK. Restore them with the old endpoint, credentials, and passphrase. Nothing is migrated or re-encrypted. Once the old snapshots are no longer needed, remove them with `atlas delete --purge` against the old storage. Objects under Object Lock retention cannot be deleted before their retain-until date, and the purge reports them as retained rather than failed.

Replication cannot rotate the key. It copies ciphertext unchanged and refuses a target whose DEK differs from the primary's ([DEK mismatch protection](#dek-mismatch-protection)).

Rotation limits exposure to data written after the rotation. It targets a DEK that has left the process, through memory, a core dump, or a compromised host. Data already written under the old key remains readable with that key for as long as the old bucket exists, including noncurrent versions and Object Lock retained objects. Atlas has no in-place re-key, because that would mean rewriting a bucket while objects are split between two keys.

## Content encryption

Every object is encrypted with **AES-256-GCM**. The GCM tag gives confidentiality and authenticity: a single flipped bit fails decryption.

```
[ATLS][version][12-byte IV][16-byte GCM tag][ciphertext]
```

Each object gets a fresh random 12-byte IV. Reusing an IV under the same key would break GCM, so Atlas never reuses one. Random IVs carry a birthday bound: NIST SP 800-38D caps random-IV GCM at 2^32 invocations per key, where an IV collision has a probability of about 2^-33. One DEK covers a whole tenant, and a multipart upload uses one IV for the whole object. The budget is therefore about 4.3 billion objects per tenant bucket. Content is addressed by checksum, so re-backing up unchanged bytes does not consume the budget.

### What a ciphertext is bound to

Because one DEK encrypts the whole tenant, the GCM tag alone proves only that bytes came from that tenant's key. Atlas binds the header and the object's scope as associated data, so a ciphertext decrypts only where it was written. The scope is the key's directory: `onedrive/data/{owner_id}/`, `manifests/{owner_id}/`, or `_meta/replication/{owner}/{snapshot}/`.

| Attack                                                        | Result                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| Move an object over another owner's or purpose's key          | Decryption fails: the scope no longer matches                |
| Strip or lower the version header                             | Decryption fails: the header is authenticated                |
| Move an object within its own directory                       | Not prevented. The manifest checksum comparison detects it   |
| Replay an older ciphertext of the same object                 | Not prevented. Object Lock and versioning handle this        |

Objects written before the header existed have no magic bytes and decrypt without associated data. Existing backups stay readable with no migration step. Those objects have no scope to check, so they can be moved and still decrypt. An object gains the binding when its plaintext changes or when it is deleted and stored again. Restore still checks the manifest checksum before writing anything.

## What is encrypted at rest

| Data                                       | Encrypted | Notes                                                                                 |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------- |
| Email messages                             | Yes       | RFC 5322 MIME, or legacy Graph JSON, under `data/{owner_id}/{content_name}`           |
| Attachments                                | Yes       | Legacy JSON entries only, under `attachments/{owner_id}/{content_name}`. MIME embeds them |
| Manifests                                  | Yes       | Subjects, senders, folder names, delta URLs, checksums                                |
| OneDrive file blobs                        | Yes       | `onedrive/data/{owner_id}/{content_name}`                                             |
| OneDrive manifests, indexes, and delta state | Yes     | `onedrive/manifests`, `onedrive/index`, `onedrive/_meta`                              |
| Wrapped DEK                                | Yes       | `_meta/dek.enc`, encrypted with the KEK                                               |
| S3 object metadata                         | **No**    | `x-message-id` on mailbox objects is visible to anyone with S3 read access            |

Apart from `x-message-id`, objects store no item IDs, version IDs, or plaintext checksums in unencrypted metadata. Those live inside encrypted manifests and version indexes. Mailbox objects written before keyed naming also carry `x-plaintext-sha256`; see below.

### What object names reveal

Each content object is named by an HMAC-SHA256 over its plaintext, keyed with a naming key that Atlas derives from the tenant data key with HKDF-SHA256 (info `atlas/object-name/v1`). The name (`{content_name}`) is 64 hex characters. Anyone with read access to the bucket can see names and sizes, and can tell when two objects hold identical content, because identical content gives identical names. They cannot tell what the content is: without the data key they cannot compute a name from a known file, so a dictionary of likely documents matches nothing in the bucket.

Objects written before keyed naming are named by the plain SHA-256 of their plaintext, and mailbox objects from that time also carry an `x-plaintext-sha256` metadata header. A reader holding a copy of a file can compute that name and confirm the owner stored it. Those objects stay readable through their manifest entries, and Atlas does not rename or delete them. See [Migrating to v6](./migration/v6.md#all-workloads-keyed-content-object-names) for how to remove them.

## User identity in storage paths

Storage prefixes use the Entra object ID, not the SMTP address. For OneDrive, `atlas onedrive` resolves a user principal name or email passed to `--owner` to an object ID before computing the prefix. Passing a UUID skips resolution and must match the user's directory object ID. Mailbox backups namespace `data/`, `attachments/`, and `manifests/` by the owner's object ID too. The SMTP address is recorded only as display metadata on snapshots.

Bucket listings therefore do not reveal which email account owns a subtree unless someone can correlate Graph IDs. Address-keyed objects written by v5 are not renamed or aliased. They stay under their old prefixes until something deletes them, and Object Lock expiry only makes them deletable. See [Migrating to v6](/migration/v6).

## Replication security

Replication uses a shared encryption model. All targets share the master passphrase and the tenant DEK, and ciphertext is copied byte for byte with no decryption or re-encryption. The wrapped DEK is copied to each target on first replication.

This has two consequences:

- **One passphrase protects every copy.** Compromising it exposes data on every target.
- **Each target needs separate S3 credentials.** Use an independent principal per endpoint, such as a dedicated MinIO user or a scoped IAM role. A compromised target credential exposes only that target's ciphertext, and it cannot reach other targets.

Replication status sidecars under `_meta/replication/` are encrypted with the DEK, so target endpoints, checksums, and errors are not exposed at rest.

Atlas closes each target's context when its copy ends, on success or failure, and zeroes the passphrase buffer.

A marker file, `_meta/replica.marker`, is written to each target on first replication. If `atlas outlook backup` runs against a replica, Atlas logs a warning, which guards the primary-is-truth rule.

### DEK mismatch protection

Before each replication or rehydration, Atlas checks that the source and target share a DEK. If the primary was purged and re-initialized with a new DEK, replication to a target that still holds the old DEK is refused with an explicit error. Without this check, objects encrypted under two keys would coexist on one target, and the older ones would become permanently unreadable.

The check runs once per target per run, before the first snapshot is copied. It unwraps both DEKs, which costs two scrypt derivations. A target that fails the check receives no writes.

## Integrity validation

Atlas checks integrity at three independent layers:

| Layer         | Mechanism                           | What it catches                                          | When                              |
| ------------- | ----------------------------------- | -------------------------------------------------------- | --------------------------------- |
| **Plaintext** | SHA-256 in the manifest             | Corruption before encryption, application bugs           | Backup, verify, save              |
| **Transport** | `Content-MD5` on every S3 PUT       | Network corruption in flight                             | Every upload; S3 rejects mismatch |
| **At rest**   | AES-256-GCM authentication tag      | Tampering or corruption in storage                       | Every decrypt                     |

`atlas outlook verify` downloads each encrypted object, decrypts it, hashes the plaintext, and compares the result with the manifest checksum using a constant-time comparison (`timingSafeEqual`). For MIME entries this covers attachments, because they are part of the hashed message. Legacy JSON attachments are separate objects and are protected only by GCM during decrypt. They are not hashed against the manifest.

### What the GCM tag does not prove

A valid tag proves the bytes were produced under the tenant DEK. It does not prove they belong at that key, which is why the scope binding above exists. Restore therefore compares the manifest checksum before anything acts on the bytes:

| Path                       | Checked before                                                |
| -------------------------- | ------------------------------------------------------------- |
| Outlook message restore    | `POST /messages`, for MIME and legacy JSON entries            |
| Outlook attachment restore | Each attachment upload                                        |
| Drive file restore         | The upload, buffered or streamed                              |
| Snapshot manifests         | Atlas rebuilds the key from the manifest's own `owner_id` or `site_id` and `snapshot_id`, and compares it to the key it read |

An entry with no recorded checksum is refused rather than restored unverified. A manifest planted under another snapshot's key is reported as corrupt, not skipped. Silently skipping it would make the snapshot look as if it was never taken.

Two limits remain. Neither check stops replay of an older valid ciphertext for the same object, which Object Lock and versioning handle. A checksum recorded wrongly at backup time also goes undetected.

### Authentication failures are reported everywhere

A GCM failure must never look like a successful empty result. Each object type reports it as a failure:

| Object                  | Reported as                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| Outlook attachment      | An error on the restore result, counted in `attachment_error_count` |
| Drive file in an export | An error and an integrity failure                                 |
| Snapshot manifest       | A raised `StorageError`. Only a genuinely absent object reads as absent |

Verification counts an entry as soon as it claims a stored blob. An entry that names a blob without a checksum is a verification failure. Tombstones are the only entries without a blob, so they are not counted.

`--skip-integrity-check` disables the comparison for export. Use it only when recovering data matters more than proving it.

### Nothing is released before it authenticates

Restoring a large file streams plaintext into a Graph upload session as it decrypts. Bytes therefore leave Atlas before the tag and SHA-256 can be checked. The item is safe because the session is committed only by the chunk carrying the last byte, and Atlas holds that chunk until the decrypt stream ends without error. A failed tag or checksum abandons the session with `DELETE`, and no file is created.

Atlas also refuses any chunk that would reach the declared end while the source still has data. An object longer than its recorded size would otherwise commit early. The file fails and the recorded and stored sizes are reported as disagreeing.

The rule to preserve: an unverified byte may travel, but nothing may make it visible. A destination that publishes data as it arrives, such as a filesystem path or a stream handed to a caller, must use the buffered path with up-front verification.

## Backup fidelity

Integrity checks prove that archived bytes match what Atlas stored. Fidelity asks which bytes Atlas stored in the first place, which determines whether an archived message still has evidentiary value after the mailbox is gone.

| Artifact                                                               | Fidelity                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Archived object, and the `.eml` that `atlas outlook save` writes for a MIME entry | **Byte-exact**. The RFC 5322 message as Exchange received it       |
| `.eml` for a legacy JSON entry                                         | **Reconstructed** from the stored JSON at export time                             |
| Message recreated by `atlas outlook restore`                           | **Reconstructed** from the archived MIME. The original `Received` chain is not carried over |
| Snapshots taken before MIME storage                                    | **Reconstructed** from Graph's JSON projection                                    |

### The archived object is the original message

Each new or changed message is fetched as RFC 5322 MIME with `GET /users/{id}/messages/{id}/$value`, and those bytes are stored as the canonical object. Earlier versions stored about 24 selected Graph fields and rebuilt an `.eml` at export time. A rebuilt message is plausible, but it lacks the headers an investigation depends on.

Stored MIME keeps the following:

| Recovered content                                           | What it answers                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Received:` chain                                           | Chain of custody: which servers handled the message, in what order                                  |
| `Authentication-Results`, `DKIM-Signature`                  | Whether the message is authentic. DKIM verifies only against the original bytes                     |
| `In-Reply-To`, `References`                                 | Threading in any mail client                                                                        |
| Multipart structure and transfer encodings                  | Byte-level attestation                                                                              |
| S/MIME signed and encrypted payloads                        | Signature verification and decryption                                                               |
| Custom `X-` and mailing-list headers                        | Gateway, DLP, and list-server annotations                                                           |

There is no `--fidelity` flag. MIME is the only format for new snapshots, so the weaker format cannot be selected by accident.

Attachments are stored inside the MIME message. Two effects follow. Attachment content is no longer deduplicated across messages, so a file sent to a list is stored once per message. Base64 inside MIME adds about one third more bytes.

If Graph cannot return MIME for an item, that single message is stored as legacy JSON instead of being skipped. Each manifest entry records its format. Entries with `payload_format: "mime"` hold original bytes, and entries without the field hold legacy JSON. `save`, `read`, `restore`, and `verify` handle both formats in one snapshot.

On the JSON path, attachments are separate objects, and all three Graph types are captured:

| Graph type            | What Atlas stores                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `fileAttachment`      | The file bytes, inline or fetched from `/$value`                                                   |
| `itemAttachment`      | The item's bytes from `/$value`: MIME for a message, iCal for an invite, vCard for a contact       |
| `referenceAttachment` | The link as a one-line `text/uri-list`. Graph returns `405` for a fetch, so there are no bytes     |

The content type comes from the bytes that arrive, not the attachment's name. An invite mislabeled as mail would open as broken mail. A reference attachment points at a file in OneDrive or SharePoint, which those workloads back up separately.

::: warning Attachment types dropped before this version
Earlier versions kept only `fileAttachment` and discarded the others silently, while still setting `has_attachments`. Snapshots from that period can claim attachments whose content was never captured. This affected the JSON path, which is the only path that existed before MIME storage, so treat those snapshots with suspicion. Unrecognized attachment types are now recorded with their metadata and a warning.
:::

### Restore reconstructs messages

Atlas does not import archived MIME back into Exchange. Graph's MIME import always marks the created message as a draft (`isDraft: true`), and no header or property clears that flag. A restore would leave thousands of drafts.

`atlas outlook restore` parses the MIME and recreates each message through Graph's JSON create path. The result is normal mail with its original timestamps. The restored copy does not carry the original `Received` chain.

| Restored as                                        | Taken from the MIME                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Subject, body, addresses, `internetMessageId`      | The matching headers and parts. Bcc survives on Sent Items copies              |
| Received and sent times                            | `Date`                                                                         |
| Importance                                         | `Importance`, or `X-Priority` (1 and 2 high, 3 normal, 4 and 5 low)            |
| Categories                                         | `Keywords`, where Exchange wrote them                                          |
| Threading                                          | `In-Reply-To`, `References`, `Thread-Index`, set as MAPI properties            |
| Reactions                                          | Not in the MIME. Captured separately at backup and written back as the same MAPI properties |
| Attachments, inline or regular                     | The body parts. Inline means `Content-Disposition: inline`, or no disposition with a matching `Content-ID` |

Graph's create call accepts only `x-` headers, so threading uses MAPI properties. The follow-up flag is not restored. Read state is set to read, so a restore does not leave thousands of unread items.

Legacy JSON entries restore the fields Graph returned at backup time. They have no threading, because those requests never asked for `internetMessageHeaders` or `conversationIndex`, so Outlook groups them by subject. Reactions are restored for JSON entries too.

Snapshots taken before reaction capture restore without reactions. Exchange keeps client-written reaction properties byte for byte. The reaction summary names the reacting users and their addresses as they were at backup time, and it is stored in the encrypted manifest alongside the subject and sender.

When you need the original bytes for a legal hold, forensic review, or DKIM check, use `atlas outlook save`. It never touches the live mailbox.

### Content Microsoft 365 will not release

Some drive content cannot be backed up because the service blocks the download. Malware-quarantined files are the main case.

Atlas reads the Graph `malware` facet during delta enumeration and skips quarantined items without attempting the download. Each skipped item is recorded in the drive's failed-item ledger and reported on every run. The run is marked `UNHEALTHY` and exits non-zero, so you can always see which files are missing and why.

- **The quarantined file is not in the backup.** A restore cannot produce a file the service never released. Clean or release the file in Microsoft 365 first if its content matters.
- **Retrying does not help.** A quarantine is a policy state, and attempting the download makes Graph abort the transfer instead of returning a clean 403. Each run would repeat the attempt on one file.

::: warning Sensitivity labels are not captured
Atlas does not record Microsoft Purview sensitivity labels or IRM protection state on drive items. Labeled files that Graph serves are backed up as ciphertext, but the label is not stored, so a restored copy loses its classification. Treat restored content as unclassified until it is relabeled.
:::

## Erasure

An erasure request answered incorrectly is a compliance failure that looks like success, so Atlas treats deletion as a security control.

### Versions are part of the data

Every delete removes each object and its noncurrent versions, addressed by version ID. On a versioned bucket, a `DeleteObject` without a version ID writes a delete marker. The object disappears from listings, but its plaintext remains reachable through `GetObject?versionId=`. Atlas sweeps delete markers too, but does not count them as erased data, because removing one uncovers versions instead of destroying them.

### A tenant purge sweeps the bucket

`purge_tenant` enumerates the whole bucket instead of a fixed list of prefixes. A prefix list falls behind when a workload is added, and it then erases less than reported. The encrypted DEK is deleted last, and only after the sweep reports nothing remaining. Deleting the key first would leave ciphertext that can neither be restored nor reported as erased.

### Retained or failed

A refused delete counts as **retained** only when the backend names Object Lock as the reason. AWS returns `AccessDenied: Access Denied because object protected by object lock`, and MinIO returns `InvalidRequest: Object is WORM protected and cannot be overwritten`. Retained objects become deletable when retention expires.

::: danger Retained objects remain until retention expires
Object Lock retention is enforced by the storage backend, and Atlas cannot shorten it. A purge reports locked objects as retained, and the data remains readable with the tenant key until their retain-until date. Plan erasure timelines around the longest retention period in use.
:::

Everything else is a **failure**, including a missing `s3:DeleteObjectVersion` permission, an unreachable endpoint, or a bucket policy. An IAM gap reported as "retained" would suggest an erasure is scheduled when nothing is. Atlas classifies uncertain cases as failures, because a false alarm costs an investigation and a false all-clear costs the erasure.

### Retention is stamped per object

Every workload locks only the objects a run with `--retention-days` writes, by sending `ObjectLockMode` and `ObjectLockRetainUntilDate` on each `PutObject`, `CopyObject`, and `CreateMultipartUpload`. Atlas never sets a bucket default retention. A default would lock every write in the bucket, including runs that did not ask for immutability and the staging copy of every large file that a drive backup deletes after assembling it, so the erasure exposure would exceed what any operator requested.

Before 6.1.0, OneDrive and SharePoint backups with `--retention-days` set that bucket default. A bucket that was backed up by those versions may still carry one, and it keeps locking objects that should not be locked. `atlas storage-check` reports a default when it finds one. Remove it as described in [Removing a bucket default retention](/self-hosting/storage#removing-a-bucket-default-retention); objects already stamped keep their retain-until date either way.

Per-object stamping also bounds what a compromised S3 credential can do. A credential with write access can add new locked objects, which costs storage until they expire, but it cannot shorten the lock on anything already written unless it also holds `s3:BypassGovernanceRetention` against a `GOVERNANCE` lock. A `COMPLIANCE` lock cannot be shortened by any principal, including the account owner.

## Recoverable Items and legal hold

`atlas outlook backup --include-recoverable-items` reads the Exchange Recoverable Items subtree (the "dumpster"). It is off by default, and enabling it changes what a snapshot means legally as well as what it costs.

A message that arrives and is hard-deleted between two backups never appears in a delta page. Its only copy is in `Deletions` or `Purges`, and it is lost for good once Exchange's retention window expires. This option is the only way a backup can cover deletions that happen between runs.

The option stores `Deletions`, `Purges`, `DiscoveryHolds`, and `SubstrateHolds` as MIME, with the same encryption and layout as ordinary mail. `Versions`, `Calendar Logging`, and `Audits` are not captured, and the run reports each skipped folder by name. `Purges`, `DiscoveryHolds`, and `SubstrateHolds` contain content only because a litigation hold, In-Place Hold, or retention policy kept it.

::: warning Hold-retained mail becomes a second copy
A copy of held mail in your storage lives outside the Microsoft 365 retention machinery and outside whatever hold released it there.

- **The copy outlives the hold.** Releasing a litigation hold does not touch the Atlas snapshot. Delete the copy with `atlas outlook delete` when your retention schedule requires it.
- **The copy is discoverable.** Content in your bucket can be compelled from your bucket, even after it is gone from the tenant.
- **Object Lock makes it undeletable on purpose.** A snapshot written with `--retention-days` cannot be deleted before retention expires, including by you. Combining Object Lock with purged mail is a deliberate decision.
:::

Entries are marked in the manifest, so the snapshot itself shows which content came from Recoverable Items. Restore excludes marked entries unless `--include-recoverable-items` is passed to `restore` or `save`. Graph has no path back into Recoverable Items, so restored items appear as normal visible mail. A restored purged message becomes live again.

The subtree is read with the same `Mail.Read` permission as ordinary mail, so the option grants no new access.

## In-Place Archive is out of scope

Atlas backs up the primary mailbox. An In-Place Archive (also called Online Archive) is a separate store, and Atlas does not back it up.

Graph does not expose archive mailboxes. Microsoft's [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) states that the API does not support accessing in-place archive mailboxes on Exchange Online or Exchange Server. Every Atlas sync path is built on that API, so no folder ID or query parameter reaches the archive.

The **`Archive` well-known folder**, used by Outlook's Archive button, is in the primary mailbox and is backed up normally.

::: warning Retention policies can move mail out of scope
A retention or MRM policy that moves mail to the archive after a set age removes that mail from backup scope. It removes the oldest mail first, which is often the most relevant for compliance. When a policy moves a backed-up message, the folder delta reports it as removed. If you prune old snapshots, that message can age out while its only copy sits in an archive Atlas cannot read.
:::

`atlas outlook mailboxes` warns about affected mailboxes and shows a `Has Archive` column:

```
[!] 2 mailbox(es) have an In-Place Archive (Online Archive), which Graph cannot read
    and Atlas does not back up:
      alice@contoso.com
      bob@contoso.com
```

The column comes from the [mailbox usage report](https://learn.microsoft.com/en-us/graph/api/reportroot-getmailboxusagedetail?view=graph-rest-1.0), which requires the optional `Reports.Read.All` permission. Without it, the column shows `--`, meaning unknown. Atlas does not report archive coverage it cannot confirm.

To protect archive content, move it back to the primary mailbox or adjust the retention policy first. Microsoft's [mailbox import and export APIs](https://learn.microsoft.com/en-us/graph/mailbox-import-export-concept-overview) do cover archives, but they use a job-based model with separate `MailboxImportExport.*` permissions, so they do not replace per-folder delta sync.

## What a drive restore rebuilds, and what it cannot

A restored file contains the original bytes, verified against the manifest checksum. Other document properties differ:

| Property                                 | Captured | Restored                                       |
| ---------------------------------------- | -------- | ---------------------------------------------- |
| File content                             | Yes      | Yes, byte for byte                             |
| Original created and modified times      | Yes      | Yes, through the `fileSystemInfo` facet        |
| `createdBy` and `lastModifiedBy`         | Yes      | No. Kept for audit only                        |
| Version authors                          | Yes      | No. Kept for audit only                        |
| Sharing permissions and links            | No       | No                                             |

Graph exposes two timestamp pairs. The `driveItem` values are set by the service, so a restored file always shows the restore time there. The `fileSystemInfo` facet holds client-reported values and is writable on upload, so Atlas restores through it. Each manifest entry records both pairs. A resumable upload carries the timestamps with the upload. A small `PUT /content` carries only bytes, so Atlas follows it with a best-effort `PATCH`. If that patch fails, the file keeps restore-time timestamps and the run logs the failure.

Authors are recorded on every manifest entry and version row, so the original author is always available from the backup. Graph attributes an upload to the identity that performed it, and rewriting authorship needs separate migration APIs and permissions. A restored file is authored by the Atlas application identity.

::: warning Sharing permissions are not captured
A restore does not rebuild per-item sharing or links. A restored library inherits the destination's defaults, which are usually broader than the original curated sharing. **Treat a restored library as unshared and reapply access before returning it to users.**
:::

Capturing permissions is expensive. Each permission operation costs 5 resource units from the tenant-wide SharePoint and OneDrive pool (see [Graph rate limits](./operations/graph-rate-limits.md#resource-unit-costs)). A 100,000-file drive would need 500,000 RU. At 1,250 RU per minute, that is about 6.7 hours of the tenant's quota, which would slow every other app. Graph's `shared` facet can flag only the items that are shared, which would reduce the cost, but restore-side reapplication is not implemented.

## Storage request events

An SDK host can pass `onStorageRequest` to receive one event per S3 request. See [Storage request events](/reference/storage-request-events). Hosts often export these to metrics systems that are less protected than the backup bucket, so the event carries only values that identify nothing:

| Contained                                                                                  | Never contained                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| S3 command and SDK method names                                                            | Object keys, listing prefixes, upload IDs          |
| `workload` and `keyClass`, from an allowlist over the leading key segments                 | Bucket names, which contain the tenant ID          |
| `target`: `primary` or the host-chosen replication `targetId`                              | Endpoint hostnames, URLs, credentials, signatures  |
| Timings, attempt count, retry delay, payload byte count, HTTP status, S3 error code        | Tenant, mailbox, owner, or site IDs, content hashes |

Keys are never classified by pattern-matching their contents. A known leading segment such as `data` or `manifests` maps to a class, and anything else becomes `other`. An unexpected key layout therefore cannot leak an identifier into a label.

The observer runs inside the Atlas process. Atlas catches thrown errors and rejected promises, so a faulty observer cannot fail a backup. An observer that blocks the event loop or keeps event objects can still affect the process. Byte counts are ciphertext sizes, so over many requests they reveal the size distribution of stored objects. The backend operator can already see that distribution, but treat exported metrics accordingly.

## Transport to storage

```bash
ATLAS_S3_ENDPOINT="https://s3.example.com"   # any endpoint not on this machine
ATLAS_S3_ENDPOINT="http://localhost:9000"    # local MinIO only
```

Atlas accepts plain `http://` endpoints because local MinIO needs them. Content stays protected over HTTP, since every object is AES-256-GCM ciphertext and SigV4 signs requests without sending the secret key. Traffic around the content is visible to anyone on the network path:

| Exposed over plain HTTP   | Why it matters                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Object keys               | Keys carry Entra object IDs and content hashes                                             |
| Access key ID             | Identifies the account. The secret key is not sent                                         |
| Request pattern           | Which owners are backed up, when, and how much data                                        |
| Unauthenticated responses | A forged `200` to `PutObject` makes a backup report success for an object never stored. Only a later `verify` finds it |

Atlas warns once per run for each plain `http://` endpoint whose host is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`). This covers the primary and replication targets. It does not refuse the endpoint, because a self-hosted setup may terminate TLS on a trusted network. Use `https://` for any endpoint on another machine.

The bundled `docker/docker-compose.yml` publishes MinIO on `127.0.0.1` only and has no fallback root password, so it does not start until one is set. Root on the bucket can bypass governance-mode Object Lock and delete every backup that is not under compliance retention, which makes the root password and the bind address the two controls that decide who can reach the archive. Widening the bind address is an explicit `MINIO_BIND_ADDRESS` setting. See [Network exposure](/self-hosting/storage#network-exposure).

Microsoft Graph is stricter. Atlas refuses to call Graph at all when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate validation. Storage has no equivalent check.

## S3 permissions by command class

Atlas separates read and write storage access, so an operator who only browses never needs write credentials:

| Command class                                                                                                                | Required S3 actions                                                                                                       | Provisioning |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Read-only: `outlook list`, `outlook read`, `outlook status`, `outlook verify`, `onedrive list`, `sharepoint list`, `stats`, `list-users` | `s3:GetObject`, `s3:ListBucket`                                                                                         | None         |
| Storage usage: `stats storage`                                                                                               | Read-only actions plus `s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`, `s3:ListMultipartUploadParts`           | None         |
| Write: `backup`, `restore`, `save`, `replicate`, `rehydrate`, `delete`                                                       | All of the above plus `s3:CreateBucket`, `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, and lifecycle or lock configuration | Yes          |

Read-only commands never create the bucket or write `_meta/dek.enc`, so a mistyped tenant ID fails with `No backups found for tenant <id>` instead of leaving behind a new bucket.

Give monitoring and audit principals the read-only row only. If a principal holds `s3:CreateBucket`, that permission dates from Atlas versions before 2.1.0-beta and can be revoked.

## Configuration file security

`atlas.config.json` can contain `encryption_passphrase` and `client_secret` in plaintext. On Unix, Atlas checks the file mode at load time and logs a warning when any group or world bits (`0o077`) are set:

```
WARN Config file /home/user/atlas.config.json has overly permissive permissions (mode 0644). Recommended: chmod 600 /home/user/atlas.config.json
```

The check is advisory so existing deployments do not break. It is skipped on Windows.

::: danger Restrict the config file to its owner
Run `chmod 600` on any config file that contains a passphrase or client secret. Anyone who can read the file can read the passphrase, and with it the DEK in the bucket.
:::

Environment variables (`ATLAS_*`) and `.env` files avoid the JSON file, but they are still readable from the process environment and from plaintext dotfiles, which malware checks first.

## Encrypted secure store

`atlas config` stores its settings in `~/.atlas/config.enc`, encrypted with AES-256-GCM in the layout `[iv][tag][ciphertext]`. The store is created with directory mode `0700` and file mode `0600`. Its 256-bit key is random and kept in the OS keyring under service `atlas-cli`, account `config-key`:

- **macOS:** Keychain, through the `security` CLI.
- **Linux:** libsecret, through `secret-tool`, when the binary is installed.
- **Other systems, or no keyring:** `~/.atlas/config.key`, with mode `0600`, and a warning.

A disk sweep finds only ciphertext. A modified store file fails authentication at load time and is not used.

Threat model: the store defends against offline exfiltration of the file and against unprivileged malware that reads environment variables. It does not defend against malware running as the logged-in user, which can call the keyring the same way Atlas does, or against an attacker with root. On systems without a keyring, the fallback key file is protected only by file permissions. Config values are still never stored in plaintext.

See also: [Configuration](/configuration), [Migrating to v6](/migration/v6), [CLI reference](/reference/cli).
