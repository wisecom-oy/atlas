---
description: 'How Atlas protects backups: what is encrypted and with which keys, what each credential allows, integrity checks, erasure, and what a restore cannot rebuild.'
---

# Security model

Atlas encrypts every backup before it leaves the host, checks every object before it restores it, and keeps the key to all of it behind a passphrase that only you hold. This page is the reference for how that works, what each credential exposes, and the limits to plan around.

## The model in brief

- **Everything Atlas stores is encrypted.** Messages, files, attachments, Teams messages, contacts, calendar events, and the snapshot records that describe them are encrypted with AES-256-GCM before upload. The storage provider holds only ciphertext.
- **One data key per tenant, locked by your passphrase.** Each tenant has a random 256-bit data key. The bucket holds it only in wrapped (encrypted) form, and only your passphrase can unwrap it. The passphrase is never written to the bucket.
- **Losing the passphrase loses the backups.** There is no recovery key, no escrow, and no support path. Without the passphrase, every backup for the tenant is permanently unreadable.
- **Read access to the bucket reveals structure, not content.** A reader sees object names, sizes, and counts. They can copy the wrapped key and guess the passphrase offline, so the passphrase's strength is the defence.
- **Tampering and corruption are detected.** Every object carries an authentication tag, and a restore compares each item with the checksum recorded at backup. Damaged data is reported, never restored silently.
- **Deletion protection is enforced by storage.** With [Object Lock](/operations/immutability), the storage backend refuses to delete backups until their retention ends, whatever credentials the caller holds.

## Who can do what with which credential

