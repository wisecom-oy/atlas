---
description: Find an Atlas error by stage and apply its fix, with the diagnostics script to run before opening an issue and DEBUG=1 for detailed logs.
---

# Troubleshooting

Find the error you see, read why it happens, then apply the fix. Errors are grouped by the stage where they occur.

Before you open an issue, run `./tools/diagnostics.sh` from the repository root and attach its output. Check the output first: the `ATLAS_S3_ENDPOINT` line must be removed if your endpoint is private. Replace mailbox addresses, file names, and site URLs with placeholders such as `user@example.com` and `contoso.sharepoint.com`.

For more detail on any step, set `DEBUG=1` before the command to enable debug logging.

## Authentication failures

Authentication errors occur before any backup work starts. Atlas signs in to Microsoft Graph with the OAuth 2.0 client credentials flow, so a failure here is a credential or tenant configuration problem, not a network or storage problem.

### AADSTS error codes

| Error code      | Meaning                            | Fix                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS50020`   | Wrong tenant ID                    | Set the profile's tenant ID with `atlas tenants add <name> --tenant-id <id> --client-id <id> --client-secret - --replace`, using the **Directory (tenant) ID** shown in **Microsoft Entra ID → Overview**. `ATLAS_TENANT_ID`, if set, overrides the selected profile for that run.                                                                                                                       |
| `AADSTS700016`  | Wrong client ID or app not found   | Set the profile's client ID with `atlas tenants add <name> --tenant-id <id> --client-id <id> --client-secret - --replace`, using the **Application (client) ID** from **App registrations**. The app must exist in the profile's tenant. `ATLAS_CLIENT_ID`, if set, overrides the selected profile for that run.                                                                                         |
| `AADSTS7000215` | Expired or incorrect client secret | Check the expiry date in **Certificates & secrets**. If the secret has expired, follow the [rotation procedure](/azure-ad-setup#client-secret-rotation). If it has not, confirm you copied the secret **Value**, not the **Secret ID**. Store the new value with `atlas tenants add <name> ... --client-secret - --replace`. `ATLAS_CLIENT_SECRET`, if set, overrides the selected profile for that run. |
| `AADSTS65001`   | Admin consent not granted          | Open **API permissions** for the app registration and select **Grant admin consent for \<tenant\>**.                                                                                                                                                                                                                                                                                                     |

After a fix, run `atlas tenants validate` to re-check the profile's Graph credentials.

For any other AADSTS code, look it up in Microsoft's AADSTS error reference, then check **Microsoft Entra ID → Sign-in logs → Service principal sign-ins** and filter by the application's client ID.

## Graph throttling and transient server errors

### What Atlas does with 429 and 5xx responses

Microsoft Graph returns HTTP 429 (throttled) and occasionally 500, 502, 503, or 504 under load. Atlas retries these automatically:

- It honors the `Retry-After` header when Graph sends one. A value under one second is raised to 1 to 2 seconds. Without the header, a 429 applies a 30-second cooldown.
- It retries up to 12 times with exponential backoff and jitter, capping each delay at 5 minutes. Backoff waits, `Retry-After` waits, and cooldowns share one 24-minute budget of waiting. Time spent inside each request does not count. A `Retry-After` longer than 5 minutes fails the call at once.
- Each attempt times out after 60 seconds, and Atlas aborts the timed-out request before it sends the next one.
- Atlas decides whether to retry from the HTTP status and from Node and undici error codes such as `ECONNRESET` or `UND_ERR_SOCKET`, never from the error message. Message text carries request IDs and item IDs, whose digits could otherwise pass for a status code.
- If retries run out, the failure is recorded in the run summary and the backup continues with the remaining items.

Occasional 429 and 5xx responses during a large first backup need no action.

### Restore writes are sent once

A request that creates something during a restore is not repeated after a 500, 502, 504, a 503 without `Retry-After`, a dropped connection, or a timeout. Graph can commit a create and still lose the response, so repeating it would leave two copies. This covers messages, message and event attachments, events, contacts, mail, contact and calendar folders, and OneDrive or SharePoint files restored with `--conflict rename` or `--conflict fail`.

Such a failure is recorded against the item in the run summary and the restore continues. The item may or may not exist in the target. A Calendar restore skips events already in the target calendar, and a Contacts restore skips contacts whose name and email already match, so re-running the restore fills the gap without duplicating anything. For Outlook, check the reported message in the restore folder before restoring it again.

A 429, or a 503 with `Retry-After`, is still retried: Graph sends these instead of processing the request. Files restored with `--conflict replace`, folder creation on OneDrive and SharePoint, upload sessions, and upload chunks are safe to repeat and keep the full retry policy.

### When to act

| What you see                                  | What it means                                                                    | What to do                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Occasional 429s during a large initial backup | Normal. Graph throttles per application and per mailbox, and Atlas waits it out. | Nothing.                                                                                                                           |
| Repeated 429s that cause folder failures      | Several backups run at the same time and exceed the tenant's Graph capacity.     | Run one `atlas outlook backup -m` per mailbox and stagger the schedules.                                                           |
| 429s on every request from the start          | Another application in the tenant may be using most of the Graph quota.          | Review tenant-wide Graph usage. Contact Microsoft support if the limits look lower than expected.                                  |
| Occasional 500 or 502 responses               | Normal under load. Retried automatically.                                        | Nothing, if the run completes.                                                                                                     |
| Persistent 500 or 502 on the same item        | Retries are exhausted against a server-side fault, not throttling.               | Re-run the backup later. If the failure repeats, open a Microsoft support case with the time of the failure and the affected item. |

### Throughput ceiling

Graph throttling caps throughput even with unlimited bandwidth. For a first full tenant backup, measure the real transfer rate and use it to plan your schedule. See [Scheduling and bandwidth](/self-hosting/scheduling) for sizing guidance.

## OneDrive and SharePoint permission errors

File workload backups need Graph application permissions beyond mailbox access. The permissions for each command are listed in [OneDrive backup](/onedrive-backup) and [SharePoint backup](/sharepoint-backup).

### OneDrive: owner cannot be resolved

Atlas could not find the owner in the tenant.

- Confirm the address passed to `-o` exists in the tenant and has a licensed OneDrive.
- Confirm the application permissions for OneDrive backup are granted with admin consent.

### OneDrive: no drive is provisioned

```
No OneDrive is provisioned for user@example.com.
```

The account exists and its permissions are fine. Microsoft Graph returns 404 for a user who has never opened OneDrive. This is normal for admin and service accounts, and Graph gives the same response for an account that does not exist.

Either sign in to OneDrive once as that user to provision the drive, or leave the account out of the run. Atlas reports this case with the `ATLAS_NOT_FOUND` code (exit `7`), so a script that iterates over a tenant can skip the owner and continue.

A missing permission is a 403 and is reported separately as `ATLAS_AUTH_DENIED` (exit `4`). Do not re-check consent for a 404.

### SharePoint: site cannot be resolved

Graph returned `itemNotFound` for the site URL.

- Confirm the URL is correct and the site has not been deleted or renamed.
- Confirm the application permissions for SharePoint backup are granted with admin consent.
- Use the full URL including `/sites/<SiteName>`. Root site URLs use a different path format.

### SharePoint restore: access denied

Graph returned `accessDenied` during a restore. Restore needs write permission on the target site, in addition to the read permissions used for backup. Add the permission listed for restore in [SharePoint backup](/sharepoint-backup), then grant admin consent.

## S3 connectivity errors

S3 errors stop Atlas from reading or writing backup data. They are configuration problems, not transient failures.

### Endpoint not reachable

```
connect ECONNREFUSED 127.0.0.1:9000
```

Nothing is listening on the configured endpoint.

- Confirm MinIO or your S3-compatible service is running, for example with `docker ps` or `systemctl status minio`.
- Confirm `ATLAS_S3_ENDPOINT` points to the correct host and port.
- If Atlas runs on another machine, confirm the firewall allows TCP on the endpoint port (9000 by default for MinIO).

### Bucket not found

```
NoSuchBucket: The specified bucket does not exist
```

Atlas uses one bucket per tenant and creates it on first use when the credentials allow it. Atlas uses path-style URLs (`http://hostname:9000/bucket-name`), which MinIO and most S3-compatible services require.

