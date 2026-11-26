---
description: Find the message or exit code you see, learn what it means, and follow the steps to fix it.
---

# Troubleshooting

Find the message or exit code you see. Each entry says what it means and what to do. Entries are grouped by the stage where the failure occurs.

```bash
DEBUG=1 atlas outlook backup -m user@example.com   # debug logging for any command
./tools/diagnostics.sh                             # environment report to attach to an issue
```

Before you open an issue, run `./tools/diagnostics.sh` from the repository root and attach its output. Read it first: remove the `ATLAS_S3_ENDPOINT` line if your endpoint is private, and replace mailbox addresses, file names, and site URLs with placeholders such as `user@example.com` and `contoso.sharepoint.com`.

[Exit codes and whether to retry](/operations/reliability#exit-codes-and-whether-to-retry) says which exit codes a rerun can fix.

## Authentication failures

These occur before any backup work starts. Atlas signs in to Microsoft Graph with the OAuth 2.0 client credentials flow, so a failure here is a credential or tenant configuration problem, not a network or storage problem.

When Microsoft Entra ID refuses the token request, the command exits `4` with `Atlas code: ATLAS_AUTH_DENIED` and prints Entra's answer as the cause, for example `Cause: invalid_client: Error(s): 7000215`. Atlas does not retry a refusal, because Entra gives the same answer until the credentials change. A token request that gets no answer, or a `429` or `5xx` from Entra (for example `AADSTS90033`, a transient error), is retried through the [retry budget](/operations/reliability#microsoft-graph-requests), at least 60 s apart, and ends in exit `3` with `ATLAS_GRAPH_UNAVAILABLE` if Entra does not recover. Check Microsoft 365 service health and run the command again later.

When Microsoft Graph answers `401 InvalidAuthenticationToken` to an issued token, Atlas requests a new token and repeats the call once. A `401` that persists after that exits `4` with `ATLAS_AUTH_DENIED`. Check **Microsoft Entra ID → Sign-in logs → Service principal sign-ins** for the application, and Microsoft 365 service health for an incident affecting Graph sign-in.

`atlas tenants validate` and `atlas tenants add` are the exception. They request one token, print Entra's answer, and exit `1` for any failure, refused or unanswered, without retrying.

### AADSTS error codes

| Error code | Meaning | Fix |
| --- | --- | --- |
| `AADSTS50020` | Wrong tenant ID | Set the profile's tenant ID to the **Directory (tenant) ID** shown in **Microsoft Entra ID → Overview** |
| `AADSTS90002` | Tenant not found | Set the profile's tenant ID to the **Directory (tenant) ID** of a tenant that exists, or its `*.onmicrosoft.com` domain |
| `AADSTS700016` | Wrong client ID, or app not found | Set the profile's client ID to the **Application (client) ID** from **App registrations**. The app must exist in the profile's tenant |
| `AADSTS7000215` | Expired or incorrect client secret | Check the expiry date in **Certificates & secrets**. If it expired, follow the [rotation procedure](/azure-ad-setup#client-secret-rotation). If not, confirm you copied the secret **Value**, not the **Secret ID** |
| `AADSTS65001` | Admin consent not granted | Open **API permissions** for the app registration and select **Grant admin consent for \<tenant\>** |

To fix a stored value:

1. Store the corrected values in the profile:
   ```bash
   atlas tenants add <name> --tenant-id <id> --client-id <id> --client-secret - --replace
   ```
2. Check that no environment variable overrides the profile for the run. `ATLAS_TENANT_ID`, `ATLAS_CLIENT_ID`, and `ATLAS_CLIENT_SECRET`, when set, take precedence over the selected profile.
3. Run `atlas tenants validate` to check the profile's Microsoft Graph credentials again.

For any other AADSTS code, look it up in Microsoft's AADSTS error reference, then check **Microsoft Entra ID → Sign-in logs → Service principal sign-ins**, filtered by the application's client ID.

### Microsoft Graph refused a request with 403

```text
[x] Microsoft Graph returned 403 Forbidden (ErrorAccessDenied).
The app registration needs these Application permissions with admin consent:
```

The token was accepted, but Graph refused the call. When the code is `accessDenied`, `ErrorAccessDenied`, or `Authorization_RequestDenied`, or `Forbidden` on a Teams call, the app registration lacks a permission. The command exits `4` with `ATLAS_AUTH_DENIED`.

1. Add the permissions the message lists, as Application permissions.
2. Select **Grant admin consent for \<tenant\>**.
3. For Teams, confirm Microsoft approved the protected API, see [Teams application permissions](/azure-ad-setup#teams-application-permissions).

```text
Channel <channel-id>: Microsoft Graph returned 403 UnknownError, which does not name a missing permission: ...
```

Any other code is not a missing permission, and Atlas does not report it as one. The request fails alone: one message, event, contact, or channel. The run continues, exits `2`, and the next run asks again. If the same item fails on every run, look up the code in the Microsoft Graph documentation for that endpoint. [Which `403` responses stop a run](/operations/reliability#forbidden-responses) lists the codes.

## Throttling and Microsoft Graph errors {#graph-throttling-and-transient-server-errors}

Microsoft Graph returns `429` when it throttles a request, and occasionally `500`, `502`, `503`, or `504` under load. Atlas retries these on its own, up to 12 times per call, honouring `Retry-After`, so occasional throttling or server errors during a large first backup need no action. [Retries and fail-safes](/operations/reliability#microsoft-graph-requests) lists every retry parameter, and [Graph rate limits](/operations/graph-rate-limits) explains the budgets behind the `429`.

::: details Retry behaviour in brief
- `Retry-After` is honoured up to one hour, followed by a random delay of up to a tenth of the wait, kept between 1 and 5 seconds, so no request goes out before Microsoft Graph asked. A value under one second is raised to one second. Without the header, a `429` applies a 30-second cooldown.
- A `Retry-After` longer than one hour fails the call at once with a `ThrottledError` naming the value.
- Backoff is exponential with jitter, capped at 5 minutes per wait. Once a call has spent 24 minutes waiting, counting backoff, `Retry-After` waits, and cooldowns, it starts no new wait. A wait already started runs in full, so one call waits at most about 24 minutes plus one cooldown. Time spent inside each request comes on top of that, so this is not a limit on how long a call takes. [Retries and fail-safes](/operations/reliability#microsoft-graph-requests) gives the wall-clock worst case.
- Each attempt times out after 60 seconds, or 30 minutes for an Outlook MIME or attachment download, and is aborted before the next one is sent. A download that receives nothing for 60 seconds is closed and retried without waiting for its attempt timeout.
- Atlas decides whether to retry from the HTTP status and from Node and undici error codes such as `ECONNRESET` or `UND_ERR_SOCKET`, never from the error message.
- When a call spends its retry budget, a backup stops, commits what it finished, and exits `3`, whichever folder, drive, or channel it was reading. A restore or save fails only that item, continues, and exits `2`. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).
:::

### When to act

| What you see | What it means | What to do |
| --- | --- | --- |
| Occasional `429`s during a large first backup | Normal. Microsoft Graph throttles per application and per mailbox, and Atlas waits it out | Nothing |
| Repeated `429`s that stop backups with `ATLAS_THROTTLED`, exit `3` | Several backups run at the same time and exceed the tenant's Microsoft Graph capacity | Run one `atlas outlook backup -m` per mailbox and stagger the schedules |
| `429`s on every request from the start | Another application in the tenant may be using most of the quota | Review tenant-wide Microsoft Graph usage. Contact Microsoft support if the limits look lower than expected |
| Occasional `500` or `502` responses | Normal under load. Retried automatically | Nothing, if the run completes |
| Persistent `500` or `502` that stops a backup with `ATLAS_GRAPH_UNAVAILABLE`, exit `3`, at the same folder, drive, or item | Retries ran out against a server-side fault, not throttling | Rerun the backup later. If it repeats, open a Microsoft support case with the time of the failure and the affected item |
| `ATLAS_GRAPH_UNAVAILABLE`, exit `3` | Microsoft Graph kept failing a call through its retry budget, and the backup stopped. A restore or save fails only that item, with this message on its error line, and exits `2` | See [Microsoft Graph unavailable after retries](#microsoft-graph-unavailable-after-retries) |
| `ATLAS_GRAPH_UNAVAILABLE`, exit `3`, naming a `404` or `400` | A run's first read kept answering it for an owner that exists | See [A run's first read kept answering 404 or 400](#first-read-kept-answering-4xx) |
| `ATLAS_THROTTLED`, exit `3` | A `429`, or SharePoint's `509 Bandwidth Limit Exceeded`, outlasted the retry budget, or `Retry-After` exceeded 1 hour, and the backup stopped. A restore or save fails only that item and exits `2` | Schedule the run again later, or run fewer jobs at once for that mailbox or tenant |
| `ATLAS_LISTING_INCOMPLETE`, exit `2` | A listing of calendars, contact folders, mail folders, or teams ended with fewer items than Microsoft Graph counted. Nothing was written | Rerun. If it repeats for the same mailbox or tenant, open an issue with the message, which names both counts. See [Unit listings that end early](/operations/reliability#unit-listings) |

Throttling caps throughput even with unlimited bandwidth. For a first full tenant backup, measure the real transfer rate and plan the schedule from it. See [Scheduling and bandwidth](/self-hosting/scheduling).

### Microsoft Graph unavailable after retries

```text
[x] Microsoft Graph was unavailable after 12 retries over 1416 s: HTTP 504 -- UnknownError -- {"code":"UnknownError","message":"",...}
[x]   Atlas code: ATLAS_GRAPH_UNAVAILABLE
```

Microsoft Graph answered `408`, `500`, `502`, `503`, or `504`, answered `200` with a JSON body that was empty or cut short, or the connection failed or timed out, on every attempt until the retry budget ran out. This is a service incident at Microsoft or a network problem between the host and Microsoft 365, not a fault in the backup. A backup exits `3`. A restore or save reports the same message on the error line of each item it hit and exits `2`, so a `2` from a restore or save can also be a Microsoft 365 incident. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

1. Check the [Microsoft 365 service health](https://admin.microsoft.com/#/servicehealth) page.
2. Schedule the run again once the incident clears. Back off at the run level rather than retrying immediately: each run spends one retry budget before it gives up. That is about 24 minutes of waiting, plus at most one more cooldown, plus the time spent inside its 13 attempts.

The message always names the HTTP status and the Microsoft Graph error code when the last attempt got a response, even one with an empty body. When no response arrived, it names the transport error instead, for example `no HTTP response (TypeError: fetch failed)` for a reset connection.

One outage costs a backup one retry budget. The first call that spends its budget stops every other Graph call of the run, whether it was reading a message, a folder, an event, a channel, or a lookup that may otherwise fail without failing the backup. The run still writes the snapshot of the folders, drives, calendars, and channels it finished, keeps the previous checkpoint of the rest, and releases the owner lease, so the next scheduled run does not meet `ATLAS_OWNER_BUSY`. `atlas teams backup --all` and `atlas sharepoint backup --include-subsites` do not start the next team or subsite. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

The lookup of an email address before the run counts too. When it spends its budget, the backup exits `3` before it takes the owner lease, instead of continuing on the identity registry entry and spending a second budget. Commands that only read backups, such as `verify` and `list -m`, use the registry entry after 15 s instead. See [Owner lookup](/operations/reliability#owner-lookup).

In the SDK the error is `GraphUnavailableError`:

| Field | Value |
| --- | --- |
| `status_code` | The last HTTP status, or `undefined` when no response arrived |
| `graph_code` | The Microsoft Graph error code, or `undefined` when no response arrived or the `200` body did not parse |
| `retries` | Retries made, up to 12. Fewer when the 24-minute wait budget ran out first |
| `elapsed_ms` | Time the call spent before giving up |
| `cause` | The original Microsoft Graph error |

A `429` that outlasts the budget is `ThrottledError` (`ATLAS_THROTTLED`) instead, with the same exit codes: `3` from a backup, `2` from a restore or save.

### A run's first read kept answering 404 or 400 {#first-read-kept-answering-4xx}

```text
[x] Microsoft Graph kept answering HTTP 404 -- itemNotFound -- ... on 3 reads over 12 s, to a request it answers for an owner that exists. Run the command again later.
[x]   Atlas code: ATLAS_GRAPH_UNAVAILABLE
```

The mailbox existence check, drive listing, calendar listing, or contact folder listing answered a `4xx` on 3 reads about 6 s apart, and the owner's directory record still exists. Nothing was written. The run exits `3`, so a scheduler tries again later. `status_code` and `graph_code` on the SDK error name the answer.

1. Rerun later. A replica that lags behind usually catches up within minutes.
2. If the same owner repeats this for hours, open an issue with the status and code from the message.

When the directory record answers `404` too, the owner is gone and the run exits `7` with `does not exist in the tenant`. See [The first read of a run](/operations/reliability#first-reads-of-a-run).

### Restore writes are sent once

A restore reports an item as failed after a `408`, `500`, `502`, `504`, `509`, a `503` without `Retry-After`, a dropped connection, or a timeout. The item may or may not exist in the target: Microsoft 365 can commit a create and still lose the response, so Atlas does not repeat it and risk two copies. The restore continues with the other items and exits `2`.

This covers messages, message and event attachments, events, contacts, mail, contact, and calendar folders, and OneDrive or SharePoint files restored with `--conflict rename` or `--conflict fail`.

A file over 4 MiB, or an attachment of 3 MiB or more, is created by the final chunk of an upload session. When that chunk ends this way, the error says so:

```
Report.docx: outcome unknown, the file may exist: the final upload chunk (bytes 10485760-12582911/12582912) ended with HTTP 504 after Microsoft 365 may have committed it. Check the target before restoring it again
```

An attachment reads `the attachment may exist`. An error that starts `Resumable upload failed at range` instead means Microsoft 365 refused a chunk, and nothing was created. Ctrl+C does not hide an unknown outcome: the item is still named.

1. **Calendar or Contacts:** rerun the restore. A Calendar restore skips events already in the target calendar and recreates an event whose attachment failed, and a Contacts restore skips contacts it restored earlier, so the rerun fills the gap without duplicates.
2. **Outlook:** check the reported message, and its attachments, in the restore folder before restoring it again.
3. **OneDrive or SharePoint with `--conflict rename` or `--conflict fail`:** check the target for the reported file before restoring it again. Under `rename`, a rerun into the same folder next to a file that did land creates a renamed second copy.

A `429`, or a `503` with `Retry-After`, is still retried, because Microsoft Graph sends these instead of processing the request. Files restored with `--conflict replace`, folder creation on OneDrive and SharePoint, and opening an upload session are safe to repeat and keep the full retry policy. Intermediate upload chunks are safe to repeat too: a OneDrive or SharePoint chunk gets up to 3 attempts, and an attachment chunk the Graph retry policy. Every chunk has a per-attempt deadline. See [Upload sessions](/operations/reliability#upload-sessions).

## OneDrive and SharePoint permission errors

File backups need Microsoft Graph application permissions beyond mailbox access. [OneDrive backup](/onedrive-backup) and [SharePoint backup](/sharepoint-backup) list the permissions for each command.

### OneDrive: owner cannot be resolved

Atlas could not find the owner in the tenant.

1. Confirm the address passed to `-o` exists in the tenant and has a licensed OneDrive.
2. Confirm the OneDrive backup application permissions are granted with admin consent.

### OneDrive: no drive is provisioned

```
No OneDrive is provisioned for user@example.com.
```

The account exists and permissions are fine, but the user has never opened OneDrive. Microsoft Graph returns `404` with the code `ResourceNotFound` ("User's mysite not found.") for such a user, which is normal for admin and service accounts, and gives the same response for an account that does not exist. Atlas reports it as `ATLAS_NOT_FOUND` (exit `7`) on the first answer.

Any other `404` on the drive listing, such as `itemNotFound`, is not this answer. Atlas reads it again, and one that persists for an owner who exists ends with `ATLAS_GRAPH_UNAVAILABLE` (exit `3`). See [A run's first read kept answering 404 or 400](#first-read-kept-answering-4xx).

1. Sign in to OneDrive once as that user to provision the drive, or leave the account out of the run. A script that iterates over a tenant can skip the owner on exit `7` and continue.
2. Do not re-check consent for this case. A missing permission is a `403`, reported separately as `ATLAS_AUTH_DENIED` (exit `4`).

### SharePoint: site cannot be resolved

Microsoft Graph returned `itemNotFound` for the site URL.

1. Confirm the URL is correct and the site has not been deleted or renamed.
2. Use the full URL including `/sites/<SiteName>`. Root site URLs use a different path format.
3. Confirm the SharePoint backup application permissions are granted with admin consent.

### SharePoint: site refused while the root site is readable

```text
[x] Microsoft Graph refused SharePoint site <site-id>: HTTP 403 accessDenied. The same app can read the tenant's root site, so Graph refused this resource alone. ...
[x]   Atlas code: ATLAS_ACCESS_REFUSED
```

Microsoft Graph refused this one site, while the same app registration can read the tenant's root site. The credentials work, but that does not show which grant the app holds: an app with `Sites.Read.All` can read the root site, and so can an app whose `Sites.Selected` grants include the root site but not this one. The usual cause is a [SharePoint Embedded container](/sharepoint-backup#sharepoint-embedded-containers), a site whose URL starts with `/contentstorage/`. Microsoft Graph refuses those to any app without `FileStorageContainer.Selected`, and Atlas does not back them up. The run exits `4`.

1. Check the site's kind with `atlas sharepoint list-sites`. A container shows `container (not backed up)`.
2. For a container, leave the site out of scheduled runs. Retrying returns the same answer.
3. For an ordinary site, check whether the app registration uses `Sites.Selected` and whether that site was granted to it. Rerun once it is.

In the SDK the error is `GraphAccessRefusedError`, with `site_id`, `status_code`, `graph_code`, and `reason`. It is not an `AuthError`, so a host that stops the whole tenant on `AuthError` keeps backing up the other sites.

If the root site is refused as well, the error is `MissingGraphPermissionsError` (`ATLAS_AUTH_DENIED`), and the message names the permission to grant: `Sites.Read.All`, or a `Sites.Selected` grant on the site.

### SharePoint restore: access denied

Microsoft Graph returned `accessDenied` during a restore. Restore needs write permission on the target site, in addition to the read permissions backup uses.

1. Add the restore permission listed in [SharePoint backup](/sharepoint-backup).
2. Grant admin consent, then rerun the restore.

## S3 connectivity errors

These stop Atlas from reading or writing backup data. Most are configuration problems. An endpoint that does not answer can also be a transient outage.

### Endpoint not reachable

```
connect ECONNREFUSED 127.0.0.1:9000
```

Nothing is listening on the configured endpoint.

1. Confirm MinIO or your S3-compatible service is running, for example with `docker ps` or `systemctl status minio`.
2. Confirm `ATLAS_S3_ENDPOINT` points to the correct host and port.
3. If Atlas runs on another machine, confirm the firewall allows TCP on the endpoint port (9000 by default for MinIO).

### Endpoint does not answer

```
[x] S3 HeadBucket got no answer from the storage endpoint after 3 attempt(s): @smithy/node-http-handler - the request socket timed out after 300000 ms of inactivity (configured by client requestHandler).
[x]   Atlas code: ATLAS_STORAGE_UNAVAILABLE
```

The endpoint accepted the connection and then sent nothing for the idle timeout, or the connection did not open within the connection timeout, on every attempt. The command exits `3`. A backend overloaded past saturation often slows down this way rather than answering `503` or `SlowDown`.

1. Check the storage service's health and load, and the network path to it.
2. Rerun later. A scheduler that retries exit `3` handles this case.
3. If the backend is healthy but performs long server-side copies without sending progress bytes, raise `ATLAS_S3_IDLE_TIMEOUT_MS`. See [S3 timeouts and retries](/self-hosting/storage#s3-timeouts-and-retries).

### Bucket not found

```
NoSuchBucket: The specified bucket does not exist
```

Atlas uses one bucket per tenant and creates it on first use when the credentials allow it. It uses path-style URLs (`http://hostname:9000/bucket-name`), which MinIO and most S3-compatible services require.

1. On AWS S3, check that the region matches the bucket's region and that the credentials belong to the account that owns the bucket.
2. If your credentials cannot create buckets, create the bucket in advance. See [Storage layout](/operations/storage-layout).

### Bucket name is not valid

```
"atlas-Contoso.onmicrosoft.com" is not a valid S3 bucket name: it must be 3 to 63 lowercase letters, digits, dots or dashes.
```

Atlas names each tenant's bucket after its tenant ID, and S3 accepts only lowercase names up to 63 characters. The error is a `ConfigError` (`ATLAS_CONFIG_INVALID`, exit `6`). A backup raises it before any bucket is created. `atlas storage-check` and the SDK's `validate()` raise it when S3 refuses to look the bucket up.

1. Store the tenant ID in lowercase with `atlas tenants add <name> ... --replace`.
2. Use the tenant GUID instead when the domain is longer than 57 characters.

An existing bucket keeps working under its name even if S3 naming rules would reject it, so a backend with relaxed naming still serves backups made by an older Atlas.

### Secure config store is locked

```
The secure config store is locked by another Atlas command (~/.atlas/config.lock).
```

Another `atlas config` or `atlas tenants` command held the store lock for more than 10 seconds. Updates normally hold it for milliseconds.

1. Check for a hung `atlas config` or `atlas tenants` command and let it finish or stop it.
2. If none is running, delete the lock file. Atlas removes a lock by itself only when the process ID recorded in it has exited on the same host, so a lock written from another host, or an empty one, needs deleting by hand.

### Signature mismatch

```
SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.
```

The signature Atlas computed differs from the one the server expects. The cause is usually the keys or the clock.

1. Confirm `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY` are correct.
2. Remove trailing spaces and newlines from the values in your environment or `.env` file.
3. For MinIO, confirm the keys match the root user and password the server was started with.
4. Check the clock. S3 rejects requests whose timestamp differs from the server time by more than 15 minutes. Run NTP on both the Atlas host and the S3 server.

### Conditional writes not enforced

```
Refusing to write to bucket atlas-<tenant-id>: the storage backend does not enforce conditional writes (the backend accepted a create-only write (If-None-Match: *) onto an existing object). ...
```

The storage backend failed the conditional-write probe Atlas runs before its first lease, key, or manifest write. The error is a `ConditionalWritesNotEnforcedError`, a `ConfigError` (`ATLAS_CONFIG_INVALID`, exit `6`), and nothing was written apart from the probe object, which Atlas removes. The text in brackets names the broken rule:

| Text in the message | Backend behaviour | Seen on |
| --- | --- | --- |
| `accepted a create-only write (If-None-Match: *) onto an existing object` | Ignores `If-None-Match` | Garage, Scality CloudServer, Ceph RGW 18 |
| `accepted a compare-and-swap (If-Match) with a stale ETag` | Ignores `If-Match` | Garage, Scality CloudServer |
| `refused a compare-and-swap (If-Match) with the current ETag` | Refuses every `If-Match` | Ceph RGW 18 |

Retrying returns the same answer, and there is no option to run anyway.

1. Run `atlas storage-check` and read the `Conditional writes` row to confirm it.
2. Upgrade the backend to a release that enforces conditional writes, or move the bucket to one that does. See [Backend compatibility](/self-hosting/storage#backend-compatibility).

## Decryption failures

A decryption failure means the passphrase does not match the one that protected the tenant's data, or the stored key or data is damaged. Atlas never generates a key over an existing one, so a damaged key cannot be replaced in place.

### Wrong passphrase

```
Could not unwrap the data key: the passphrase does not match the one this backup was written with, or the wrapped key is damaged.
```

The code is `ATLAS_WRONG_PASSPHRASE` (exit `5`). Atlas stores the data key, wrapped by the key derived from your passphrase, at `_meta/dek.enc` in the bucket. Changing the passphrase without re-wrapping that key makes the data unreadable.

1. Check that `ATLAS_ENCRYPTION_PASSPHRASE` matches the passphrase used when the tenant was first initialized.
2. If the configured value is wrong, put the original back.
3. If the passphrase is correct and the error persists, see [Damaged key](#damaged-key).

To change the passphrase safely:

1. Keep the current passphrase configured.
2. Run [`atlas keys rewrap --new-passphrase`](/reference/cli#keys-rewrap). It re-wraps the tenant of every profile, because they all share the passphrase.
3. When it exits `0`, the new passphrase is already in the encrypted config store if it came from there. Otherwise set `ATLAS_ENCRYPTION_PASSPHRASE`, or the value in `atlas.config.json`, as the command prints.

A tenant reported as `failed` may hold its previous wrapper, the new one, or, after a failed restore, a wrapper in an unknown state, and the error does not always say which. Before rerunning, find which passphrase opens the tenant's current `_meta/dek.enc`: a read-only command against that tenant exits `5` when the configured passphrase does not open it, so try it under each passphrase in turn. [Rewrapping the passphrase](/security#rewrapping-the-passphrase) lists the cases.

### One profile fails after a passphrase change

One profile works and another fails with `ATLAS_WRONG_PASSPHRASE`. The failing tenant's key is still wrapped under the old passphrase, because the configured value was changed by hand or an older Atlas re-wrapped one tenant only.

1. Run `atlas keys rewrap --old-passphrase` and type the old passphrase.
2. Every tenant still under it moves to the configured passphrase. Tenants already moved are skipped.

### Re-wrap exits 2

`atlas keys rewrap` exits `2` when some tenant was not re-wrapped: busy, failed, or opened by neither passphrase. The table names each one, and the configuration is unchanged.

1. Keep the old passphrase configured.
2. Fix the cause named in the table.
3. Run the same command again. See [keys rewrap](/reference/cli#keys-rewrap).

### Damaged key

The passphrase is correct and `ATLAS_WRONG_PASSPHRASE` persists, so `_meta/dek.enc` is damaged.

1. Copy `_meta/dek.enc` back from a replica. It is the wrapped key, safe to copy, and opens with the same passphrase.

::: danger No replica, no recovery
Without an intact copy of `_meta/dek.enc`, the data encrypted under that key cannot be read.
:::

### Authentication failure on an object

```
AES-GCM authentication failed for <object-key>
```

The authentication tag on one encrypted object does not match its contents. The affected item cannot be decrypted. The other items in the snapshot are unaffected. There are three possible causes:

| Cause | How it happens |
| --- | --- |
| Corruption | The object changed after it was written |
| Wrong key | The object was written under a different tenant key, which happens when two Atlas instances write to the same bucket |
| Tampering | The object was modified deliberately |

An Outlook, OneDrive, or SharePoint restore skips such an object, lists the item with the reason, restores the rest, and exits `2`. For OneDrive and SharePoint the reason reads `stored object failed AES-GCM authentication: it was damaged or altered in storage`. A restore reads content only after the snapshot's manifests decrypted under the same key, so one failing object is damage to that object, not a wrong passphrase. A wrong passphrase stops the run with `ATLAS_WRONG_PASSPHRASE` and exit `5` before anything is written.

1. Run the matching verify command to find every affected item:
   - `atlas outlook verify -m <mailbox> -s <snapshot-id>`
   - `atlas onedrive verify -o <owner> -s <snapshot-id>`
   - `atlas sharepoint verify --site <url> -s <snapshot-id>`
2. Restore each affected item from an earlier snapshot whose copy of it is intact, or extract what remains with `save`.
3. If many objects fail, or two Atlas instances share the bucket, investigate the bucket before trusting new backups.

## Object Lock errors

Object Lock must be enabled when a bucket is created. Most backends cannot add it to an existing bucket, so a bucket created without it cannot be used for immutable backups.

::: tip Pre-flight check
Run `atlas storage-check --lock-mode governance --retention-days 30` before your first immutable backup. It reports whether the bucket is reachable and whether versioning and Object Lock are enabled.
:::

### Versioning or Object Lock is missing

```
Immutability requested, but bucket versioning is disabled for <bucket>. Enable bucket versioning and Object Lock, or run backup without retention.
```

```
Immutability requested, but Object Lock is not supported or not enabled for bucket <bucket>.
```

The bucket was created without Object Lock, and Atlas never enables it on an existing bucket.

1. On AWS S3, a versioned bucket can be made lock-capable in place with `PutObjectLockConfiguration`. This cannot be undone.
2. On MinIO and other backends that allow it only at creation, create a new bucket with Object Lock enabled and move the tenant to it. See [Bucket provisioning and Object Lock](/self-hosting/storage#bucket-provisioning-and-object-lock) and [migrating a legacy bucket](/self-hosting/storage#migrating-a-legacy-bucket).

### Backend rejected the lock mode

```
Backend rejected Object Lock mode <mode> for bucket <bucket>.
```

The S3 backend does not support the requested mode.

1. Use `governance` or `compliance`. See [Immutability and Object Lock](/operations/immutability).
2. Check the storage backend's documentation for the modes it supports.

### Lock not applied at creation

```
Backend rejected Object Lock at creation for bucket "<bucket>" -- created without it.
```

The backend refused Object Lock while creating the bucket, and Atlas fell back to a plain bucket. This is a warning, and immutability does not work on that bucket.

1. Create a bucket with Object Lock enabled and use it instead.

## Restore content errors

### Outlook: message headers exceed 1 MiB

```
<message-id>: The message header block exceeds the 1 MiB limit the MIME parser enforces, so none of the headers could be read.
```

The MIME parser reads at most 1 MiB of headers, and a larger block yields none: no addresses, subject, or date. Atlas does not restore such a message as an ordinary entry, because without its headers it is not the message that was backed up. A block this large is usually a distribution list expanded into `To` or `Cc`, or a long `Received` chain. The backup itself is intact: the raw message is stored encrypted and checksum-verified.

| Command | Result |
| --- | --- |
| Mailbox or snapshot restore | Skips this entry, restores the others, reports the error, and exits `2` |
| Single-message restore (`--message`) | Fails with exit `9` |

1. Extract the message with `atlas outlook save`. It writes the raw message to a file that a mail client can open directly.
2. Do not retry the restore. The error is `UnreadableContentError` (`ATLAS_CONTENT_UNREADABLE`) and is permanent: a retry reads the same bytes.

### Teams: a snapshot index cannot be read

`atlas teams list-snapshots` names every index it cannot read. There are two causes:

| Cause | What Atlas does | What to do |
| --- | --- | --- |
| Newer format (`ATLAS_FORMAT_UNSUPPORTED`): another Atlas version wrote the index | The team's backup stops with exit `9` before it writes anything, and `quarantine` refuses the index | Upgrade Atlas |
| Damaged or unparseable | `status`, `list-snapshots`, and a `backup` that skipped an index newer than the newest readable one name the key with the `atlas teams quarantine` command and exit `9`. The backup also warns that its baseline is an older snapshot | Follow [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes) |

When no readable index exists at all, for example after a bucket wipe with Object Lock-retained legacy manifests, the backup warns `No readable snapshot exists; every channel is read in full`. Once a run writes a readable index, later runs stop at it and do not read the older keys. `atlas teams status` and `list-snapshots` keep naming the unreadable keys until they are quarantined. See [Unreadable snapshots](/teams-backup#unreadable-snapshots).

## Backup state errors

### Delta cursor or identity registry cannot be read

```
Could not read the state object at identity-registry.json
```

```
The state object at onedrive/_meta/<owner>/delta.json is corrupt or tampered
```

```
The state object at _meta/outlook-cursors/<owner>.json belongs to a different owner than its key names
```

Outlook, Contacts, Calendar, OneDrive, and SharePoint keep a delta cursor (the saved sync checkpoints) per mailbox, owner, or site, and the tenant keeps one identity registry. When one of these exists but cannot be read, the run stops before it writes anything. Only an absent object means "no saved state". Treating a damaged one as missing would read the whole mailbox or drive again, lose deletion tracking, and overwrite the stored state. For Outlook it would also replace checkpoints a previous run withheld after a failed message with older ones from the manifest. For the registry, it would erase the cached identities of departed users.

| Message | Error and exit | Meaning |
| --- | --- | --- |
| `Could not read the state object` | `ATLAS_STORAGE_FAILURE`, exit `1` | Storage failed. Retry once the bucket responds |
| `is corrupt or tampered` | `ATLAS_CONTENT_UNREADABLE`, exit `9` | The object failed AES-256-GCM authentication or JSON parsing. Retrying does not help. Treat it as possible tampering first |
| `belongs to a different owner` | `ATLAS_CONTENT_UNREADABLE`, exit `9` | The cursor decrypted but names another mailbox, owner, or site than its key. Every Outlook cursor shares `_meta/outlook-cursors/`, so encryption alone does not stop one mailbox's cursor being copied over another's. Treat it as tampering or an operator copy mistake |

To recover a damaged delta cursor:

1. Restore an earlier version of the cursor from bucket versioning, or delete the cursor so the next run is a full backup.
2. For Outlook, both differ: a run without a cursor resumes from the checkpoints in the mailbox's latest manifest, and `atlas outlook backup --full` never reads the cursor, so it runs past a damaged one and replaces it. See [Outlook cursor carries folder links of another mailbox](#outlook-cursor-carries-folder-links-of-another-mailbox) for what each costs.

To recover a damaged `identity-registry.json`, restore an earlier version from bucket versioning.

::: warning Never delete the identity registry
The registry is the only record of departed users that Microsoft 365 no longer resolves. Deleting it makes their backups impossible to find by address.
:::

### Outlook cursor carries folder links of another mailbox

```bash
atlas outlook backup -m user@example.com --full
```

Atlas 6.2.0 and earlier did not check the owner inside an Outlook cursor. If one mailbox's `_meta/outlook-cursors/{owner_id}.json` was copied over another's, for example by a manual fix or a partial bucket restore, the next backup of the second mailbox saved the first mailbox's sync checkpoints under its own owner. That cursor now passes the owner check, so nothing reports it.

The copied checkpoints are never sent to Microsoft Graph, because Outlook folder IDs are specific to one mailbox. They stay in the cursor, and in every manifest written since, as entries no folder uses. The damage happened in the first run after the copy: that run read every folder in full and recorded no deletions for the interval since the run before it. Later runs resume from the fresh checkpoints it saved.

1. Run one `--full` backup without `--folder`, as above. It is the only recovery that removes the foreign entries.

| Recovery | What happens | Removes foreign entries |
| --- | --- | --- |
| `atlas outlook backup --full` | Reads neither the cursor nor the latest manifest. Every selected folder is read in full, and the cursor is replaced with the checkpoints of the folders that finished. Also recovers from an unreadable cursor | Yes |
| Delete `_meta/outlook-cursors/{owner_id}.json` | The next run resumes from the checkpoints in the mailbox's latest manifest. Changes since that snapshot are fetched again and deduplicate. A full read happens only when the mailbox has no manifest, or its manifest predates immutable IDs | No, when a manifest written after the copy carries them, which is the usual case |

A `--full` run costs what a first backup costs in Microsoft Graph requests and time, but storage barely grows. See [What a full backup costs](/operations/delta-sync#what-a-full-run-costs). A full read records no removals, so a message deleted since the previous run stays restorable from older snapshots in the chain. See [Deleted and moved messages](/operations/delta-sync#deleted-and-moved-messages-outlook).

::: warning Do not combine `--full` with `--folder`
`--full` starts the new cursor empty. With `--folder`, it holds checkpoints only for the selected folders, and the next unfiltered run reads every other folder in full.
:::

### Identity registry kept changing

```
The identity registry at identity-registry.json changed on every one of 8 write attempts; too many writers are registering at once
```

Several runs for the same tenant registered users at the same moment, and this run lost the race on every attempt. Nothing was overwritten: each attempt re-reads the registry before trying again. The error is `StorageError` (`ATLAS_STORAGE_FAILURE`, exit `1`).

1. Rerun. It is safe.
2. If it recurs, start fewer runs at once for that tenant. See [Storage](/self-hosting/storage#the-identity-registry-under-concurrent-runs).

### Graph credentials belong to another tenant

```
user@example.com is not in the identity registry of tenant <source>, and the configured Graph credentials belong to tenant <destination>. Using that tenant's answer without recording it; pass the Entra object ID to name a user of the backed-up tenant.
```

`-t` names a tenant other than the one the Microsoft Graph credentials sign in to, for example when the destination tenant's credentials were exported by hand to restore into it. Microsoft Graph then describes the other tenant, so Atlas looks up addresses in the backed-up tenant's registry and never writes to it. Writing would record a same-address user in the other tenant as a recycled address and point it at a user who has no backups.

The warning appears when the address is not in the registry. The object ID Microsoft Graph returned belongs to the other tenant, so a lookup for a backed-up owner finds no snapshots.

1. Pass the owner's Microsoft Entra object ID instead of the address. `atlas list-users -t <source>` lists them.
2. To restore into another tenant, prefer `--target-profile`, which keeps the two tenants apart and does not hit this case.

Restore targets (`-T`, `--target-owner`) always resolve through Microsoft Graph alone, so they name users of the tenant being restored into.

### Another operation holds the owner

```
Another backup is running on onedrive owner <owner-id>, so this operation did not start and wrote nothing. Its lease expires at 2026-03-01T10:10:00.000Z unless that operation is still running and renews it. Retry once the other operation ends, or after the lease expires.
  Atlas code: ATLAS_OWNER_BUSY
```

Atlas runs one operation at a time per mailbox, drive owner, site, or team. A backup, restore, deletion, or quarantine was already running on this owner, so this command exited `12` and wrote nothing. The message names the workload, the owner, the operation that holds it, and when its lease runs out. See [Concurrent operations](/reference/sdk#concurrent-operations).

| Situation | What to do |
| --- | --- |
| The other operation is still running | Wait for it and rerun. The expiry in the message moves forward every 5 minutes while it runs, so it is not a completion time |
| Its process was killed, or exited on a second Ctrl+C | Wait until the time in the message, at most 10 minutes after the kill, and rerun. The next run takes the expired lease over and logs `Taking over the lease a backup left behind` |
| Two scheduled jobs overlap every night | Space them out, or wrap them in `flock` as in [Scheduling](/self-hosting/scheduling). The lease keeps the data safe, but the second job still fails with exit `12` |
| `This run lost its lease on ...` | This run held the owner and could not renew its lease before it expired, or another host took it over. It stopped before writing its manifest or cursor. Check storage reachability and the clocks of the hosts that share the bucket, then rerun |

::: warning Do not delete a live lease
Delete or edit the lease object by hand only when you are certain no operation on that owner is running anywhere. Deleting a live lease lets a second run start next to the first. The first run notices at its next check, within 60 seconds, and stops before its next commit, but until then both write the same owner's state. Waiting out the 10 minutes is always safe.
:::

A host whose clock runs several minutes ahead sees a live lease as expired and takes it over. If runs fail with `lost its lease` while storage is healthy, compare the hosts' clocks against NTP.

## Refused and unconfirmed metadata writes

```
Refusing to write the OneDrive manifest at onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json: its reader would reject it (...). Nothing was written.
```

```
The OneDrive manifest at onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json already exists and holds a different object. It was not overwritten.
```

```
The OneDrive delta cursor at onedrive/_meta/<owner-id>/delta.json was written, but reading it back returned different bytes than were sent
```

Atlas checks every manifest, index, and cursor before it uploads it, writes snapshot objects create-only, and reads the important ones back. Each message names the object and the step that failed. See [Metadata is checked before and after it is stored](/security#metadata-is-checked-before-and-after-it-is-stored).

| Message | Error and exit | Meaning | What to do |
| --- | --- | --- | --- |
| `Refusing to write ... its reader would reject it` | `RefusedWriteError`, `ATLAS_WRITE_REFUSED`, exit `1` | The object Atlas built fails its own reader's checks. Storing it would have produced a damaged manifest | Rerun. If it repeats, report it with the message, which names the object and the failed check, never content |
| `Refusing to write ... too large to store as one JSON document` | The same | One manifest or index passed the JSON string limit of about 512 MB | Rerunning gives the same result. Report it with the message |
| `Refusing to write ... decrypts to different bytes`, `does not decrypt` | The same | The ciphertext did not decrypt back to what was encrypted, which points at faulty memory or CPU on the host | Rerun. If it repeats, test the host's memory before trusting any backup made on it |
| `already exists and holds a different object` | `StoredObjectConflictError`, `ATLAS_STORAGE_FAILURE`, exit `1` | Another object sits under this run's snapshot ID. The owner lease keeps two runs off one owner, and Atlas refuses a backend that does not enforce write conditions, so this points at an object written outside Atlas | Rerun, which uses a new snapshot ID. Run `atlas storage-check` and read its `Conditional writes` row |
| `was written, but reading it back returned different bytes` | `StorageError`, `ATLAS_STORAGE_FAILURE`, exit `1` | Storage returned something other than what was sent: a backend fault, or for a cursor, another run writing the same cursor | Rerun, then check `status`. If the object is reported damaged, see [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes) or [Delta cursor or identity registry cannot be read](#delta-cursor-or-identity-registry-cannot-be-read) |
| `was written but could not be read back to confirm it` | The same | The upload succeeded and the confirming `GET` failed. The cause is attached | Rerun once storage responds |

A manifest or index that fails stops the run before the owner's delta cursor is saved. The next run starts from the previous cursor and reads the same changes again, and content already uploaded deduplicates. When the cursor itself failed its read-back, its manifest is already stored. A delta cursor names the snapshot it was saved with, so a cursor left behind the newest manifest makes the next run read in full.

A refused write stores nothing, so `quarantine` does not apply to it.

## Damaged manifests and version indexes

```
  Unreadable stored object: onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json
1 stored object(s) could not be decrypted or parsed and were skipped -- exit 9
If an object is damaged, move it aside so later runs stop reporting it:
  atlas onedrive quarantine --key onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json
```

A snapshot manifest, a Teams snapshot index, or a OneDrive or SharePoint version index exists but does not decrypt, does not parse, lacks the fields every manifest has, or names another owner or snapshot than its key. The command skipped it, finished what it could do correctly without it, named the key, and exited `9` (`ATLAS_CONTENT_UNREADABLE`).

Two similar cases are reported differently:

- A storage outage stops the command with `ATLAS_STORAGE_FAILURE`, because it says nothing about the object.
- An object a newer Atlas release wrote is intact, so every command that reads it stops with `ATLAS_FORMAT_UNSUPPORTED` (exit `9`) and `quarantine` refuses it. Upgrade Atlas instead.

### Recovery

```bash
atlas onedrive quarantine --key onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json
# Needed when newer snapshots exist. After the newest one is quarantined the next backup is full by itself.
atlas onedrive backup -o user@example.com --full
```

1. **Rule out storage and key problems first.** A wrong passphrase fails the data key before any manifest is read, so it is never reported this way. If many objects across owners are damaged at once, suspect the bucket, a misconfigured replica, or tampering, and stop there.
2. **Check bucket versioning.** If the bucket is versioned, an earlier version of the same object may be intact. Restoring that version with your S3 tooling recovers the snapshot completely, which quarantine cannot.
3. **Quarantine the object.** `atlas <workload> quarantine --key <key>` moves it to `_quarantine/<key>` without changing its bytes. Later listings, status, and backups stop reporting it. See [`quarantine`](./reference/cli.md#damaged-manifests-and-version-indexes) for the refusals and Object Lock behaviour.
4. **Re-establish a full baseline where snapshots are incremental.**

| Workload | After quarantine |
| --- | --- |
| Contacts, Calendar | Nothing to do. Quarantine removes the mailbox's delta cursor, so the next backup reads in full |
| Teams | Nothing to do. Every index is complete on its own, and channels whose cursor no longer matches the older index are read in full |
| Outlook | Run one `backup --full`. Snapshots taken after the quarantined manifest no longer include the changes it recorded |
| OneDrive, SharePoint | Run one `backup --full` when newer snapshots exist. When the quarantined manifest was the newest, the next backup reads every drive or library in full by itself, because the cursor records the snapshot it was saved with. Cursors written before 7.0 record no snapshot, so run `backup --full` in either case until a 7.0 or later backup has run for that owner or site |

::: warning Older points in time stay incomplete
Quarantine cannot rebuild what the object held. Points in time before the next full backup stay incomplete for items first captured in the quarantined run.
:::

A quarantined object is kept, not destroyed. Its ciphertext stays bound to its original path, so it does not decrypt at the quarantine path. To retry it after repairing storage, copy it back to the original path. Owner deletion (`atlas <workload> delete -o`, `-m`, `--site`, or `--team`) removes the quarantined copies of that owner, and `atlas delete --purge` removes all of them.

In the SDK, listings reject with `UnreadableObjectsError`, which names the keys in `unreadable_keys` and carries the readable rows, in camelCase, in `partial_result`. Status, backup, restore, save, and verify results carry `unreadableKeys` instead. See [SDK errors](./reference/sdk.md#errors).

### What each command does around a damaged object

| Command | Behaviour |
| --- | --- |
| `status` | Reports the newest readable snapshot and the damaged key. Exit `9`. Outlook, OneDrive, and SharePoint decrypt only the newest manifest, so damage in an older one is found by `verify`, not here |
| `list`, `list-snapshots`, `mailboxes` | Prints every readable snapshot, then the damaged key. Exit `9`. Outlook `list -m`, Contacts and Calendar `list -m`, and drive `list-snapshots` answer from the [snapshot summary index](/operations/storage-layout#snapshot-summary-index) and name only damaged manifests it has no row for |
| `list-versions` | Prints the rows of every readable index object, then the damaged key. Exit `9`. The listed history may be missing that run's versions |
| `backup` | Runs and writes its snapshot, names a damaged newest manifest or index, and exits `9`. See [Backups while a manifest is damaged](#backups-while-a-manifest-is-damaged) |
| OneDrive and SharePoint `restore`, `save`, `verify` | Refused, naming the key, when the damaged manifest is at or before the target snapshot or carries no time in its key. A newer damaged manifest is outside the target's chain: the command runs, and names it when the summary index has no row for it |
| Outlook `restore`, `save`, `verify`, `read` | Refused, naming the key, when the summary index places the damaged manifest at or before the target, or has no row for it, since its time is then unknown. `read` by message number reads only the target manifest |
| Contacts and Calendar `restore`, `verify` | Refused only for the damaged snapshot itself. Every snapshot is complete on its own |
| `restore-version` | Refused while any index object of the owner or site is damaged, naming the key |
| `verify` (OneDrive, SharePoint) | Lists each damaged index object as an index issue and exits `1` |

Refusals are deliberate. OneDrive, SharePoint, and Outlook snapshots are incremental: a restore combines the target with every older manifest. Leaving a damaged one out would restore a different drive or mailbox than the one backed up, missing every item first captured in that run and bringing back items it recorded as deleted. Drive snapshot IDs embed their time (`od-snap-<epoch-ms>-...`), so drive restores can tell whether a damaged manifest is older than the target. An Outlook snapshot ID carries no timestamp, and the manifest's own `created_at` is inside the damaged ciphertext, so Outlook cannot. A version rollback picks the newest version before a cutoff, and that version may be in the unreadable object.

#### Backups while a manifest is damaged

Backups keep working and stay correct. OneDrive, SharePoint, Teams, Calendar, and Contacts also print `Status: UNHEALTHY`.

| Workload | What the backup does |
| --- | --- |
| Contacts, Calendar | Each snapshot builds on the previous one. When the newest manifest is damaged, the cursor's checkpoints describe a state nobody can read, so the run ignores them, reads every folder or calendar in full, and always writes a fresh snapshot. The next run resumes incrementally from it |
| Teams | Compares against the newest readable index. A channel whose cursor pointed at the damaged index's shard is read in full, and the run writes a fresh index. A channel that fails in the same run keeps its entry from the older index until a later run reads it. A channel whose own shard is missing or damaged fails until it is rebuilt with `--full`, see [Unreadable channel shards](/teams-backup#unreadable-channel-shards) |
| Outlook | Builds nothing on the previous manifest's entries. Resumes from the delta cursor and records its own changes as usual |
| OneDrive, SharePoint | Resume from the delta cursor and build nothing on the newest manifest, which they read only to report damage. See below |

For Outlook, OneDrive, and SharePoint, a damaged manifest that has a [summary index](/operations/storage-layout#snapshot-summary-index) row is named only while it is the newest. Once a later backup writes a newer manifest, incremental runs stop naming it, and `verify` is what still finds it.

::: details OneDrive and SharePoint full reads around a damaged manifest
A OneDrive or SharePoint full read also reads every older manifest, names each damaged one, and uses them to record deletions. A whole-drive read leaves a damaged manifest out of that comparison, which can only add a deletion record for a file already deleted, never remove a file that exists. A `--folder` read records no deletions while a manifest is damaged, because the damaged run may have moved a file outside the scope and its older in-scope entry would otherwise be recorded as deleted. A file deleted meanwhile keeps its older entry until a later full read.

A run keeps resuming its delta cursor while the damaged manifest is still in place, because the cursor is checked against the manifests that exist, not against the ones that decrypt.
:::

## See also

- [Getting started](/getting-started)
- [Concepts](/concepts)
- [CLI reference](/reference/cli)
- [Retries and fail-safes](/operations/reliability)
- [Security](/security)
- [Microsoft Entra ID setup](/azure-ad-setup)
