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

| Data                                       | Encrypted | Notes                                                                                                                  |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Email messages                             | Yes       | RFC 5322 MIME (or legacy Graph JSON) under `data/{mailbox}/{sha256}`                                                   |
| Attachments                                | Yes       | Legacy JSON entries only, under `attachments/{mailbox}/{sha256}`; MIME entries embed attachments in the message object |
| Manifests                                  | Yes       | Contains subjects, folder names, delta URLs, checksums                                                                 |
| OneDrive file blobs                        | Yes       | Keys under `onedrive/data/{owner_id}/{sha256}`                                                                         |
| OneDrive manifests / indexes / delta state | Yes       | Under `onedrive/manifests`, `onedrive/index`, `onedrive/_meta`                                                         |
| Wrapped DEK                                | Yes       | `_meta/dek.enc` is encrypted with the KEK                                                                              |
| S3 object metadata                         | **No**    | `x-message-id` on mailbox objects is visible to anyone with S3 read access                                             |

Mailbox objects carry `x-message-id` in S3 metadata for operational diagnostics. OneDrive objects no longer store file identifiers, version identifiers, or plaintext checksums in unencrypted metadata -- all such metadata is stored inside encrypted manifests and version indexes.

Manifests deserve special attention: they contain email subjects, folder display names, and Microsoft Graph delta URLs. All of this metadata is encrypted with the same DEK, so subject lines and folder names are never exposed at rest in the S3 bucket.

### OneDrive blobs and sidecars

OneDrive file ciphertext uses keys such as `onedrive/data/{owner_id}/{sha256}` (see [OneDrive Backup](./onedrive-backup.md)). The `{owner_id}` segment is the **Entra object ID**, not an SMTP address, so bucket listings do not reveal which email account owns a subtree unless an attacker can correlate Graph IDs.

OneDrive data blobs carry no unencrypted S3 metadata. File identifiers, version identifiers, and plaintext checksums are stored exclusively inside encrypted manifests and version indexes, preventing known-plaintext fingerprinting via S3 `HeadObject`/`ListObjects` access.

## User identity in storage paths

**OneDrive (CLI `atlas onedrive`)** always resolves interactive owner inputs that look like email/UPN to an Entra object ID (`GET /users/{email}` with `id` selected) before computing S3 prefixes. Passing a bare UUID to `--owner` skips resolution and must match the user's directory object ID.

**Mailbox backup** still namespaces `data/`, `attachments/`, and `manifests/` by the mailbox identifier wired into the sync job (today this is commonly the primary SMTP address from discovery). That is a separate layout from OneDrive's object-ID paths. Operators who rely on privacy through opaque IDs should prefer object IDs for new automation and be aware older mailbox prefixes may still contain human-readable addresses.

There is **no built-in S3 object rename** between email-keyed and ID-keyed mailbox prefixes in the open-source CLI as shipped; migrating layout is an operational exercise (re-backup, copy, or custom tooling) if you need to align naming.

## Backup Fidelity

Integrity checks prove that the archived bytes are the bytes Atlas stored. Fidelity is the separate question of _which_ bytes Atlas stored in the first place, and it decides whether an archived message still carries evidentiary weight years after the mailbox is gone.

| Artifact                                                                | Fidelity                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archived object in S3, and the `.eml` files `atlas outlook save` writes | **Byte-exact.** The original RFC 5322 MIME as Exchange received it                                                                                                   |
| A message recreated in a mailbox by `atlas outlook restore`             | **Reconstructed.** Rebuilt from the archived MIME through Graph's JSON message-create path; the original `Received` chain is not reproduced inside the restored copy |
| Snapshots taken before this version                                     | **Reconstructed.** Graph's JSON field projection, with the `.eml` assembled at export time                                                                           |

### The archived object is the original message

Backup fetches every new or changed message as **RFC 5322 MIME** -- the on-the-wire form of an email, every header and body part exactly as the sending and relaying servers produced them -- with `GET /users/{id}/messages/{id}/$value`, and stores those bytes as the canonical encrypted object.

Earlier Atlas versions stored `JSON.stringify()` of roughly 24 selected Microsoft Graph fields and _reconstructed_ an `.eml` file at export time with the `mimetext` library. A reconstruction is a plausible email, not the original one: it carries the fields Atlas thought to select, re-encoded by a library that was never in the message's transit path. Everything an investigator would use to prove where a message came from was missing, because Graph's JSON projection never contained it.