If the error persists on AWS S3, check that the region matches the bucket's region and that the credentials belong to the account that owns the bucket. If your credentials cannot create buckets, create the bucket in advance. See [Storage layout](/operations/storage-layout).

### Bucket name is not valid

```
"atlas-Contoso.onmicrosoft.com" is not a valid S3 bucket name: it must be 3 to 63 lowercase letters, digits, dots or dashes.
```

Atlas names each tenant's bucket after its tenant ID, and S3 accepts only lowercase names up to 63 characters. The error is a `ConfigError` (`ATLAS_CONFIG_INVALID`, exit `6`). A backup raises it before any bucket is created, and `atlas storage-check` and the SDK's `validate()` raise it when S3 refuses to look the bucket up. Store the tenant ID in lowercase with `atlas tenants add <name> ... --replace`, or use the tenant GUID when the domain is longer than 57 characters.

An existing bucket keeps working under its name even if S3 naming rules would reject it, so a backend with relaxed naming still serves backups made by an older Atlas.

### Secure config store is locked

```
The secure config store is locked by another Atlas command (~/.atlas/config.lock).
```

Another `atlas config` or `atlas tenants` command held the store lock for more than 10 seconds. Updates normally hold it for milliseconds, so check for a hung command first. If none is running, delete the lock file. Atlas removes a lock by itself only when the process ID recorded in it has exited on the same host, so a lock written from another host, or an empty one, needs deleting by hand.