| Someone who holds | Can | Cannot |
| --- | --- | --- |
| Read access to the bucket | List object names, sizes, and counts. See which objects hold identical content. Read `x-message-id` metadata and the Entra object IDs in paths. Copy the wrapped data key and guess the passphrase offline | Read content. Confirm that a known file is stored, for objects with keyed names |
| Write or delete access to the bucket | Delete or overwrite backups not under Object Lock. Make a snapshot unreadable, which is reported by key on every run. Replay an older valid ciphertext of an object. Remove or forge an owner lease. Delete or damage a delta cursor or summary index, which forces a full read or stops the next run until an operator acts. Add locked objects that cost storage until they expire | Create content that decrypts. Move an object to another owner's path undetected. Shorten an existing lock |
| The passphrase alone | Nothing without a copy of the bucket or of `_meta/dek.enc` | |
| The passphrase and read access to a bucket | Read every backup in that bucket, on the primary and on any replica | Change backups without write access |
| An old passphrase after a re-wrap, plus `s3:GetObjectVersion` | Unwrap the unchanged data key from a noncurrent `_meta/dek.enc` version until it is purged | Open the current wrapper |
| The data key itself, from memory, a core dump, or a compromised host | Read all data written under it, for as long as that data exists | Be stopped by a re-wrap. [Rotate the data key](#rotating-the-data-key) |
| The Entra app's client secret | Call Microsoft Graph as the app and read live tenant data that its permissions reach | Read stored backups |
| Read access to `atlas.config.json` | Read the passphrase, the S3 secret key, and every profile's client secret stored there | |
| A session as the user who runs Atlas | Unlock the encrypted config store through the OS keyring and read every profile's secrets | |
| Root on a MinIO server | Bypass `GOVERNANCE` retention and delete every backup not under `COMPLIANCE` retention | Delete a `COMPLIANCE` object before its retain-until date |
| A network observer on a plain `http://` storage endpoint | See object keys, the access key ID, and request patterns. Forge a success response to an upload | Read content or the S3 secret key |
| A consumer of exported storage request events | See timings and the size distribution of stored ciphertext | See object keys, bucket names, tenant or owner IDs, or content hashes |

The sections below give the detail behind each row.

## Key hierarchy

```
passphrase
  → scrypt (tenant salt, N=65536, r=8, p=1) → KEK (256-bit)
  → KEK wraps the DEK (AES-256-GCM, header as AAD)
  → DEK encrypts every object and manifest for the tenant
```

| Key | What it is | Where it lives |
| --- | --- | --- |
| DEK (data encryption key) | A random 256-bit key generated once per tenant. Encrypts all of the tenant's data | `_meta/dek.enc` in the tenant bucket, wrapped. In plaintext only in memory during a run |
| KEK (key encryption key) | Derived from the passphrase and the tenant ID. Only wraps and unwraps the DEK | Never stored |
| Passphrase | Your secret | Your config store, secret manager, or vault. Never in the bucket |

The DEK is random, so its strength does not depend on the passphrase, and changing the passphrase rewrites one small object instead of every backup.

The wrapped blob is self-describing. It carries the KDF identifier, the scrypt parameters, and a 32-byte random salt in a header that is authenticated as additional data (AAD), so tampering with the parameters makes unwrap fail.

### Passphrase key derivation (scrypt) {#kek-derivation-scrypt}

Atlas derives the KEK with scrypt, a memory-hard function that makes GPU and ASIC guessing expensive. Parameters for new wraps:

| Parameter | Value | Purpose |
| --- | --- | --- |
| N (cost) | 65536 | CPU and memory cost (2^16) |
| r (block size) | 8 | Memory multiplier |
| p (parallelism) | 1 | Sequential derivation |
| Salt | 32 random bytes | Fresh on every wrap, including re-wraps. Combined with the tenant ID, so one passphrase yields a different KEK per tenant |
| Output | 32 bytes | AES-256 key |
| Minimum N on unwrap | 16384 | Blobs with weaker parameters are rejected, so a tampered blob cannot downgrade the derivation |
| Maximum N on unwrap | 1048576 (2^20) | Blobs above it are rejected, so a crafted blob cannot allocate unbounded memory |

A re-wrap picks up the current parameters. Until then, a tenant keeps the parameters it was created with.

**The passphrase is the whole defence against offline guessing.** The wrapped DEK sits next to the data with its KDF parameters in plaintext, so anyone with read access to the bucket can try passphrases offline. Atlas refuses to wrap a key under a passphrase shorter than **14 UTF-8 bytes**: at first-time key creation, in `atlas keys rewrap`, for the SDK `encryptionPassphrase` option, and in `atlas config set encryption.passphrase`. Keys already wrapped under a shorter passphrase still open, with a warning on every run.

Byte length is a floor, not an entropy guarantee. For production, use at least five random words or 20 random characters.

::: danger A lost passphrase cannot be recovered
There is no recovery path. Without the passphrase the DEK cannot be unwrapped, and every backup for that tenant is permanently unreadable. Changing `ATLAS_ENCRYPTION_PASSPHRASE` without re-wrapping the stored keys causes authentication failures on the next run. Change it with `atlas keys rewrap --new-passphrase`, which re-wraps every profile first (see [Rotation procedure](#rotation-procedure)). Store the passphrase in a password manager or a secrets vault, with a second copy kept offline.
:::

To check a passphrase without writing anything, use the SDK's `validate()` method. It checks S3 `HeadBucket` access on the tenant bucket, unwraps the existing `_meta/dek.enc` when one exists, and acquires a Graph token. A wrong passphrase fails with `WrongPassphraseError`. A tenant with no key yet passes that step. `validate()` does not confirm that writes are permitted or that Graph consent is in place.

::: details Derivation cost and memory
Derivation runs on Node's libuv threadpool, so it does not block the host process's event loop. Each derivation uses roughly 64 MiB and takes about 90 to 110 ms. With Node's default pool of 4 threads, peak scrypt memory is about 256 MiB. Raising `UV_THREADPOOL_SIZE` raises that ceiling. The derived key is zeroed as soon as the wrap or unwrap completes.
:::

## Rewrapping the passphrase

```bash
atlas keys rewrap --new-passphrase
```

`atlas keys rewrap` derives a new KEK and rewrites `_meta/dek.enc` under it, for the tenant of every profile. The DEK inside is unchanged, so no data is re-encrypted and every snapshot stays readable. It is one small object write per tenant regardless of tenant size.

The command rotates the wrapper, not the key. It defeats a leaked passphrase, because the old one no longer opens the current wrapper. It does not help against someone who already has the DEK or plaintext decrypted with it. For that, see [Rotating the data key](#rotating-the-data-key).

Every profile is re-wrapped because the passphrase is a shared setting: every tenant's key is wrapped under it, each with its own salt. Re-wrapping one tenant and then changing the configured passphrase would leave every other tenant failing with `ATLAS_WRONG_PASSPHRASE` and still dependent on the old passphrase. So the command switches the configured passphrase only when every tenant is re-wrapped or has no key yet. A run that leaves any tenant behind exits `2`, changes no configuration, and names those tenants. Rerunning finishes the job: a tenant already under the new passphrase is detected by unwrapping and skipped. `--tenant` narrows a passphrase change to one tenant only together with `--allow-partial`.

Atlas checks which passphrase opens the stored key before writing anything, then reads the new blob back and unwraps it with the new passphrase to confirm it.

::: details If the read-back check fails
| Stored after the write | What Atlas does |
| --- | --- |
| A wrapper that opens with neither passphrase | Restores the previous wrapper with a conditional write, confirms it opens, and reports the failure. If the restore or its check fails, the error says so and the stored wrapper is in an unknown state: the restore may have landed, or another run may have written in between. Check which passphrase opens it before running anything else against the tenant |
| A wrapper that opens with either passphrase but is not the one this run wrote | Leaves it in place and reports that another run changed the key |
| This run's wrapper, but it does not unwrap to the same key | Reports the failure without a restore. The new wrapper stays current |

A read-back request that fails is reported as a storage error, without a restore. A run that lost its tenant lease before a restore fails with `ATLAS_OWNER_BUSY` and does not restore, because the wrapper it would replace may belong to a newer run.
:::

### Rotation procedure

1. **Re-wrap every profile.** Run `atlas keys rewrap --new-passphrase` when no backup is scheduled. Atlas runs one operation at a time per tenant, so a tenant with a running operation is reported `busy, skipped`. Rerun until the command exits `0`.
2. **Switch the configured passphrase.** A complete run stores the new passphrase in the encrypted config store when that is where the passphrase came from. When it came from `ATLAS_ENCRYPTION_PASSPHRASE` or `atlas.config.json`, the command changes nothing there and prints where to change it. Change it in every place that runs Atlas: schedulers, CI secrets, other hosts. If some tenants were missed after the configured value already changed, `atlas keys rewrap --old-passphrase` moves them from the old passphrase to the configured one.
3. **Prove the new passphrase.** Run a backup or a restore of each tenant with the new configuration.
4. **Remove the old wrappers.** Run `atlas keys purge-old-wrappers --old-passphrase`. See [Old wrapper versions](#old-wrapper-versions).
5. **Cover copies Atlas does not manage.** A provider replica, an export of `_meta/dek.enc`, or a backup of the bucket each holds its own copy. See [Copies outside the bucket](#copies-outside-the-bucket).
6. **Retire the old passphrase** from password managers and vaults only after the steps above, and after checking what else it protected.

### Old wrapper versions

```bash
atlas keys purge-old-wrappers --old-passphrase
```

Atlas creates buckets with versioning on, so a re-wrap leaves the previous `_meta/dek.enc` as a noncurrent version, and that version still opens with the old passphrase. Until it is gone, anyone with the old passphrase and `s3:GetObjectVersion` on the bucket can unwrap the unchanged DEK. Buckets Atlas creates expire noncurrent versions after 30 days, but only where the lifecycle request succeeded, so do not rely on it. Purge them.

What the purge deletes and keeps:

| Version | Result |
| --- | --- |
| Noncurrent, unwraps to the same DEK as the current version | Deleted |
| Noncurrent, holds a different DEK | Kept, because it may still protect data an Object Lock retains |
| Opened by no supplied passphrase | Kept and reported |
| Current version | Never deleted |

The purge refuses a tenant unless the configured passphrase opens its current wrapper, so it cannot run before the configuration is switched. A backend whose version listing does not name exactly one current version gets nothing deleted. A bucket whose `_meta/dek.enc` has no current version, for example behind a delete marker, has nothing to compare against, so its old versions are reported as left and kept.

Deleting the old versions removes the way back to the old passphrase. Run the purge only after a backup or restore succeeded with the new one.

::: warning When old versions cannot be deleted
Object Lock refuses to delete a version under `COMPLIANCE` retention until its retain-until date passes, and under `GOVERNANCE` retention unless the caller sends a bypass, which Atlas never sends. The purge reports such versions as `retained` and exits `2`. Until they expire, close the window another way:

- Deny `s3:GetObjectVersion` on `_meta/dek.enc` to every principal that does not need it. A reader without it cannot fetch the old version.
- Rotate the S3 access keys that the leaked passphrase may have travelled with. The old wrapper is useless to someone who cannot read the bucket.
- If neither is possible, treat the DEK as exposed for the retention period and plan a [data key rotation](#rotating-the-data-key).
:::

### Copies outside the bucket

The re-wrap and the purge act on the buckets Atlas opens with its configured endpoint. Other copies of `_meta/dek.enc` keep whatever wrapper they were made with.

- **Provider-side bucket replication** copies the re-wrapped `_meta/dek.enc` to the replica, but not the purge of old versions. See [Replicas](#replicas).
- **Bucket backups, exports, and storage snapshots** carry the old wrapper for as long as they are kept. Expire them, or restrict who can read them.

## Rotating the data key

Rotate the DEK when the key itself may have left the process, through memory, a core dump, or a compromised host. Rotation means starting a new bucket, because Atlas names the bucket `atlas-<tenant-id>` and a bucket holds one DEK.

```bash
# 1. Point Atlas at storage where atlas-<tenant-id> does not exist yet
atlas config set s3.endpoint https://new-s3.example.com
atlas config set s3.access-key <new-access-key>
pbpaste | atlas config set s3.secret-key -
pbpaste | atlas config set encryption.passphrase -

# 2. Back up every mailbox, drive, and site again; the first run generates the new DEK
atlas outlook backup -m user@example.com
```

The new bucket must sit on a different endpoint or S3 account. The first backup generates a random DEK and wraps it under the new passphrase. It has no sync checkpoints (Microsoft Graph delta links) to start from, so it is a full backup with the time and throttling cost of a first backup.

Earlier snapshots stay in the old bucket under the old DEK. Restore them with the old endpoint, credentials, and passphrase. Nothing is migrated or re-encrypted. Once the old snapshots are no longer needed, remove them with `atlas delete --purge` against the old storage. Objects under Object Lock retention cannot be deleted before their retain-until date, and the purge reports them as retained rather than failed. A replica holds the same key, so a new key needs a new replica too (see [Replicas](#replicas)).

::: warning Rotation protects new data only
Data already written under the old key stays readable with that key for as long as the old bucket exists, including noncurrent versions and objects Object Lock retains. Atlas has no in-place re-key, because that would leave a bucket split between two keys while it was rewritten.
:::

## Content encryption

Every object is encrypted with **AES-256-GCM**. The GCM tag provides confidentiality and authenticity: a single flipped bit fails decryption. The one unencrypted object is the [owner lease](/operations/storage-layout#owner-leases), plain JSON that says which operation is running on an owner and since when, and nothing about the content.

| Data | Encrypted | Location |
| --- | --- | --- |
| Email messages | Yes | RFC 5322 MIME, or legacy Graph JSON, under `data/{owner_id}/{content_name}` |
| Attachments | Yes | Legacy JSON entries only, under `attachments/{owner_id}/{content_name}`. MIME embeds them |
| Manifests | Yes | Subjects, senders, folder names, delta URLs, checksums |
| Snapshot summary indexes | Yes | Snapshot IDs, times, totals, and owner labels, under `_meta/outlook-manifests/owners`, `onedrive/_meta`, `sharepoint/_meta`, `contacts/_meta`, and `calendar/_meta` |
| OneDrive file blobs | Yes | `onedrive/data/{owner_id}/{content_name}` |
| OneDrive manifests, indexes, and sync checkpoints | Yes | `onedrive/manifests`, `onedrive/index`, `onedrive/_meta` |
| Teams message blobs and inline images | Yes | `teams/data/{team_id}/{content_name}`, `teams/data/{team_id}/hosted/{content_name}` |
| Teams indexes, channel shards, and sync checkpoints | Yes | `teams/manifests`, `teams/shards`, `teams/_meta` |
| Contacts data, photos, and manifests | Yes | `contacts/data`, `contacts/photos`, `contacts/manifests`, `contacts/_meta` |
| Calendar events, attachments, and manifests | Yes | `calendar/data`, `calendar/attachments`, `calendar/manifests`, `calendar/_meta` |
| Wrapped DEK | Yes | `_meta/dek.enc`, encrypted with the KEK |
| S3 object metadata | **No** | `x-message-id` on mailbox objects is visible to anyone with S3 read access |

Apart from `x-message-id`, objects store no item IDs, version IDs, or plaintext checksums in unencrypted metadata. Those live inside encrypted manifests and version indexes. Mailbox objects written before keyed naming also carry `x-plaintext-sha256` (see [What object names reveal](#what-object-names-reveal)).

::: details Object format and IV budget
```
[ATLS][version][12-byte IV][16-byte GCM tag][ciphertext]
```

Each object gets a fresh random 12-byte IV. Reusing an IV under the same key would break GCM, so Atlas never reuses one. Random IVs carry a birthday bound: NIST SP 800-38D caps random-IV GCM at 2^32 invocations per key, where the probability of an IV collision is about 2^-33. One DEK covers a whole tenant, and a multipart upload uses one IV for the whole object, so the budget is about 4.3 billion objects per tenant bucket. Each unique file or message is stored once, so backing up unchanged bytes again does not consume the budget.
:::

### What a ciphertext is bound to

One DEK encrypts the whole tenant, so the GCM tag alone proves only that bytes came from that tenant's key. Atlas also binds the header and the object's scope as associated data, so a ciphertext decrypts only where it was written. The scope is the object's directory: `onedrive/data/{owner_id}/`, `contacts/data/{owner_id}/`, `calendar/data/{owner_id}/`, or `manifests/{owner_id}/`.

| Attack | Result |
| --- | --- |
| Move an object over another owner's or purpose's path | Decryption fails: the scope no longer matches |
| Strip or lower the version header | Decryption fails: the header is authenticated |
| Move an object within its own directory | Not prevented. The manifest checksum comparison detects it |
| Copy one owner's sync checkpoint over another's | Rejected: the checkpoint names its owner, and load checks it |
| Copy one owner's snapshot summary over another's | Ignored: the summary names its owner, and the read falls back to decrypting the manifests |
| Edit a summary row to point at another manifest | Not possible without the DEK. A row is also used only when its manifest path matches its own owner and snapshot |
| Replay an older ciphertext of the same object | Not prevented. Object Lock and versioning handle this |

::: details A flipped version byte
The version byte is read before the tag is checked, so a bit flipped in that byte would make an intact object look like one a newer Atlas wrote. When the byte holds a version this build does not know, Atlas checks the tag with the current header as associated data. A match proves the object was written as the current version and the byte changed in storage: the object is read, and a warning names its path so it can be rewritten. No match means the object is refused with `ATLAS_FORMAT_UNSUPPORTED`. This is not a downgrade path, because an object a newer Atlas wrote was authenticated under its own header and cannot pass the check. Streamed reads of large files do not make this second check and refuse the object.
:::

### What object names reveal

Each content object is named by an HMAC-SHA256 over its plaintext, keyed with a naming key derived from the tenant DEK with HKDF-SHA256 (info `atlas/object-name/v1`). The name (`{content_name}`) is 64 hex characters.

A reader of the bucket can see names and sizes, and can tell when two objects hold identical content, because identical content gives identical names. They cannot tell what the content is: without the data key they cannot compute a name from a known file, so a dictionary of likely documents matches nothing in the bucket.

Objects written before keyed naming are named by the plain SHA-256 of their plaintext, and mailbox objects from that time also carry an `x-plaintext-sha256` metadata header. A reader holding a copy of a file can compute that name and confirm the owner stored it. Those objects stay readable through their manifest entries, and Atlas does not rename or delete them. See [Migrating to v6](./migration/v6.md#all-workloads-keyed-content-object-names) for how to remove them.

## Integrity validation

Atlas checks integrity at three independent layers:

| Layer | Mechanism | What it catches | When |
| --- | --- | --- | --- |
| **Plaintext** | SHA-256 in the manifest | Corruption before encryption, application bugs | Backup, verify, save |
| **Transport** | `Content-MD5` on every S3 PUT | Network corruption in flight | Every upload. S3 rejects a mismatch |
| **At rest** | AES-256-GCM authentication tag | Tampering or corruption in storage | Every decrypt |

`atlas outlook verify` downloads each encrypted object, decrypts it, hashes the plaintext, and compares the result with the manifest checksum in constant time (`timingSafeEqual`). For MIME entries this covers attachments, because they are part of the hashed message. Legacy JSON attachments are separate objects, protected only by GCM during decrypt and not hashed against the manifest.

Verification counts an entry as soon as it claims a stored blob. An entry that names a blob without a checksum is a verification failure. Tombstones are the only entries without a blob, so they are not counted.

### What the GCM tag does not prove

A valid tag proves the bytes were produced under the tenant DEK. It does not prove they belong at that path. Restore therefore compares the manifest checksum before anything acts on the bytes:

| Path | Checked before |
| --- | --- |
| Outlook message restore | `POST /messages`, for MIME and legacy JSON entries |
| Outlook attachment restore | Each attachment upload |
| Drive file restore | The upload, buffered or streamed |
| Snapshot manifests | Atlas rebuilds the path from the manifest's own `owner_id` or `site_id` and `snapshot_id`, and compares it to the path it read |

An entry with no recorded checksum is refused rather than restored unverified. A manifest planted under another snapshot's path is reported as unreadable, by path, never skipped in silence. Listings, status, and backups go on without it and exit `9`. A restore refuses when the snapshot it resolves may depend on it, because leaving it out would restore a drive or mailbox that never existed. See [Damaged manifests and version indexes](/troubleshooting#damaged-manifests-and-version-indexes).

Two limits remain. Neither check stops replay of an older valid ciphertext for the same object, which Object Lock and versioning handle. A checksum recorded wrongly at backup time also goes undetected.

An attacker with write access to the bucket can still make a manifest unreadable, and `quarantine` then removes its run from later points in time for OneDrive, SharePoint, and Outlook. That needs the same access as deleting the manifest outright, and the damage is reported by path on every run until an operator acts. Quarantine never deletes the bytes, and Object Lock keeps a retained version in place. Check bucket versioning for an intact earlier version before quarantining.

### Metadata is checked before and after it is stored

A snapshot manifest, version index, Teams index, or sync checkpoint is the only record of what a run stored, and the sync checkpoint then moves past the changes that record describes. A record that could not be read back later would lose those changes. So Atlas checks each one before it uploads it and, for most, reads it back after:

```
Refusing to write the contacts manifest at contacts/manifests/<mailbox-id>/ct-snap-1767225600000-a1b2c3.json: its reader would reject it (The contacts manifest is not a manifest: ...). Nothing was written.
```

| Step | What it does | What it catches |
| --- | --- | --- |
| Serialise | Writes the object as one JSON document | An object past the V8 string limit of about 512 MB. There is no lower size ceiling |
| Reader check | Parses the document back and applies the reader's checks: required fields, the owner and snapshot its path names, a parseable `created_at` | A defect in Atlas or an item Microsoft 365 returned malformed, before it becomes a stored object every command reports as damaged |
| Decrypt back | Encrypts with AES-256-GCM, decrypts in memory, and compares with the plaintext | A memory or CPU fault between serialisation and upload |
| Conditional PUT | Writes an object that is never rewritten with `If-None-Match: *`, and replaces a summary index only at the ETag it read (`If-Match`) | A snapshot ID collision, a second writer replacing a manifest, or a lost summary update |
| Read back | Reads the object with one `GET` and compares it byte for byte with the ciphertext sent | A write the backend acknowledged but stored differently, or a concurrent overwrite |

The first three steps fail with `RefusedWriteError` (`ATLAS_WRITE_REFUSED`) and store nothing. That is a defect on the writing side, not damage in storage, so it is never reported as an unreadable object and there is nothing to quarantine. A checkpoint is saved only after its manifest, so a refused manifest leaves the checkpoint where it was and the next run reads the same changes again.

If a lost response makes the storage client retry a `PUT`, the retry meets the object the first attempt stored and is refused with `412 Precondition Failed`. Atlas then reads the stored object. Every encryption uses a fresh random IV, so a byte-identical ciphertext can only be this write, and the run continues. Anything else fails with `StoredObjectConflictError` and the stored object is left as it is.

::: details Which objects are create-only and read back
| Object | Create-only | Read back |
| --- | --- | --- |
| Outlook, OneDrive, SharePoint, contacts, and calendar snapshot manifests | Yes | Yes |
| OneDrive and SharePoint version index of a run | Yes | Yes |
| Teams snapshot index | Yes | Yes |
| Outlook, OneDrive, SharePoint, contacts, and calendar sync checkpoints | No | Yes |
| Outlook, OneDrive, SharePoint, Contacts, and Calendar snapshot summary indexes | No, compare-and-swap | No |
| Outlook manifest pointers, Teams channel shards, cursors, and checkpoints | No | No |

The read-back is limited to objects a run writes once, so a run makes at most three extra `GET` requests per mailbox, owner, site, or team. Teams writes one shard and one cursor per changed channel and checkpoint objects per page, so those are checked and decrypted back but not read back.

A [snapshot summary index](/operations/storage-layout#snapshot-summary-index) is rewritten by every backup, so it cannot be create-only. It is not read back either, because no command trusts it on its own: every read lists the manifest paths and treats a summary that is missing, damaged, or names another owner as empty. Its reader check covers the format version and the owner. A malformed row is not refused, since the reader drops it and decrypts that manifest instead.
:::

What these checks do not cover:

- **Content.** Message, file, and attachment objects are not JSON metadata. The three integrity layers above cover them.
- **Values that are well formed but wrong.** The reader check is exactly as strict as the reader. The Outlook, OneDrive, and SharePoint readers check a manifest's identity, its `entries` list, and its date, not each entry, so a wrong field inside an entry passes.
- **Changes after the read-back.** An attacker with write access can still replace or damage the object later. Object Lock and versioning address that.
- **Backends that ignore conditional headers.** There the create-only write would overwrite like any other, so Atlas refuses to write to such a bucket at all. See [Conditional writes are enforced or refused](#conditional-writes-are-enforced-or-refused).

See [Refused and unconfirmed metadata writes](/troubleshooting#refused-and-unconfirmed-metadata-writes) for each message.

### Authentication failures are reported everywhere

A failed authentication tag never looks like a successful empty result:

| Object | Reported as |
| --- | --- |
| Outlook attachment | An error on the restore result, counted in `attachment_error_count` |
| Drive file in an export | An error and an integrity failure |
| Snapshot manifest | `UnreadableObjectsError` naming the path, raised by a read of that snapshot or of a chain that needs it, and reported by every listing that skips it. Only a genuinely absent object reads as absent. A storage outage stays a `StorageError` |
| Version index | The same, from `list-versions`, `restore-version`, and `verify`. A scan of version watermarks logs it and captures those versions again |

`--skip-integrity-check` disables the comparison for export. Use it only when recovering data matters more than proving it.

### Nothing is released before it authenticates

An unverified byte may travel, but nothing makes it visible until the whole object has passed the tag and checksum checks.

- **Large file restore to Microsoft 365.** Atlas streams plaintext into a Microsoft Graph upload session as it decrypts, so bytes leave Atlas before the checks finish. The session is committed only by the chunk carrying the last byte, and Atlas holds that chunk until decryption ends without error. A failed tag or checksum abandons the session with `DELETE`, and no file is created. Atlas also refuses any chunk that would reach the declared end while the source still has data, so an object longer than its recorded size cannot commit early. The file fails and the recorded and stored sizes are reported as disagreeing.
- **Drive export of files larger than 4 MiB.** A file path or a stream handed to a caller publishes data as it arrives, so Atlas verifies first, in two passes. The first pass decrypts and checks the GCM tag and the manifest SHA-256 without keeping plaintext, so a bad object is skipped and reported like a small one, with no entry in the archive. The second pass decrypts again into the zip entry and checks the plaintext against the first pass digest. If the object changed between the reads, the entry cannot be withdrawn, so the whole export fails: a path target is never published and a stream target is destroyed. Memory stays at the stream buffers regardless of file size, and each large object is read from storage twice.

## Transport to storage

```bash
ATLAS_S3_ENDPOINT="https://s3.example.com"   # any endpoint not on this machine
ATLAS_S3_ENDPOINT="http://localhost:9000"    # local MinIO only
```

Use `https://` for any endpoint on another machine. Atlas accepts plain `http://` because local MinIO needs it. Content stays protected over HTTP, since every object is AES-256-GCM ciphertext and SigV4 signs requests without sending the secret key, but the traffic around the content is visible to anyone on the network path:

| Exposed over plain HTTP | Why it matters |
| --- | --- |
| Object keys | Keys carry Entra object IDs and content hashes |
| Access key ID | Identifies the account. The secret key is not sent |
| Request pattern | Which owners are backed up, when, and how much data |
| Unauthenticated responses | A forged `200` to `PutObject` makes a backup report success for an object never stored. Only a later `verify` finds it |

Atlas warns once per run for each plain `http://` endpoint whose host is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`). It does not refuse the endpoint, because a self-hosted setup may terminate TLS on a trusted network.

The bundled `docker/docker-compose.yml` publishes MinIO on `127.0.0.1` only and has no fallback root password, so it does not start until one is set. Root on the bucket can bypass governance-mode Object Lock and delete every backup not under compliance retention, so the root password and the bind address decide who can reach the archive. Widening the bind address takes an explicit `MINIO_BIND_ADDRESS` setting. See [Network exposure](/self-hosting/storage#network-exposure).

Microsoft Graph is stricter: Atlas refuses to call it at all when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate validation. Storage has no equivalent check.

## Conditional writes are enforced or refused

```text
Refusing to write to bucket <bucket>: the storage backend does not enforce conditional writes (...)
```

Atlas keeps concurrent runs apart, and keeps one data key per tenant, with conditional writes: a create-only `PUT` (`If-None-Match: *`) and a compare-and-swap `PUT` (`If-Match: <etag>`). These are the only lock Atlas has. On a backend that accepts them without checking:

| What depends on it | What goes wrong without it |
| --- | --- |
| Owner and tenant leases | Two backups, or a backup and a delete, run on the same owner at once and overwrite each other's manifests and cursors |
| Data key bootstrap | Two first runs of a tenant can each store a data key. Atlas reads the stored key back, but data already encrypted under the losing key would be unreadable |
| Create-only manifests and indexes | A snapshot ID collision or a retried `PUT` replaces a stored manifest instead of failing |
| Identity registry | Concurrent backups drop each other's new entries. A backend that refuses a correct `If-Match`, as Ceph RGW 18 does, makes every registry update fail |

Every Atlas process therefore probes each bucket before its first conditional write to it, with the same three checks `atlas storage-check` runs, and remembers the answer for the rest of the process. A backend that accepts a create-only write onto an existing object, accepts a stale ETag, or refuses the current ETag is refused with `ConditionalWritesNotEnforcedError` (`ATLAS_CONFIG_INVALID`, exit `6`) before any lease, key, or backup data is written. No setting turns this into a warning: running without these guarantees corrupts backups silently, and the damage surfaces only at restore. The only way past the refusal is to take the exclusion over yourself, described next.

The probe is a behaviour check from one client, not a proof:

- **It does not detect a malicious backend.** A backend that answers the probe correctly and ignores the headers later is not caught. Choose the backend for its conditional-write support, as listed in [Backend compatibility](/self-hosting/storage#backend-compatibility).
- **It tests single `PUT` requests.** Atlas sends every conditional write as a single `PutObject`, never as `CopyObject` or `CompleteMultipartUpload`, so a backend that enforces the conditions only on `PutObject` is sufficient.
- **A probe that cannot run does not block.** If the bucket does not exist yet, the credentials may not write, or a request fails, the command logs a warning and continues without the check. After a failed request the next conditional write probes again, so a storage outage never becomes a lasting refusal.

### When you take over writer exclusion

`ATLAS_SINGLE_WRITER=1` in the CLI, or `ownerExclusion` in the SDK, runs Atlas on a backend that cannot enforce conditional writes. Both are explicit, both are reported by `atlas storage-check` and `checkStorage()` as `writerExclusion`, and the CLI prints a warning on every run. They move the lock from the bucket to whoever runs Atlas:

| Threat | Default mode | Opt-in mode |
| --- | --- | --- |
| Two operations on one owner in one process | Refused by the lease | Refused by the in-process or host exclusion |
| Two operations on one owner in two processes | Refused by the lease | Refused only if the host exclusion covers both processes. Under `ATLAS_SINGLE_WRITER`, not detected: you must not run two processes per tenant |
| Two first runs creating different data keys | Refused by create-only `PUT` | Refused only while the tenant scope is exclusive across processes. A second process without the exclusion could store a different key, and data it encrypted would be unreadable |
| Concurrent identity registry updates from two processes | Merged by compare-and-swap | Can drop entries one process just added. They are recorded again by the next backup that looks the user up |
| A writer replacing a create-only object | Refused by the backend | Refused when Atlas sees the object first, and reported as a lost race when the replacement lands before Atlas reads its write back. A replacement after that is not detected |

What does not change: encryption, key wrapping, Object Lock retention, the read-back of every manifest, index, and cursor, and the restore-time integrity checks. A backend that silently loses or rewrites objects is still caught by `verify` and at restore, as in the default mode.

Treat the opt-in as a statement about your deployment. If a second scheduler, a manual run on another host, or a stuck container can write the same tenant, use the default mode on a backend that enforces conditional writes instead. A compromised or misbehaving host exclusion can let two runs write one owner; it cannot read or decrypt anything, because it never receives storage credentials, keys, or data.

## S3 permissions by command class

Read and write storage access are separate, so an operator who only browses never needs write credentials:

| Command class | Required S3 actions | Provisioning |
| --- | --- | --- |
| Read-only: `outlook list`, `outlook read`, `outlook status`, `outlook verify`, `onedrive list`, `contacts list`, `calendar list`, `sharepoint list`, `teams list-snapshots`, `teams verify`, `teams status`, `stats`, `list-users` | `s3:GetObject`, `s3:ListBucket` | None |
| Storage usage: `stats storage` | Read-only actions plus `s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`, `s3:ListMultipartUploadParts` | None |
| Restore and save: `restore`, `restore-version`, `save` | Read-only actions. The writes go to Microsoft 365 or a local file, not to the bucket | None |
| Delete: `delete`, `keys rewrap` | Read-only actions plus `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | None |
| Old key wrappers: `keys purge-old-wrappers` | Delete actions plus `s3:ListBucketVersions`, `s3:GetObjectVersion` | None |
| Provisioning: `backup`, `teams backup` | All of the above plus `s3:CreateBucket` and lifecycle or lock configuration | Yes |

Only the provisioning row creates a bucket or a new data key, and only a derived `atlas-<tenant-id>` bucket: a [bucket override](#bucket-override) is never created. `keys rewrap` writes `_meta/dek.enc` only as a new wrapper of the existing data key, never a new key. Every other command fails with `No backups found for tenant <id>` (exit `7`) when the tenant has no bucket, or, for commands that decrypt, no data key. A mistyped tenant ID or profile therefore leaves nothing behind.

Give monitoring and audit principals the read-only row only. They never need `s3:CreateBucket`; a principal that holds it from Atlas versions before 2.1.0-beta can have it revoked.

`storage-check` is read-only except for its conditional-write probe, which puts and deletes one object under `_meta/storage-check/`. With read-only credentials the probe reports `not probed` and the rest of the check still runs. Every command that writes runs the same probe once per bucket before its first conditional write, except in an [opt-in writer-exclusion mode](#when-you-take-over-writer-exclusion), so writing principals need `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucketVersions`, and `s3:DeleteObjectVersion` on that prefix too. Without them the probe is skipped with a warning, and the command runs without that check.

::: details Owner leases and write permissions
Atlas runs one operation at a time per mailbox, drive owner, site, or team. Backups, restores, deletions, and quarantines write, renew, and delete the [owner lease](/operations/storage-layout#owner-leases) for what they act on. A purge and a key re-wrap do the same with the tenant lease. A principal that may write but not delete, for example under a policy that denies `DeleteObject` on `_meta/*`, marks the lease released in place with a conditional write instead. A restore whose credentials cannot write the lease runs without one and logs that concurrent-run protection is off, so read-only restore credentials keep working at the cost of that protection. In an [opt-in writer-exclusion mode](#when-you-take-over-writer-exclusion) no lease object exists, and a restore holds the in-process or host exclusion whatever its credentials.

The lease keeps Atlas runs apart. It is not an access control: it is unencrypted and unauthenticated, so anyone who can write to the bucket can remove or forge it, and anyone who can do that can already delete the backups.
:::

## Bucket override

`ATLAS_S3_BUCKET`, a profile's `bucket`, or the SDK's `s3Bucket` replace the derived `atlas-<tenant-id>` bucket name. They exist so a provider replica under another name, as AWS S3 and Backblaze B2 require, can be verified and restored from. See [Bucket override](/configuration#bucket-override).

The override must name a copy of the same tenant's bucket. Only the name changes: the tenant ID is still part of the scrypt salt, so the wrapped data key in the copy opens with the same passphrase and tenant ID as the primary, and with nothing else. Object ciphertext is bound to its object path, not to the bucket name, so a byte-for-byte copy decrypts under any name.

| Risk | What Atlas does |
| --- | --- |
| An override applied to a second tenant in the same run | Every bucket resolves through one resolver bound to the tenant the override was configured for. `-t`, `delete --purge -t`, and multi-tenant `keys` runs refuse any other tenant under `ATLAS_S3_BUCKET` or `s3Bucket`, with exit code `6` or a `failed` row |
| A cross-tenant restore writing into the destination's bucket | The override stays bound to the source tenant. The destination tenant is never given it |
| A typo in the name | Atlas never creates an overridden bucket. A missing one fails with `ATLAS_CONFIG_INVALID`, so no second store with a fresh data key appears beside the real one |
| An override pointing at another tenant's bucket | Unwrapping that bucket's data key fails with `ATLAS_WRONG_PASSPHRASE`, because the KEK is derived from this tenant's ID, and a backup fails the same way before it writes data. See below for a bucket with no key |
| Two profiles of different tenants naming the same bucket | Refused with `ATLAS_CONFIG_INVALID` |
| A top-level `bucket` shared by every profile | Refused at load. A bucket belongs to one tenant |

::: warning A bucket with no data key is treated as new
If the override names a bucket without `_meta/dek.enc`, the first backup writes this tenant's key there.
:::

Verify and restore from a copy with read-only credentials scoped to that bucket. Read commands write nothing to it: when they look up an email Atlas has not recorded, the bucket refuses the identity registry write, and Atlas skips it and logs it at debug level. With write credentials the same lookup records the user. A restore may still try to write its owner lease and continues without it, as described under [S3 permissions by command class](#s3-permissions-by-command-class).

## Replicas

A replica made by your storage provider or a copy tool holds the same ciphertext and the same wrapped data key (`_meta/dek.enc`), and opens with the same passphrase. Atlas does not copy data itself, so it holds no credentials for the replica during backups.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Passphrase leaks | Every replica is readable by whoever also holds its S3 keys | Rotate with `atlas keys rewrap`. The new wrapper reaches the replica as a new version. Purge the old `_meta/dek.enc` versions on the replica too |
| Primary S3 keys stolen | The attacker can delete on the primary | Separate replica credentials, delete-marker replication off, Object Lock on the replica bucket |
| Replica S3 keys stolen | The attacker reads ciphertext only, and can delete unless Object Lock prevents it | Read-only keys for the Atlas host. Object Lock retention |
| A backup pointed at the replica | Writes fork the history | Give the Atlas host read-only keys on the replica, so the first write fails |

A versioned replica keeps the old wrappers after a rotation. AWS S3 replication never replicates the deletion of a specific version, so a version `atlas keys purge-old-wrappers` deletes on the primary stays on the replica. Other providers differ, so check yours. To purge the replica:

- Run `atlas keys purge-old-wrappers --old-passphrase` with `ATLAS_S3_ENDPOINT` and the S3 credentials pointed at the replica, and `ATLAS_S3_BUCKET` when the replica has another name. Add `-y` when the old passphrase is piped on stdin.
- Under `ATLAS_S3_BUCKET` the run covers the selected profile's tenant only, so repeat it per tenant.
- The run writes its tenant lease and deletes versions, so it needs write credentials for that one run, not the read-only keys the Atlas host keeps for the replica.

Otherwise rely on a noncurrent-version lifecycle rule on the replica and accept the window it leaves.

Atlas 6 wrote replication status records under `_meta/replication/`, encrypted with the data key, and a plaintext `_meta/replica.marker` on each replica. Atlas 7 ignores both. See [Legacy Atlas 6 objects](/operations/replication#legacy-atlas-6-objects).

## Configuration file security

::: danger Restrict the config file to its owner
Run `chmod 600` on any config file that contains a passphrase, an S3 secret key, or a client secret. Anyone who can read the file can read the passphrase, and with it the DEK in the bucket. They can also act as every profile listed under `tenants`.
:::

`atlas.config.json` can contain `encryption_passphrase`, the S3 secret key, and the `client_secret` of every profile under `tenants`, in plaintext. On Unix, Atlas checks the file mode at load time and logs a warning when any group or world bits (`0o077`) are set:

```
WARN Config file /home/user/atlas.config.json has overly permissive permissions (mode 0644). Recommended: chmod 600 /home/user/atlas.config.json
```

The check is advisory, so existing deployments do not break. It is skipped on Windows.

Environment variables (`ATLAS_*`) and `.env` files avoid the JSON file, but they are still readable from the process environment and from plaintext dotfiles, which malware checks first.

## Encrypted secure store

`atlas config` stores its settings in `~/.atlas/config.enc`, encrypted with AES-256-GCM in the layout `[iv][tag][ciphertext]`. The store is created with directory mode `0700` and file mode `0600`. Its 256-bit key is random and kept in the OS keyring under service `atlas-cli`, account `config-key`:

| System | Where the store key lives |
| --- | --- |
| macOS | Keychain, through the `security` CLI |
| Linux | libsecret, through `secret-tool`, when the binary is installed |
| Other systems, or no keyring | `~/.atlas/config.key`, with mode `0600`, and a warning |

A disk sweep finds only ciphertext. A modified store file fails authentication at load time and is not used.

**Threat model.** The store defends against offline exfiltration of the file and against unprivileged malware that reads environment variables. It does not defend against malware running as the logged-in user, which can call the keyring the same way Atlas does, or against an attacker with root. On systems without a keyring, the fallback key file is protected only by file permissions. Config values are still never stored in plaintext.

::: details Concurrent writes to the store
Every write replaces the store atomically: Atlas writes a temporary file beside it, flushes it, and renames it over `config.enc`, so a command that reads the store never sees a half-written file. Writes from `atlas config` and `atlas tenants` also take an exclusive lock, `~/.atlas/config.lock`, for the few milliseconds the update runs, so two commands run at once keep both changes. The lock file records the holder's process ID and host name, and a waiting command removes it only when that process no longer runs on the same host. The lock never reads the wall clock, so a clock stepped by NTP or by VM and WSL2 host time sync cannot make a live lock look abandoned.
:::

## Tenant profiles and cross-tenant restore

Every profile's client secret sits in the same encrypted store, protected by one key. Anyone who can unlock the store as the logged-in user can read all of them, so keep a profile only for a tenant whose backups that operator is trusted to manage.

A cross-tenant restore uses two identities. The source profile reads the backup and supplies the storage tenant, S3 credentials, and passphrase. The `--target-profile` app performs the writes in the destination tenant.

- **Grant write permissions narrowly.** The target app needs write permissions in the destination tenant, such as `Mail.ReadWrite` for Outlook or `Files.ReadWrite.All` for OneDrive. Grant them only to the app that restores, and remove them when the restore is finished.
- **The destination tenant does not isolate the backup.** The S3 credentials and the passphrase are shared by every profile, so a run with `--target-profile` has the same access to the bucket as a run with the source profile.
- **Source credentials never write to the destination.** Target owners are looked up through the destination tenant's Microsoft Graph and are never written to the source registry.
- **`ATLAS_*` environment variables never apply to the target profile**, so a stray `ATLAS_CLIENT_SECRET` in the shell cannot change where writes go.
- **On the selected profile they do apply.** A tenant ID in the environment also picks the bucket a command reads, writes, and deletes from, so a leftover `ATLAS_TENANT_ID` can point `--profile` at another tenant's backups. Atlas prints a warning naming the variables whenever they replace a profile value. It refuses with exit code `6`, before any Graph or S3 call, when some of the three are unset and the others change the tenant ID or client ID, since that pairs one tenant's ID with another app's secret. A secret alone only authenticates the profile's own app and is allowed with the warning. See [Configuration](/configuration#tenant-profiles).
- **Check both profile names.** An unknown name in `--profile` or `--target-profile` fails the run, but the name of another stored profile is accepted as written. Confirm both with `atlas tenants list` and read the Tenant and Target tenant lines in the restore banner.

The SDK's [`createTenant`](/reference/sdk#cross-tenant-restore) handle follows the same model. The host supplies the destination credentials, Atlas holds the secret in a private field so logging or serialising the handle never prints it, and the handle takes effect only on a restore that also names an explicit target. The instance's storage credentials and passphrase still read the backup.

## User identity in storage paths

Storage paths use the Entra object ID, not the SMTP address. Mailbox backups namespace `data/`, `attachments/`, and `manifests/` by the owner's object ID. For OneDrive, `atlas onedrive` looks up a user principal name or email passed to `--owner` and uses its object ID. Passing a UUID skips the lookup and must match the user's directory object ID. The SMTP address is recorded only as display metadata on snapshots, inside encrypted data.

A bucket listing therefore does not reveal which email account owns a subtree unless someone can correlate Microsoft Graph IDs. Address-keyed objects written by v5 are not renamed or aliased. They stay under their old prefixes until something deletes them, and Object Lock expiry only makes them deletable. See [Migrating to v6](/migration/v6).

## Teams channel messages are personal data

Channel messages hold personal data: what people wrote, who they addressed, and the files and images they shared. Atlas stores each message version as the object Microsoft Graph returned, with its reply list and `@odata` annotations removed, so the backup holds the same content a channel member can read.

- **Encrypted at rest.** Message blobs, inline images, indexes, shards, and sync checkpoints are encrypted under the tenant DEK with AES-256-GCM. Object names are keyed as described under [What object names reveal](#what-object-names-reveal).
- **App-only read access.** Atlas reads channel messages with the application permission `ChannelMessage.Read.All`. No user signs in, and the permission reaches every team and channel in the tenant, private channels included.
- **Protected API.** Microsoft may require approval before the permission works. See [Microsoft Entra ID setup](/azure-ad-setup#teams-application-permissions).
- **A compromised client secret.** The passphrase protects stored backups only. Anyone holding the client secret can call Microsoft Graph as the app and read live channel messages, replies, and member lists across the tenant. Rotate the secret on a schedule and limit who holds it.
- **Deleted messages stay in older snapshots.** Atlas does not remove a message from snapshots taken before it was deleted in Teams, and later snapshots carry the deleted message forward. Its blobs stay until `atlas teams delete --team` removes the team's data, or `atlas delete --purge` removes the tenant's. Deleting one snapshot removes only its manifest.
- **Reused blobs keep their first retention.** An unchanged thread or file is not uploaded again, so it keeps the Object Lock retention set when it was first written. A later run does not extend it.

## Storage request events

An SDK host can pass `onStorageRequest` to receive one event per S3 request (see [Storage request events](/reference/storage-request-events)). Hosts often export these to metrics systems that are less protected than the backup bucket, so the event carries only values that identify nothing:

| Contained | Never contained |
| --- | --- |
| S3 command and SDK method names | Object keys, listing prefixes, upload IDs |
| `workload` and `keyClass`, from an allowlist over the leading key segments | Bucket names, which contain the tenant ID |
| Timings, attempt count, retry delay, payload byte count, HTTP status, S3 error code | Tenant, mailbox, owner, or site IDs, content hashes |

Keys are never classified by matching their contents. A known leading segment such as `data` or `manifests` maps to a class, and anything else becomes `other`, so an unexpected key layout cannot leak an identifier into a label.

The observer runs inside the Atlas process. Atlas catches thrown errors and rejected promises, so a faulty observer cannot fail a backup, but an observer that blocks the event loop or keeps event objects can still affect the process. Byte counts are ciphertext sizes, so over many requests they reveal the size distribution of stored objects. The storage operator can already see that distribution, but treat exported metrics accordingly.

## Erasure

An erasure request answered incorrectly is a compliance failure that looks like success, so Atlas treats deletion as a security control.

::: danger Retained objects remain until retention expires
Object Lock retention is enforced by the storage backend, and Atlas cannot shorten it. A purge reports locked objects as retained, and the data stays readable with the tenant key until their retain-until date. Plan erasure timelines around the longest retention period in use.
:::

### Versions are part of the data

Every delete removes each object and its noncurrent versions, addressed by version ID. On a versioned bucket, a `DeleteObject` without a version ID only writes a delete marker: the object disappears from listings, but its plaintext stays reachable through `GetObject?versionId=`. Atlas sweeps delete markers too, but does not count them as erased data, because removing one uncovers versions instead of destroying them.

### A tenant purge sweeps the bucket

`atlas delete --purge` lists the whole bucket instead of a fixed list of prefixes, so a newly added workload cannot be missed and the purge never erases less than it reports. The encrypted DEK is deleted last, and only after the sweep reports nothing remaining. Deleting the key first would leave ciphertext that could neither be restored nor reported as erased.

The purge and the key re-wrap take a tenant lease first, so a backup, restore, deletion, or quarantine cannot write into a bucket being erased, and a purge cannot start while an owner operation runs. Both sides check the other's lease after writing their own, so the two cannot both proceed. A process killed during the purge leaves the lease behind for 10 minutes, after which it stops blocking. The purge removes the lease last, with its versions, so an erased bucket holds no lease object.

### Per-user erasure is not available for Teams

Atlas cannot erase one person's Teams messages. Each message version is its own blob, but Atlas has no operation that removes a single blob: every snapshot that lists a message references its blob, and a deleted message stays in older snapshots through its `kept` version. `atlas teams delete -s` removes a manifest and leaves its blobs in place, because later snapshots can reference them. `atlas teams delete -y` removes the team's blobs, unless Object Lock retains them. An erasure request for one person therefore needs the whole team removed, or the data handled outside Atlas.

### Retained or failed

| Outcome | When | What it means |
| --- | --- | --- |
| **Retained** | The backend names Object Lock as the reason. AWS returns `AccessDenied: Access Denied because object protected by object lock`, MinIO returns `InvalidRequest: Object is WORM protected and cannot be overwritten` | The object becomes deletable when retention expires |
| **Failed** | Anything else, including a missing `s3:DeleteObjectVersion` permission, an unreachable endpoint, or a bucket policy | Nothing is scheduled to remove it. Fix the cause and rerun |

Atlas classifies uncertain cases as failures. An IAM gap reported as retained would suggest an erasure is scheduled when nothing is: a false alarm costs an investigation, a false all-clear costs the erasure.

### Retention is stamped per object

Every workload locks only the backup data a run with `--retention-days` writes, by sending `ObjectLockMode` and `ObjectLockRetainUntilDate` on each `PutObject`, `CopyObject`, and `CreateMultipartUpload`. Atlas never sets a bucket default retention: a default would lock every write in the bucket, including runs that did not ask for immutability, so the erasure exposure would exceed what any operator requested.

Within a run, content, manifests, Teams indexes and shards, and run version indexes are locked. Delta cursors, checkpoints, snapshot summary indexes, Outlook pointers, leases, and the staging upload for a large file are not. Each state repository opts out by name, and the opt-out applies to a plain `PutObject` only, so a write that forgets to choose stays locked. See [What Object Lock covers](/operations/immutability#what-object-lock-covers) for why a lock on state protects nothing.

A bucket backed up by OneDrive or SharePoint with `--retention-days` on Atlas before 6.1.0 may still carry a bucket default retention, which keeps locking objects that should not be locked. `atlas storage-check` reports a default when it finds one. Remove it as described in [Removing a bucket default retention](/self-hosting/storage#removing-a-bucket-default-retention). Objects already stamped keep their retain-until date either way.

Per-object stamping also bounds what a compromised S3 credential can do:

- A credential with write access can add new locked objects, which cost storage until they expire, but cannot shorten a lock already written.
- A `GOVERNANCE` lock can be shortened only by a principal that holds both `s3:PutObjectRetention` and `s3:BypassGovernanceRetention` and sends the request with the bypass header. An audit of the bypass permission alone is incomplete.
- A `COMPLIANCE` lock cannot be shortened by any principal, including the account owner.

## Backup fidelity

Integrity checks prove that archived bytes match what Atlas stored. Fidelity is about which bytes Atlas stored in the first place, which decides whether an archived message keeps evidentiary value after the mailbox is gone.

| Artifact | Fidelity |
| --- | --- |
| Archived object, and the `.eml` that `atlas outlook save` writes for a MIME entry | **Byte-exact**. The RFC 5322 message as Exchange received it |
| `.eml` for a legacy JSON entry | **Reconstructed** from the stored JSON at export time |
| Message recreated by `atlas outlook restore` | **Reconstructed** from the archived MIME. The original `Received` chain is not carried over |
| Snapshots taken before MIME storage | **Reconstructed** from Microsoft Graph's JSON projection of about 24 selected fields |

When you need the original bytes for a legal hold, forensic review, or DKIM check, use `atlas outlook save`. It never touches the live mailbox.

### The archived object is the original message

Each new or changed message is fetched as RFC 5322 MIME with `GET /users/{id}/messages/{id}/$value`, and those bytes are stored as the canonical object. There is no `--fidelity` flag: MIME is the only format for new snapshots, so the weaker format cannot be selected by accident.

| Preserved in stored MIME | What it answers |
| --- | --- |
| `Received:` chain | Chain of custody: which servers handled the message, in what order |
| `Authentication-Results`, `DKIM-Signature` | Whether the message is authentic. DKIM verifies only against the original bytes |
| `In-Reply-To`, `References` | Threading in any mail client |
| Multipart structure and transfer encodings | Byte-level attestation |
| S/MIME signed and encrypted payloads | Signature verification and decryption |
| Custom `X-` and mailing-list headers | Gateway, DLP, and list-server annotations |

Attachments are stored inside the MIME message, which has two costs. Attachment content is not deduplicated across messages, so a file sent to a list is stored once per message. Base64 inside MIME adds about one third more bytes.

If Microsoft Graph cannot return MIME for an item, that single message is stored as legacy JSON instead of being skipped. A MIME request that fails transiently, such as throttling or a `5xx` that outlasts the retries, also stores the JSON form, but the run exits 2 and the next run fetches the message again for its MIME. See [Original MIME retrieval](/operations/delta-sync#original-mime-retrieval). Each manifest entry records its format: entries with `payload_format: "mime"` hold original bytes, and entries without the field hold legacy JSON. `save`, `read`, `restore`, and `verify` handle both formats in one snapshot.

On the JSON path, attachments are separate objects, and all three Graph types are captured:

| Graph type | What Atlas stores |
| --- | --- |
| `fileAttachment` | The file bytes, inline or fetched from `/$value` |
| `itemAttachment` | The item's bytes from `/$value`: MIME for a message, iCal for an invite, vCard for a contact |
| `referenceAttachment` | The link as a one-line `text/uri-list`. Microsoft Graph returns `405` for a fetch, so there are no bytes |

The content type comes from the bytes that arrive, not the attachment's name, so an invite mislabeled as mail does not open as broken mail. A reference attachment points at a file in OneDrive or SharePoint, which those workloads back up separately. Unrecognized attachment types are recorded with their metadata and a warning.

::: warning Older JSON snapshots may lack attachment content
Before MIME storage, Atlas kept only `fileAttachment` on the JSON path and discarded the other types silently, while still setting `has_attachments`. Snapshots from that period can claim attachments whose content was never captured. Treat them with suspicion.
:::

### Restore reconstructs messages

`atlas outlook restore` parses the archived MIME and recreates each message through Microsoft Graph's JSON create path. The result is normal mail with its original timestamps, without the original `Received` chain. Atlas does not import MIME back into Exchange, because Graph's MIME import always marks the created message as a draft (`isDraft: true`), and no header or property clears that flag.

| Restored as | Taken from |
| --- | --- |
| Subject, body, addresses, `internetMessageId` | The matching headers and parts. Bcc survives on Sent Items copies |
| Received and sent times | `Date` |
| Importance | `Importance`, or `X-Priority` (1 and 2 high, 3 normal, 4 and 5 low) |
| Categories | `Keywords`, where Exchange wrote them |
| Threading | `In-Reply-To`, `References`, `Thread-Index`, set as MAPI properties, because Graph's create call accepts only `x-` headers |
| Reactions | Not in the MIME. Captured separately at backup and written back as the same MAPI properties |
| Follow-up flag | Not in the MIME, which carries at most `X-Message-Flag`. Status (`flagged` or `complete`) with start, due and completed dates, recorded from the item's `flag` during incremental backup |
| Pin | Not in the MIME. The renew times `SystemTime 0x0F02` and `0x0F01`, captured with the reactions and written back unchanged |
| Attachments, inline or regular | The body parts. Inline means `Content-Disposition: inline`, or no disposition with a matching `Content-ID`. The calendar data of a meeting message is not an attachment, see [Meeting messages](#meeting-messages) |
| Meeting response class, time, and location | The `text/calendar` part of a reply. Requests and cancellations restore as ordinary messages, see [Meeting messages](#meeting-messages) |
| Read state | Always set to read, so a restore does not leave thousands of unread items |

Outlook on the web and new Outlook pin a message by setting both renew times (PidTagReceivedOrRenewTime `0x0F02` and PidTagRenewTime `0x0F01`) to 4500-09-01, which keeps it at the top of a list sorted by date. An unpinned message has no `0x0F01`, and Exchange sets its `0x0F02` to the delivery time a restore writes, so only messages carrying `0x0F01` record anything.

What older or legacy entries restore without:

- **Legacy JSON entries** restore the fields Microsoft Graph returned at backup time, including the flag, reactions, and pin. They have no threading, because those requests never asked for `internetMessageHeaders` or `conversationIndex`, so Outlook groups them by subject.
- **Snapshots taken before reaction capture** restore without reactions.
- **MIME entries taken before flag and pin capture** restore unflagged and unpinned.

Exchange keeps client-written reaction properties byte for byte. The reaction summary names the reacting users and their addresses as they were at backup time, and it is stored in the encrypted manifest alongside the subject and sender.

### Meeting messages

A meeting request, response, or cancellation is a message that Exchange built a meeting item from. In MIME, the meeting data travels as a `text/calendar` part, normally beside the plain and HTML body inside the same `multipart/alternative`. Exchange reads that part into the meeting properties and does not list it as an attachment.

| Source item | Restored as |
| --- | --- |
| Meeting response (accepted, declined, tentative, or a new time proposal) | A meeting response with its meeting time and location. Atlas sets the message class (`String 0x001A`) to `IPM.Schedule.Meeting.Resp.Pos`, `.Neg`, or `.Tent`, and Microsoft Graph returns the item as `eventMessageResponse` |
| Meeting request or cancellation | An ordinary message. Microsoft Graph answers `500 ErrorItemSavePropertyError` when a message is created with, or changed to, `IPM.Schedule.Meeting.Request` or `IPM.Schedule.Meeting.Canceled` |

Atlas reads the answer of a response from its calendar part the way Exchange does: the participation status (`PARTSTAT`) of the first attendee of a `REPLY` decides between accepted and declined, any other status is tentative, and a `COUNTER` is tentative.

A restored response also says which meeting it answers. Atlas reads the start, the end, and the location from the same calendar part and writes them as appointment properties, which Microsoft Graph returns as `startDateTime`, `endDateTime`, `isAllDay`, and `location`.

| Time in the calendar part | Restored |
| --- | --- |
| UTC (`DTSTART:20250310T090000Z`) | As written |
| Local time with a `TZID`, and that zone's `VTIMEZONE` block in the same part | Converted with the block's own daylight saving rules. Exchange and Outlook write this form, under Windows zone names such as `W. Europe Standard Time` |
| All-day date (`DTSTART;VALUE=DATE:20250310`) | Midnight in the zone of the part's only `VTIMEZONE` block, or midnight UTC when the part has no block or several. This is where Exchange places it |
| Local time with a `TZID` and no block, local time with no zone, a `DURATION` in place of `DTEND`, or a zone rule other than a yearly first to fourth, or last to fourth-last, weekday of a month | Not restored. The response keeps its class and location |

Atlas uses the zone rules the sender wrote into the message, not a time zone database, and leaves a time out when it cannot be certain of it. A wrong time on a restored item is worse than none. Exchange resolves some of the forms in the last row by looking the zone name up or by assuming UTC. Atlas does not guess along.

A restored response is also tied to its meeting again. Atlas rebuilds the meeting's global object ID, the property Exchange keys a meeting on, from the `UID` in the calendar part: an Outlook `UID` is the ID itself in hex, and any other `UID`, such as one from Google Calendar, is wrapped the way Exchange wraps it on delivery. The ID does two things:

- **It links the response to the meeting.** Where the meeting still exists in the calendar, Microsoft Graph resolves the restored response to it, as it does for the original.
- **It keeps the meeting details through a later backup.** Exchange writes the time and location into the MIME of a meeting message only when the item has this ID. A restored response is therefore backed up again complete, and restores complete from that backup too.

Restoring an old answer does not replay it. In a live test, restored responses that disagreed with the attendee's current answer, some dated before it and some after, left the meeting's attendee tracking as it was.

What a restored meeting message does not carry:

- **Recurrence.** A response to a recurring meeting restores with the time of the calendar part and reads back as a single instance.
- **The meeting link, when the calendar part does not name its meeting with certainty.** That is a part with no `UID`, or a response about one occurrence of a series whose `RECURRENCE-ID` is not a local time with a `TZID`. The response then restores with its class, time, and location, and points at no meeting.
- **The calendar part.** Atlas leaves out a `text/calendar` part that has no `Content-Disposition: attachment` when it is a child of `multipart/alternative`, or when it has no file name and is the part the meeting was built from, or an exact copy of it. Uploading such a part would add a file named `attachment` that the source message never showed.

What still restores as an attachment:

- **Named calendar files.** A calendar part sent with `Content-Disposition: attachment` or under a file name, such as the `invite.ics` Google Calendar adds, keeps its name. Exchange hides some of these as duplicates of the meeting data, so a restored message can show one calendar file more than its source.
- **A calendar part that is the only body.** With no plain or HTML body, the calendar part is the only copy of what the message shows, and Atlas keeps it.

The stored MIME is untouched, so [`atlas outlook save`](/reference/cli#atlas-outlook-save) exports the original message with every calendar part. Legacy JSON entries record no calendar part, and a meeting message among them restores as an ordinary message.

### Content Microsoft 365 will not release

Some drive content cannot be backed up because the service blocks the download. Malware-quarantined files are the main case.

Atlas reads the Microsoft Graph `malware` facet during incremental backup and skips quarantined items without attempting the download. Each skipped item is added to the drive's list of failed files and reported on every run. The run is marked `UNHEALTHY` and exits non-zero, so you can always see which files are missing and why.

- **The quarantined file is not in the backup.** A restore cannot produce a file the service never released. Clean or release the file in Microsoft 365 first if its content matters.
- **Retrying does not help.** A quarantine is a policy state, and attempting the download makes Microsoft Graph abort the transfer instead of returning a clean 403.

::: warning Sensitivity labels are not captured
Atlas does not record Microsoft Purview sensitivity labels or IRM protection state on drive items. Labeled files that Microsoft Graph serves are backed up as ciphertext, but the label is not stored, so a restored copy loses its classification. Treat restored content as unclassified until it is relabeled.
:::

## Recoverable Items and legal hold

```bash
atlas outlook backup -m user@example.com --include-recoverable-items
```

`--include-recoverable-items` also backs up the Exchange Recoverable Items subtree (the "dumpster"). It is off by default, and enabling it changes what a snapshot means legally as well as what it costs.

A message that arrives and is hard-deleted between two backups never appears in an incremental backup. Its only copy is in `Deletions` or `Purges`, and it is lost for good once Exchange's retention window expires. This option is the only way a backup can cover deletions that happen between runs.

| Folder | Captured |
| --- | --- |
| `Deletions`, `Purges`, `DiscoveryHolds`, `SubstrateHolds` | Yes, as MIME, with the same encryption and layout as ordinary mail |
| `Versions`, `Calendar Logging`, `Audits` | No. The run reports each skipped folder by name |

`Purges`, `DiscoveryHolds`, and `SubstrateHolds` hold content only because a litigation hold, In-Place Hold, or retention policy kept it. The subtree is read with the same `Mail.Read` permission as ordinary mail, so the option grants no new access.

::: warning Hold-retained mail becomes a second copy
A copy of held mail in your storage lives outside the Microsoft 365 retention machinery and outside whatever hold kept it there.

- **The copy outlives the hold.** Releasing a litigation hold does not touch the Atlas snapshot. Delete the copy with `atlas outlook delete` when your retention schedule requires it.
- **The copy is discoverable.** Content in your bucket can be compelled from your bucket, even after it is gone from the tenant.
- **Object Lock makes it undeletable on purpose.** A snapshot written with `--retention-days` cannot be deleted before retention expires, including by you. Combining Object Lock with purged mail is a deliberate decision.
:::

Entries are marked in the manifest, so the snapshot shows which content came from Recoverable Items. Restore excludes marked entries unless `--include-recoverable-items` is passed to `restore` or `save`. Microsoft Graph has no path back into Recoverable Items, so restored items appear as normal visible mail. A restored purged message becomes live again.

## In-Place Archive is out of scope

Atlas backs up the primary mailbox. An In-Place Archive (also called Online Archive) is a separate store, and Atlas does not back it up. The **`Archive` well-known folder**, used by Outlook's Archive button, is in the primary mailbox and is backed up normally.

Microsoft Graph does not expose archive mailboxes. Microsoft's [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) states that the API does not support accessing in-place archive mailboxes on Exchange Online or Exchange Server. Every Atlas sync path is built on that API, so no folder ID or query parameter reaches the archive.

::: warning Retention policies can move mail out of scope
A retention or MRM policy that moves mail to the archive after a set age removes that mail from backup scope, oldest mail first, which is often the most relevant for compliance. When a policy moves a backed-up message, the folder's incremental backup reports it as removed. If you prune old snapshots, that message can age out while its only copy sits in an archive Atlas cannot read.
:::

`atlas outlook mailboxes` warns about affected mailboxes and shows a `Has Archive` column:

```
[!] 2 mailbox(es) have an In-Place Archive (Online Archive), which Graph cannot read
    and Atlas does not back up:
      alice@example.com
      bob@example.com
```

The column comes from the [mailbox usage report](https://learn.microsoft.com/en-us/graph/api/reportroot-getmailboxusagedetail?view=graph-rest-1.0), which requires the optional `Reports.Read.All` permission. Without it, the column shows `--`, meaning unknown. Atlas does not report archive coverage it cannot confirm.

To protect archive content, move it back to the primary mailbox or adjust the retention policy first. Microsoft's [mailbox import and export APIs](https://learn.microsoft.com/en-us/graph/mailbox-import-export-concept-overview) do cover archives, but they use a job-based model with separate `MailboxImportExport.*` permissions, so they do not replace per-folder incremental backup.

## What a drive restore rebuilds, and what it cannot

A restored file contains the original bytes, verified against the manifest checksum. Other document properties differ:

| Property | Captured | Restored |
| --- | --- | --- |
| File content | Yes | Yes, byte for byte |
| Original created and modified times | Yes | Yes, through the `fileSystemInfo` facet |
| `createdBy` and `lastModifiedBy` | Yes | No. Kept for audit only |
| Version authors | Yes | No. Kept for audit only |
| Item sharing (grants and links) | Yes | Only with `--restore-permissions` |
| Sharing link URLs | No | No. A recreated link gets a new URL |
| Site and library permissions | No | No |
| Folder colours | Yes | No. Microsoft Graph refuses the write, see [below](#folder-colours-cannot-be-restored) |

::: warning Check sharing after a restore
A restore applies no permission unless `--restore-permissions` is set. Without it a restored item has only the access it inherits at the destination, which can be broader or narrower than the original. **Check the destination's sharing before returning restored content to users.**
:::

**Timestamps.** Microsoft Graph exposes two timestamp pairs. The `driveItem` values are set by the service, so a restored file always shows the restore time there. The `fileSystemInfo` facet holds client-reported values and is writable on upload, so Atlas restores through it. Each manifest entry records both pairs. A resumable upload carries the timestamps with the upload. A small `PUT /content` carries only bytes, so Atlas follows it with a best-effort `PATCH`. If that patch fails, the file keeps restore-time timestamps and the run logs the failure.

**Authors.** Authors are recorded on every manifest entry and version row, so the original author is always available from the backup. Microsoft Graph attributes an upload to the identity that performed it, and rewriting authorship needs separate migration APIs and permissions, so a restored file is authored by the Atlas application identity.

### Sharing links are stored without their URLs

A backup records each file's and folder's own permissions: roles, grantee identities, a link's type and scope, its expiry, and whether it had a password. It never stores a link's `webUrl`, its `shareId`, an invitation URL, or any token. The record is built from an allow-list of fields, so a field Microsoft Graph adds later cannot reach a snapshot either.

An anonymous link's URL is a bearer credential: anyone holding it opens the item without signing in. Microsoft Graph cannot recreate a link with a given URL, so a stored URL would buy nothing on restore and would turn the backup into a store of working share links. An attacker who obtains the bucket and the passphrase learns who had access to what, which is sensitive in itself, but gains no link that opens anything.

### Restoring permissions re-exposes content

A restore applies no permission unless `--restore-permissions` (SDK `restorePermissions: true`) is set, and the summary says how many it left out.

With the flag, every grant and link is applied to the restored copy, wherever it lands. Restoring into another user's drive, a restore folder, or another site therefore shares that copy with the original audience.

| Permission | What a restore does |
| --- | --- |
| Direct grant | Applied through `invite` with `sendInvitation: false` and `requireSignIn: true`. Nobody is emailed, and the grant never works without sign-in |
| Link | Recreated with the same type and scope. An anonymous link becomes a new anonymous link with a new URL, unless tenant policy now forbids anonymous links |
| Password-protected link | Not recreated. The password cannot be read back, and a link without it would be more open than the original |
| Expired link | Not recreated |
| Owner grant, SharePoint site group grant | Recorded, never reapplied |

Permission restore needs the same write permission as file restore, `Files.ReadWrite.All` for OneDrive and `Sites.ReadWrite.All` for SharePoint. Reading permissions during backup needs nothing beyond the existing read permissions.

### Folder colours cannot be restored

A backup records each folder's colour from the `_ColorHex`, `_ColorTag`, and `_Emoji` columns of its list item. Microsoft Graph refuses every write to these columns with `403 accessDenied` (`Field '_ColorHex' is read-only`), on OneDrive and on SharePoint, with `Files.ReadWrite.All` and `Sites.ReadWrite.All` alike. A restore therefore sends no colour write. It reports how many coloured folders it left at the default colour, and that count does not change the exit code.

The remaining route is the SharePoint REST API, which accepts app-only tokens only from a certificate credential. That work is tracked in [#778](https://github.com/wisecom-oy/atlas/issues/778). Reading colours needs nothing beyond the existing read permissions.

### The cost of capturing sharing

Each permission read costs 5 resource units from the tenant-wide SharePoint and OneDrive pool (see [Graph rate limits](./operations/graph-rate-limits.md#resource-unit-costs)). Reading every item of a 100,000-file drive would cost 500,000 RU, about 6.7 hours of the tenant's quota at 1,250 RU per minute.

Atlas avoids that. It asks Microsoft Graph to mark only the items whose own sharing was set or removed (`Prefer: hierarchicalsharing` on the change listing) and reads only those, 20 per `$batch` request. A drive with 2,000 shared items costs about 10,000 RU on its first backup after upgrading, and later backups read only items whose sharing changed. `$batch` saves round trips, not resource units.

### The cost of capturing folder colours

The change listing never carries a folder's colour, so every backup reads the colour of each folder it receives, other than the drive root, 20 folders per `$batch` request. Each read is a single-item GET at 1 resource unit. A folder comes back in the change listing when it changes and when anything inside it changes, so an incremental backup reads roughly one colour per folder above each changed file.

The first full listing of a library with 20,000 folders reads 20,000 colours: 1,000 `$batch` requests and about 20,000 RU, some 16 minutes of the tenant's quota at 1,250 RU per minute. An incremental backup that changes files in 50 folders costs about 50 RU for colours.

## Calendar restore does not notify attendees

A calendar restore sends no invitations, updates, or cancellations to anyone. Atlas removes attendees and the organizer from each created event and writes them as text at the top of the body. Restored events therefore carry no working invitations and no new Teams meeting. Treat the attendee text as a record of the original meeting, not as live invitations.

A restore skips events the target already holds (matching iCalUId, or an event Atlas restored completely earlier), so running it again does not create duplicates. The only event a restore deletes is one an earlier restore created and left incomplete, identified by its pending tag, which it then recreates in full.

## Contacts restore tags what it creates

A contacts restore only creates contacts and folders. It never overwrites or deletes a contact. Each contact it creates carries a single-value extended property, `AtlasSourceContactId`, holding the Exchange id of the source contact, and a rerun skips any entry whose original or tagged copy is already in the target folder.

The tag holds an item id, not contact content, but anyone who can read the mailbox through Microsoft Graph or MAPI can see that a contact was restored and which source item it came from. That includes the target mailbox owner in a restore with `-T`. Removing or changing the tag only makes the next restore create that contact again.

See also: [Immutability and Object Lock](/operations/immutability), [Configuration](/configuration), [Migrating to v7](/migration/v7), [Migrating to v6](/migration/v6), [CLI reference](/reference/cli).