Storing the original bytes recovers the following. Each row is a question an operator or auditor eventually has to answer:

| Recovered content                                                          | What it answers                                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `Received:` chain                                                      | Chain of custody: which servers handled the message, in what order, and when it passed each hop                                                                   |
| `Authentication-Results` with DKIM, SPF, and ARC results, `DKIM-Signature` | Whether the message was authentic or forged. DKIM is a cryptographic signature over selected headers and the body, so it verifies only against the original bytes |
| `In-Reply-To` and `References`                                             | Threading. Exported `.eml` files group into conversations in any mail client instead of arriving as unrelated messages                                            |
| Original multipart structure and transfer encodings                        | Byte-level attestation: part boundaries, `Content-Transfer-Encoding`, and part order are preserved rather than regenerated                                        |
| S/MIME signed and encrypted payloads                                       | Signature verification and decryption, both of which are only possible over the original bytes                                                                    |
| Custom `X-` headers and mailing-list headers                               | Gateway, DLP, and list-server annotations that no Graph field exposes                                                                                             |

There is deliberately no `--fidelity` flag. MIME is the only mode for new snapshots, so an operator cannot accidentally archive a year of mail in the weaker format.

### Attachments move inside the message object

MIME carries its attachments, so a MIME entry stores no separate objects under `attachments/{mailbox}/{sha256}` and its manifest entry lists no attachment records. Two consequences are worth stating plainly:

- **Attachment content is no longer deduplicated across messages within a mailbox.** A slide deck mailed to a distribution list is stored once per message that carries it, not once per distinct payload.
- **Base64 encoding inside MIME costs roughly one third more bytes** than the raw attachment, because base64 represents three bytes of binary as four bytes of text.

That is the price of byte-exact fidelity. An attachment that has been re-encoded or extracted is no longer the object the sender signed.

### When Graph cannot produce MIME

If Graph cannot return MIME for a particular item, Atlas stores that one message in the legacy JSON form rather than skipping it. A single unusual item never costs you the rest of the mailbox.

Each manifest entry records which format its object holds. Entries with `payload_format: "mime"` hold original bytes; entries with no `payload_format` field hold the legacy Graph JSON payload. Mixed snapshots are normal, and `save`, `read`, `restore`, and `verify` all handle both formats inside the same snapshot chain, so a fallback item needs no operator intervention.

On that path attachments are separate objects again, and all three Graph attachment types are captured:

| Graph type            | What Atlas stores                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `fileAttachment`      | The file bytes, inline when Graph includes them, otherwise fetched from `/$value`                         |
| `itemAttachment`      | The attached item's own bytes from `/$value`: MIME for a message, iCal for an invite, vCard for a contact |
| `referenceAttachment` | The link, as a one-line `text/uri-list`. There are no bytes to fetch, and Graph answers `405` if asked    |

An attached message therefore exports as a `message/rfc822` part that mail clients open as mail, an invite as `.ics`, and a contact as `.vcf`. The content type is decided by the bytes that arrive rather than by the attachment's name, because Graph does not say which kind of item is attached and an invite mislabelled as mail opens as broken mail.

A `referenceAttachment` points at a file in OneDrive or SharePoint. The link is part of the message and is preserved; the file itself belongs to those workloads and is covered by their own backups.

::: warning Attachment types dropped before this version
Earlier versions kept only `fileAttachment` and discarded the other two silently, with no warning and no manifest record, while still storing the message's `has_attachments` flag. Snapshots taken then can claim attachments whose content was never captured. This affected the legacy JSON path only, which is also the only path that existed before MIME storage, so snapshots predating MIME are the ones to treat with suspicion. An attachment type Atlas does not recognise is now recorded with its metadata and warned about, so a gap is auditable instead of invisible.
:::

### Restore is reconstruction, and that is a deliberate choice

Atlas does **not** import archived MIME back into Exchange. Live testing established why: Graph's MIME import path always marks the created message as a draft (`isDraft: true`), and that flag cannot be cleared -- neither an `X-Unsent: 0` header inside the MIME nor a `PR_MESSAGE_FLAGS` patch afterwards clears it. Restoring a mailbox that way would hand the user thousands of drafts instead of their mail.

`atlas outlook restore` therefore parses the archived MIME and recreates each message through Graph's JSON message-create path. The result is normal, non-draft mail with its original timestamps, but the restored copy does not carry the original `Received` chain.