### Signature mismatch

```
SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.
```

The signature Atlas computed differs from the one the server expects. The cause is usually the keys or the clock.

- Confirm `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY` are correct.
- Remove trailing spaces and newlines from the values in your environment or `.env` file.
- For MinIO, confirm the keys match the root user and password the server was started with.
- Check the clock. S3 rejects requests whose timestamp differs from the server time by more than 15 minutes. Run NTP on both the Atlas host and the S3 server.

## Decryption failures

A decryption failure means the passphrase does not match the one that protected the tenant's data, or the stored key or data is damaged. Atlas never regenerates a key over an existing one, so a damaged key cannot be replaced in place.

### Wrong passphrase

```
Could not unwrap the data key: the passphrase does not match the one this backup was written with, or the wrapped key is damaged.
```

This error has the code `ATLAS_WRONG_PASSPHRASE`. Check that `ATLAS_ENCRYPTION_PASSPHRASE` matches the passphrase used when the tenant was first initialized.

Atlas stores the data key wrapped by the passphrase in the bucket at `_meta/dek.enc`. Changing the passphrase without re-wrapping that key makes the data unreadable. To change it safely:

1. Keep the current passphrase configured.
2. Run [`atlas keys rewrap --new-passphrase`](/reference/cli#atlas-keys).
3. Set `ATLAS_ENCRYPTION_PASSPHRASE` to the new value.

Atlas checks that the new wrapper opens before it replaces the old one, so a failed rewrap changes nothing.

### Damaged key

If the passphrase is correct and the same error persists, `_meta/dek.enc` is damaged. Recover the key from a replica with `atlas rehydrate`. Without a replica, the data encrypted under that key cannot be read.

### Authentication failure on an object

```
AES-GCM authentication failed for <object-key>
```

The authentication tag on an encrypted object does not match its contents. There are three possible causes:

1. **Corruption:** the object changed after it was written. Run the matching verify command to find affected items:
   - `atlas outlook verify -m <mailbox> -s <snapshot-id>`
   - `atlas onedrive verify -o <owner> -s <snapshot-id>`
   - `atlas sharepoint verify --site <url> -s <snapshot-id>`
2. **Wrong key:** the object was written under a different tenant key. This happens when two Atlas instances write to the same bucket.
3. **Tampering:** the object was modified deliberately.

The affected items cannot be decrypted in any of these cases. The other items in the snapshot are unaffected.

A OneDrive or SharePoint restore stops at the first such object with `Atlas code: ATLAS_WRONG_PASSPHRASE` and exit code `5`, rather than skipping it and moving on. With a wrong key every object fails, and a run of skipped files would read as a partial restore instead of a key problem. Files restored before the stop stay in the target. Once verify has confirmed that only a few objects are damaged, restore the rest with `--file-filter`.

## Object Lock errors

Object Lock must be enabled when a bucket is created. Most backends cannot add it to an existing bucket, so a bucket created without it cannot be used for immutable backups.

### Versioning or Object Lock is missing

```
Immutability requested, but bucket versioning is disabled for <bucket>. Enable bucket versioning and Object Lock, or run backup without retention.
```

```
Immutability requested, but Object Lock is not supported or not enabled for bucket <bucket>.
```

The bucket was created without Object Lock, and Atlas never enables it on an existing bucket. On AWS S3, a versioned bucket can be made lock-capable in place with `PutObjectLockConfiguration`, which cannot be undone. On MinIO and other backends that only allow it at creation, create a new bucket with Object Lock enabled and move the tenant to it. See [Bucket provisioning and Object Lock](/self-hosting/storage#bucket-provisioning-and-object-lock) and the legacy bucket migration steps in [Storage](/self-hosting/storage#migrating-a-legacy-bucket).

### Backend rejected the lock mode

```
Backend rejected Object Lock mode <mode> for bucket <bucket>.
```

The S3 backend does not support the requested mode. Use `governance` or `compliance` (see [Immutability and Object Lock](/operations/immutability)) and check the storage backend's documentation.

### Lock not applied at creation

```
Backend rejected Object Lock at creation for bucket "<bucket>" -- created without it.
```

Atlas logs this warning when the backend refuses Object Lock during bucket creation and Atlas falls back to a plain bucket. Immutability does not work on that bucket. Create a bucket with Object Lock enabled instead.

::: tip Pre-flight check
Run `atlas storage-check --lock-mode governance --retention-days 30` before your first immutable backup. It reports whether the bucket is reachable and whether versioning and Object Lock are enabled, so you can fix configuration problems before a backup job runs.
:::

## Restore content errors

### Outlook: message headers exceed 1 MiB

```
<message-id>: The message header block exceeds the 1 MiB limit the MIME parser enforces, so none of the headers could be read.
```

The MIME parser reads at most 1 MiB of headers. A larger block yields no headers at all: no addresses, subject, or date. Atlas does not restore such a message as an ordinary entry, because a message without its headers is not the message that was backed up.

A block this large is usually a distribution list expanded into `To` or `Cc`, or a long `Received` chain. The backup itself is intact. The raw message is stored encrypted and checksum-verified, and `atlas outlook save` writes it to a file that a mail client can open directly.

How the failure is reported depends on the command:

- A mailbox or snapshot restore skips this entry, restores the others, and reports the error. The run exits with code `2` (partial), so the gap is visible.
- A single-message restore (`--message`) fails with exit code `9` (stored content cannot be read).

In the SDK, the error is `UnreadableContentError` with code `ATLAS_CONTENT_UNREADABLE`. It is permanent: retrying reads the same bytes and fails the same way.

### Teams: a snapshot index cannot be read

`atlas teams list-snapshots` names every index it cannot read. Two causes:

- **Newer format** (`ATLAS_FORMAT_UNSUPPORTED`, exit `9`): another Atlas version wrote the index. Upgrade Atlas. The team's backup stops before it writes anything.
- **Damaged or unparseable**: the run exits `2` when the index is newer than the latest readable one. It names the key (`Snapshot <key> could not be read; its channels were not compared`) and warns that the baseline is an older snapshot.

When no readable index exists at all, for example after a bucket wipe with Object Lock-retained legacy manifests, the backup warns `No readable snapshot exists; every channel is read in full`. Once a run writes a readable index, later runs stop at it and do not read the older keys, so they are healthy again. `atlas teams status` and `list-snapshots` still list the unreadable keys. See [Unreadable snapshots](/teams-backup#unreadable-snapshots).

## Backup state errors

### Delta cursor or identity registry cannot be read

```
Could not read the state object at identity-registry.json
```

```
The state object at onedrive/_meta/<owner>/delta.json is corrupt or tampered
```

OneDrive and SharePoint keep a delta cursor per owner or site, and the tenant keeps one identity registry. If one of these exists but cannot be read, the run stops before it writes anything. Treating the object as missing would re-download the whole drive, lose deletion tracking, and overwrite the stored state. For the registry, that would erase the cached identities of departed users.

The two messages mean different things:

- **`Could not read the state object`** is a storage failure (`ATLAS_STORAGE_FAILURE`, exit `1`). Retry once the bucket responds.
- **`is corrupt or tampered`** means the object failed AES-256-GCM authentication or JSON parsing (`ATLAS_CONTENT_UNREADABLE`, exit `9`). Retrying does not help. Treat it as possible tampering first.

To recover a damaged delta cursor, restore an earlier version from bucket versioning, or delete the cursor to force a full enumeration on the next run. For a damaged `identity-registry.json`, restore an earlier version and do not delete the object. The registry is the only record of departed users that Graph no longer resolves, so deleting it makes their backups impossible to find by address.

### Identity registry kept changing

```
The identity registry at identity-registry.json changed on every one of 8 write attempts; too many writers are registering at once
```

Several runs for the same tenant were registering users at the same moment, and this run lost the compare-and-swap race on every attempt. Nothing was overwritten: each lost attempt re-reads the registry before trying again. The error is `StorageError` (`ATLAS_STORAGE_FAILURE`, exit `1`) and is safe to retry. If it recurs, start fewer runs at once for that tenant. See [Storage](/self-hosting/storage#the-identity-registry-under-concurrent-runs).

### Graph credentials belong to another tenant

```
john.doe@example.com is not in the identity registry of tenant <source>, and the configured Graph credentials belong to tenant <destination>. Using that tenant's answer without recording it; pass the Entra object ID to name a user of the backed-up tenant.
```

`-t` names a tenant other than the one the Graph credentials sign in to, for example when the destination tenant's credentials were exported by hand to restore into it. Graph then describes the other tenant, so Atlas resolves addresses from the backed-up tenant's registry and never writes to it. Writing would record a same-address user in the other tenant as a recycled email and point the address at a user who has no backups. A restore with `--target-profile` keeps the two tenants apart and does not hit this case.

The warning appears when the address is not in the registry. The object ID Graph returned belongs to the other tenant, so a lookup for a backed-up owner finds no snapshots. Pass the owner's Entra object ID instead, which `atlas list-users -t <source>` lists. Restore targets (`-T`, `--target-owner`) always resolve through Graph alone, so they name users of the tenant being restored into.

## See also

- [Getting started](/getting-started)
- [Concepts](/concepts)
- [CLI reference](/reference/cli)
- [Security](/security)
- [Microsoft Entra ID setup](/azure-ad-setup)
