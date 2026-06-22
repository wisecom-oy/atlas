# Troubleshooting

Common errors encountered when running Atlas, with specific error messages, likely causes, and steps to resolve.

## Authentication Failures

Authentication errors appear before any backup activity starts. Atlas authenticates with Microsoft Graph using the OAuth2 Client Credentials flow, so failures here are always credential or tenant configuration problems -- not network or storage issues.

### AADSTS error codes

| Error Code    | Meaning                        | Fix                                                                                                      |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `AADSTS50020` | Wrong tenant ID                | Verify `ATLAS_TENANT_ID` matches the **Directory (tenant) ID** in Azure Portal → Microsoft Entra ID → Overview. |
| `AADSTS700016` | Wrong client ID or app not found | Verify `ATLAS_CLIENT_ID` matches the **Application (client) ID** in App registrations. The app must exist in the tenant specified by `ATLAS_TENANT_ID`. |
| `AADSTS7000215` | Expired or incorrect client secret | Check the expiry date of your secret in **Certificates & secrets**. If expired, follow the [rotation procedure](/azure-ad-setup#client-secret-rotation). If not expired, verify you copied the secret **Value** (not the Secret ID). |
| `AADSTS65001` | Admin consent not granted      | Go to **API permissions** for the app registration and click **Grant admin consent for [tenant]**.       |

### Diagnosing authentication errors

Atlas logs the full AADSTS error response on authentication failure. Look for a line like:

```
Error: ClientSecretCredential authentication failed
  AADSTS7000215: Invalid client secret provided...
```

If the error message is ambiguous, cross-check in the Azure Portal under **Microsoft Entra ID → Sign-in logs → Application sign-ins**, filtering by your application's client ID.

## Graph API 429 Throttling

HTTP 429 responses from Microsoft Graph are normal and expected during large backups. They are not errors requiring intervention.

### What it looks like in logs

```
[warn] Graph API rate limit hit (attempt 3/12), retrying in 14s (Retry-After header)
```

Atlas honors Microsoft's `Retry-After` header and retries up to **12 times** with exponential backoff. If all 12 retries are exhausted, the folder-level operation fails and is recorded in `summary.folder_errors` -- the backup continues with other folders.

### When to worry

- **Occasional 429s during large initial backups**: normal. Microsoft throttles per-application and per-mailbox. Atlas handles these automatically.
- **Persistent 429s causing repeated folder failures**: this usually means you have too many concurrent workers (`-C` flag) for your tenant's allocated Graph API capacity. Try reducing to `-C 2` or `-C 1`.
- **429s on every request from the start**: check whether another application in your tenant is also consuming heavy Graph API quota. Contact Microsoft support if the throttle limits seem unusually low.

### Throughput ceiling

Even with unlimited bandwidth, Graph API throttling caps effective throughput. For a first full tenant backup, monitor actual transfer rates and use the baseline to plan your scheduling window. See [Scheduling & Bandwidth](/self-hosting/scheduling) for sizing estimates.

## OneDrive & SharePoint Permission Errors

File workload backups require additional Graph API permissions beyond Outlook mailbox access.

### OneDrive: user not found or no drive

```
Error: Failed to resolve owner: user not found
```

- Verify the email/UPN in `-o` exists in the tenant and has a licensed OneDrive.
- Confirm `User.Read.All` and `Files.Read.All` application permissions are granted with admin consent.

### SharePoint: site not found

```
Error: Failed to resolve site: itemNotFound
```

- Verify the site URL is correct and the site has not been deleted or renamed.
- Confirm `Sites.Read.All` and `Files.Read.All` application permissions are granted with admin consent.
- Some sites require the full URL including `/sites/SiteName` -- root site URLs use a different path format.

### SharePoint restore: insufficient write permission

```
Error: accessDenied
```

Restore requires `Sites.ReadWrite.All` in addition to the read permissions needed for backup. Grant admin consent after adding the permission.

See [OneDrive Backup](/onedrive-backup) and [SharePoint Backup](/sharepoint-backup) for the full permission matrix per command.

## S3 Connectivity Errors

S3 errors prevent Atlas from reading or writing backup data. These are configuration problems, not transient failures.

### Endpoint not reachable

```
Error: connect ECONNREFUSED 127.0.0.1:9000
```

- Check that MinIO (or your S3-compatible storage) is running: `docker ps` or `systemctl status minio`.
- Verify `ATLAS_S3_ENDPOINT` points to the correct host and port.
- If running Atlas on a different machine than MinIO, confirm the firewall allows TCP on port 9000.

### Path-style vs. virtual-hosted style

```
Error: NoSuchBucket: The specified bucket does not exist
```

MinIO requires path-style URLs (`http://hostname:9000/bucket-name`). If Atlas is sending virtual-hosted-style requests (`http://bucket-name.hostname:9000`), set:

```env
ATLAS_S3_FORCE_PATH_STYLE=true
```

AWS S3 uses virtual-hosted-style by default. Managed S3-compatible services (Backblaze B2, Wasabi, etc.) vary -- check their documentation.

### Wrong credentials

```
Error: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.
```

- Verify `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY` are correct.
- Check for trailing whitespace or newline characters in the environment variable values.
- If using MinIO, confirm the credentials match `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in your Docker environment.
- Significant clock skew between the Atlas host and the S3 server can also cause this error. AWS S3 rejects requests where the timestamp differs by more than 15 minutes. Ensure both systems use NTP.

## Decryption Failures

Decryption errors indicate a mismatch between the passphrase used to encrypt the data and the passphrase currently configured, or corruption of the key material.

### Wrong passphrase

```
Error: Unable to unwrap DEK: incorrect passphrase or corrupted key blob
```

The passphrase in `ATLAS_ENCRYPTION_PASSPHRASE` does not match the one used when the tenant was first initialized. The wrapped DEK (stored at `_meta/dek.enc` in the bucket) was encrypted with the original passphrase using scrypt key derivation -- changing the passphrase without re-wrapping the DEK makes all data inaccessible.

There is no way to recover data if the original passphrase is lost. This is by design -- the passphrase is the root of the entire encryption chain.

### Corrupted DEK blob

```
Error: Failed to parse DEK blob: unexpected end of data
```

The `_meta/dek.enc` object in the bucket is corrupted or truncated. This can happen due to an interrupted write during initialization. If you have a replica, recover the DEK from there using `atlas rehydrate`. Otherwise, the tenant must be re-initialized (destroying all existing data).

### GCM authentication failure

```
Error: GCM authentication failed: data may be corrupted or tampered with
```

The GCM authentication tag on an encrypted object does not match. This means either:

1. **Corruption in transit or at rest**: the ciphertext was modified after being written. Run `atlas outlook verify -m <mailbox> -s <snapshot-id>`, `atlas onedrive verify -o <owner> -s <snapshot-id>`, or `atlas sharepoint verify --site <url> -s <snapshot-id>` to identify which objects are affected.
2. **Wrong DEK**: the object was encrypted by a different tenant or after a tenant re-initialization. This can happen if objects from two different Atlas instances end up in the same bucket.
3. **Deliberate tampering**: the object was modified by an attacker or a misconfigured tool.

In all cases, the affected items cannot be decrypted. The remaining items in the snapshot are not affected.

## Object Lock Errors

Object Lock must be enabled at bucket **creation** time. It cannot be added to an existing bucket.

### Bucket not configured for versioning

```
Error: InvalidBucketState: Object Lock configuration cannot be enabled on existing buckets.
```

or

```
Error: Object Lock requires versioning to be enabled.
```

You are attempting to apply Object Lock to a bucket that was created without it. Create a new bucket with Object Lock enabled from the start, then update `ATLAS_S3_BUCKET` to point to the new bucket. See [Immutability & Object Lock](/operations/immutability) for step-by-step bucket setup.

### Object Lock not enabled at bucket creation

```
Error: InvalidRequest: Bucket is missing ObjectLockConfiguration
```

The bucket exists and has versioning, but Object Lock was not enabled at creation. The only fix is to create a new bucket with Object Lock enabled.

::: tip Pre-flight check
Run `atlas storage-check --lock-mode governance --retention-days 30` before running your first immutable backup. It reports versioning and Object Lock status without writing any data, letting you catch configuration problems before they affect a backup job.
:::