The archived object keeps full fidelity either way. When an operator needs the original bytes -- for a legal hold, a forensic review, or DKIM verification -- `atlas outlook save` is the path that delivers them, and it never touches the live mailbox.

### Content Microsoft 365 refuses to release

Some drive content cannot be archived at all, because the service will not serve it. Malware-quarantined files are the clear case: Microsoft blocks the download by policy, so no backup tool can capture the bytes.

Atlas selects the Graph `malware` facet during delta enumeration and skips a quarantined item without attempting the download. The item is then recorded in the drive's failed-item ledger, reported on every run, and the run is marked `UNHEALTHY` with a non-zero exit code. An operator can always answer which files are absent from a backup and why, which is the property that matters for an audit.

Two consequences worth stating plainly:

- **The quarantined file is not in your backup.** Atlas reports it rather than silently omitting it, but a restore cannot produce a file the service never released. If the content matters, it has to be cleaned or released in Microsoft 365 first.
- **Retrying is not a workaround.** A quarantine is a policy state, so quarantined items do not consume the 5-attempt retry budget that transient failures use. Attempting the download is worse than useless: Graph aborts the transfer instead of returning a clean 403, an aborted transfer is indistinguishable from a network fault, and the request therefore inherits the full Graph retry budget of 12 attempts across roughly 23 minutes. One quarantined file could stall a whole drive backup for that long on every run.

::: warning Sensitivity labels are not captured
Atlas does not currently capture Microsoft Purview sensitivity labels or IRM protection state for drive items. Labelled files whose content Graph does serve are backed up as ciphertext like any other file, but the label itself is not recorded, so a restored copy does not carry its original classification. Treat restored content as unclassified until it is relabelled. Capturing label metadata is tracked separately; it is a metered Graph surface and is deliberately out of scope for the quarantine handling described above.
:::

### In-Place Archive is out of scope

Atlas backs up the **primary mailbox**. A mailbox with an **In-Place Archive** (also called Online Archive, or the archive mailbox) has a second, separate store, and none of it is backed up.

This is not an implementation gap Atlas can close on the current API. Microsoft states it directly in the [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0):

> The API does not support accessing in-place archive mailboxes, not on Exchange Online nor on Exchange Server.

Every Atlas sync path is built on that API. `GET /users/{id}/mailFolders` and the per-folder `/messages/delta` calls only ever see the primary store, and no folder ID or query parameter reaches the archive.

Do not confuse this with the **`Archive` well-known folder**, the one Outlook's one-click Archive button moves mail into. That folder lives in the primary mailbox and is backed up like any other folder.

::: warning Retention policies move mail out of backup scope
This matters most where it is least visible. A Microsoft 365 retention or MRM policy that auto-moves mail to the archive after a set age silently removes that mail from backup scope, and it removes the **oldest** mail first, which is usually the most compliance-relevant. Under an aggressive policy, most of a mailbox's history can sit unprotected.

Worse, when a policy moves an already backed-up message, the folder delta reports it as removed from the primary mailbox. Depending on how you prune snapshots, that message can eventually age out of your backups while the only live copy sits in an archive Atlas cannot read.
:::

**How to tell which mailboxes are affected.** `atlas outlook mailboxes` shows an `Archive` column and warns for every affected mailbox by name:

```
[!] 2 mailbox(es) have an In-Place Archive (Online Archive), which Graph cannot read
    and Atlas does not back up:
      alice@contoso.com
      bob@contoso.com
```

