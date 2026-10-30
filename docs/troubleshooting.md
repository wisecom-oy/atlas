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

| Error code      | Meaning                            | Fix                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS50020`   | Wrong tenant ID                    | Set `ATLAS_TENANT_ID` to the **Directory (tenant) ID** shown in **Microsoft Entra ID → Overview**.                                                                                                                                                       |
| `AADSTS700016`  | Wrong client ID or app not found   | Set `ATLAS_CLIENT_ID` to the **Application (client) ID** from **App registrations**. The app must exist in the tenant named by `ATLAS_TENANT_ID`.                                                                                                       |
| `AADSTS7000215` | Expired or incorrect client secret | Check the expiry date in **Certificates & secrets**. If the secret has expired, follow the [rotation procedure](/azure-ad-setup#client-secret-rotation). If it has not, confirm you copied the secret **Value**, not the **Secret ID**.                   |
| `AADSTS65001`   | Admin consent not granted          | Open **API permissions** for the app registration and select **Grant admin consent for \<tenant\>**.                                                                                                                                                    |

For any other AADSTS code, look it up in Microsoft's AADSTS error reference, then check **Microsoft Entra ID → Sign-in logs → Service principal sign-ins** and filter by the application's client ID.

## Graph throttling and transient server errors

### What Atlas does with 429 and 5xx responses

Microsoft Graph returns HTTP 429 (throttled) and occasionally 500, 502, 503, or 504 under load. Atlas retries these automatically:

- It honors the `Retry-After` header when Graph sends one. Without it, a 429 applies a 30-second cooldown.
- It retries up to 12 times with exponential backoff and jitter, capping each delay at 5 minutes. The full retry budget is about 23 minutes.
- If retries run out, the failure is recorded in the run summary and the backup continues with the remaining items.

Occasional 429 and 5xx responses during a large first backup need no action.

### When to act

| What you see                                       | What it means                                                                    | What to do                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Occasional 429s during a large initial backup      | Normal. Graph throttles per application and per mailbox, and Atlas waits it out. | Nothing.                                                                                                                             |
| Repeated 429s that cause folder failures           | Several backups run at the same time and exceed the tenant's Graph capacity.     | Run one `atlas outlook backup -m` per mailbox and stagger the schedules.                                                              |
| 429s on every request from the start               | Another application in the tenant may be using most of the Graph quota.          | Review tenant-wide Graph usage. Contact Microsoft support if the limits look lower than expected.                                    |
| Occasional 500 or 502 responses                    | Normal under load. Retried automatically.                                        | Nothing, if the run completes.                                                                                                       |
| Persistent 500 or 502 on the same item             | Retries are exhausted against a server-side fault, not throttling.               | Re-run the backup later. If the failure repeats, open a Microsoft support case with the time of the failure and the affected item. |

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

## Object Lock errors

Object Lock must be enabled when a bucket is created. Most backends cannot add it to an existing bucket, so a bucket created without it cannot be used for immutable backups.

### Versioning or Object Lock is missing

```
Immutability requested, but bucket versioning is disabled for <bucket>. Enable bucket versioning and Object Lock, or run backup without retention.
```

```
Immutability requested, but Object Lock is not supported or not enabled for bucket <bucket>.
```

The bucket was created without Object Lock. Create a new bucket with Object Lock enabled and move the tenant to it. See the legacy bucket migration steps in [Storage](/self-hosting/storage).

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

## See also

- [Getting started](/getting-started)
- [Concepts](/concepts)
- [CLI reference](/reference/cli)
- [Security](/security)
- [Microsoft Entra ID setup](/azure-ad-setup)