The signal is the `Has Archive` column of the [mailbox usage report](https://learn.microsoft.com/en-us/graph/api/reportroot-getmailboxusagedetail?view=graph-rest-1.0), which needs the optional `Reports.Read.All` application permission. Without that permission the column reads `--`, meaning **unknown**, never "no archive": Atlas will not report coverage it cannot confirm. No per-mailbox Graph property exposes archive state on either v1.0 or beta, so the tenant-wide report is the only source.

**If archive content must be protected**, the mail has to leave the archive before Atlas can see it: adjust the retention policy so it stays in the primary mailbox, or move the content back. The Microsoft [mailbox import and export APIs](https://learn.microsoft.com/en-us/graph/mailbox-import-export-concept-overview) do cover archive mailboxes, but on a different model (job-based FastTransfer export streams and a separate `MailboxImportExport.*` permission set) that is not a drop-in for per-folder delta sync.

### Recoverable Items and legal hold

`atlas outlook backup --include-recoverable-items` reads the Exchange
Recoverable Items subtree, the "dumpster". It is off by default, and turning it
on changes what a snapshot means legally as well as what it costs.

**Why it exists.** A message that arrives and is hard-deleted between two
backups appears in no delta page, so no ordinary Atlas run can see it. Its only
copy is in `Deletions` or `Purges`, and when Exchange's retention window expires
it is gone from the tenant and from every snapshot. Closing that window is the
only way a backup can cover deletion that happens between runs.

**What lands in the snapshot.** `Deletions`, `Purges`, `DiscoveryHolds` and
`SubstrateHolds`, stored as MIME under the same AES-256-GCM encryption and the
same content-addressed layout as ordinary mail. `Versions`, `Calendar Logging`
and `Audits` are not captured, and each is reported by name at the end of the
run. `Purges`, `DiscoveryHolds` and `SubstrateHolds` exist **only** because a
litigation hold, an In-Place Hold, or a retention policy retained them.

::: warning What this means for compliance
Copying hold-retained mail into an Atlas snapshot puts a second copy of legally
held content in your storage, outside the Microsoft 365 retention machinery that
created it, and outside whatever hold released it there. Three consequences:

- **The copy outlives the hold.** Releasing a litigation hold in Microsoft 365
  does not touch an Atlas snapshot. Deleting the copy is your retention
  schedule's job, and `atlas outlook delete` is what performs it.
- **The copy is discoverable.** Content that exists in your bucket can be
  compelled from your bucket, whether or not it still exists in the tenant.
- **Object Lock makes it undeletable on purpose.** A snapshot written under
  `--retention-days` cannot be deleted until retention expires, including by
  you. Combining Object Lock with purged mail is a deliberate decision, not a
  default.

Whether that is protection or exposure is a question for whoever owns the
retention policy. Atlas marks these entries in the manifest so the answer is
always visible from the snapshot itself, rather than depending on which flags a
past run happened to carry.
:::

**Restore is opt-in separately.** Marked entries are excluded from `restore` and
`save` unless `--include-recoverable-items` is passed there too, so an ordinary
recovery cannot resurrect deleted mail by accident. Graph offers no path back
into Recoverable Items, so recovered items land in the normal restore folder as
visible mail. Restoring a purged message therefore makes it live again, which is
usually the intent and is occasionally the last thing you want.

**Permissions are unchanged.** The subtree is read with the same `Mail.Read`
that ordinary mail needs, so enabling this grants Atlas nothing new against the
tenant.

### What a drive restore rebuilds, and what it cannot

A restored file is the original bytes, verified against the manifest checksum. Everything else that defines a document in Microsoft 365 is a separate question, and the answers differ:

| Property                                 | Captured | Restored                                |
| ---------------------------------------- | -------- | --------------------------------------- |
| File content                             | Yes      | Yes, byte-exact                         |
| Original created and modified timestamps | Yes      | Yes, through the `fileSystemInfo` facet |
| `createdBy` / `lastModifiedBy` authors   | Yes      | No. Recorded for audit only             |
| Version authors                          | Yes      | No. Recorded for audit only             |
| Sharing permissions and links            | No       | No                                      |

#### Timestamps: which ones travel

Graph exposes two pairs of timestamps, and only one pair is writable. The `driveItem` values are what the service saw, so after a restore they read "now" and nothing can change that. The [`fileSystemInfo`](https://learn.microsoft.com/en-us/graph/api/resources/filesysteminfo) facet holds the client-reported values, it is writable on upload, and it is therefore what Atlas restores.

Both are recorded: `last_modified_at` on a manifest entry is the service-side value, `file_system_info` is the client pair. Practically, a restored file carries its original dates in the facet while the service's own created/modified columns show the restore. That is the ceiling the API imposes, not a choice.

The two upload paths reach it differently. A resumable upload session accepts item metadata up front, so the timestamps travel with the upload. A small-file `PUT /content` carries bytes only, so Atlas follows it with a `PATCH`. That patch is best-effort: if it fails, the file keeps restore-time timestamps and the run logs it, because a restored file with wrong dates beats no restored file.

#### Authors are captured, not restored

`createdBy` and `lastModifiedBy` are recorded on every manifest entry, and `lastModifiedBy` on every version row, so "who wrote this" is answerable from a backup years later. They are not reapplied on restore: Graph attributes an upload to the identity that performed it, and rewriting authorship needs migration-grade APIs that carry their own permission set. A restored file is authored by the Atlas application identity, and the manifest is where the original author lives.

::: warning Sharing permissions are not captured
Atlas does not capture per-item sharing permissions or links, so a restore does not reconstruct them. A restored library inherits the destination's defaults, which are usually broader than whatever curated sharing the original had. **Treat a restored library as unshared and re-apply access before handing it back to users.**

This is a cost decision, and the numbers are the argument. Permission operations cost **5 resource units** each against the SharePoint/OneDrive pool (see [Graph rate limits](./operations/graph-rate-limits.md#resource-unit-costs)), and that pool is tenant-wide, shared with every other app. Capturing permissions for every item in a 100,000-file drive is 500,000 RU; at the 1,250 RU/minute a tenant under 1,000 seats gets, that is roughly **6.7 hours of the tenant's entire drive quota spent on metadata**, versus a few thousand RU for the delta enumeration that finds the files in the first place. It would slow every other Atlas operation and every unrelated app in the tenant.

The workable shape is narrower: Graph flags shared items with a `shared` facet, which costs nothing extra in the delta `$select`, so only genuinely shared items would need a call. That plus a restore-side design for re-applying access is tracked separately rather than bolted on here.
:::

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

`atlas outlook verify` checks the **message entries** listed in the manifest. For a MIME entry that covers the attachments too, because they are part of the message bytes being hashed. For a legacy JSON entry the separate attachment objects are not hashed against the manifest; they are protected by GCM authentication during any decrypt operation (backup, restore, save), which detects tampering but not a checksum recorded wrong at backup time.

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

### Key material lifetime

Opening a storage target derives an envelope key service from the passphrase and unwraps the tenant DEK, so every target a replication run touches holds key material in memory for as long as its context is open. Atlas closes each context as soon as the copy it was opened for finishes, on the failure path as well as the success path, which zeroes the passphrase buffer instead of leaving it for garbage collection.

This bounds exposure to the duration of one snapshot copy rather than the whole run. It is defence in depth rather than a boundary: a process that can read Atlas's heap while a copy is in flight can read the key anyway, and Node offers no guarantee that a buffer is not copied elsewhere before it is zeroed. What it does remove is key material sitting in a long-lived process after the work that needed it is over.

### Access Isolation

While encryption keys are shared, **S3 access credentials should be separate per target**. Use independent IAM principals for each storage endpoint:

- Primary MinIO: `atlas-primary` user with full read/write
- Offsite MinIO: `atlas-offsite` user with full read/write
- Cloud S3: dedicated IAM role with scoped permissions

If an attacker compromises one target's S3 credentials, they can read that target's data (which is encrypted) but cannot reach other targets. Combined with a strong passphrase, this provides defense in depth.

### DEK Mismatch Protection

Atlas validates encryption key consistency before every replication and rehydration. If the primary tenant was purged and re-initialized (generating a new DEK), replication to a target with the old DEK is refused with an explicit error. This prevents a scenario where objects encrypted with different keys coexist on the same target, making older objects permanently undecryptable.

The check runs once per target per run, before the first snapshot is copied, rather than once per snapshot. Whether two buckets share a DEK is a property of the pair, and each check unwraps both wrapped DEKs, which is two scrypt derivations at N=65536. A target that fails the check is refused before anything is written to it.

### Replica Marker

Atlas writes a marker file (`_meta/replica.marker`) on each target during first replication. If a user accidentally runs `atlas outlook backup` against a replica target, Atlas detects the marker and logs a warning. This guards against accidental violation of the primary-is-truth principle, which could lead to data inconsistency.

### Replication Status Encryption

Replication status sidecar files stored under `_meta/replication/` in the primary bucket are encrypted with the tenant DEK. Target endpoints, checksums, and error messages are not exposed at rest in S3.

## S3 Permissions by Command Class

Atlas splits its storage access in two, so a browsing operator never needs write credentials:

| Command class                                                                                                                            | S3 actions required                                                                                                         | Provisioning |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Read-only: `outlook list`, `outlook read`, `outlook status`, `outlook verify`, `onedrive list`, `sharepoint list`, `stats`, `list-users` | `s3:GetObject`, `s3:ListBucket`                                                                                             | None         |
| Write: `backup`, `restore`, `save`, `replicate`, `rehydrate`, `delete`                                                                   | the above plus `s3:CreateBucket`, `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, lifecycle/lock configuration | Yes          |

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
