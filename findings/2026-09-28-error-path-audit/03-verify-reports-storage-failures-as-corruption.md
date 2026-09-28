# Verify counts storage permission and availability failures as corrupt or missing objects

**Triage:** RECORD (high confidence, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Both verifiers wrap each object check in a catch-all that returns "failed":

- Outlook fast mode: any error from `storage.exists` means the object is missing.
- Outlook full mode: any error from `get`, `decrypt` or hashing means the object is corrupt.
- OneDrive and SharePoint: any error from `exists` or `stream_sha256_from_storage` means the blob
  is corrupt.

`S3ObjectStorage.exists` returns `false` only for `NotFound` and `NoSuchKey`, and rethrows
everything else. So an expired storage credential (`403`), a throttled backend (`503 SlowDown`),
or a network outage during a verify run is reported object by object as damage to the backup.
The command exits `1` with a list of "failed" ids.

The documented contract sends these failures elsewhere: `403` is exit `4` ("correct credentials
... before retrying"), and `503` or a network error is exit `3` ("schedule a later attempt").
Reporting them as integrity failures sends the operator to investigate data that is fine, the
same kind of misreport #76 fixed for restore.

## Steps to reproduce

1. Take a backup of `john.doe@example.com`.
2. Revoke `s3:GetObject` for the Atlas access key, or point it at a stopped MinIO.
3. `atlas outlook verify -s <snapshot-id>` (or `--fast`), and `atlas onedrive verify -o
john.doe@example.com -s <snapshot-id>`.

## Expected

The run stops on the first storage failure that is not an absent key, with the documented
category: exit `4` for `403`, exit `3` for `503` or a network error. A genuinely missing object
and a genuine checksum or tag failure are still counted as failed.

## Actual

Every object is reported as failed, and the run exits `1`.

## Code references

- `packages/core/src/services/verification/verification.service.ts:169` `object_exists`,
  `catch` at `:172`.
- `packages/core/src/services/verification/verification.service.ts:183` `is_item_corrupt`,
  `catch` at `:189`.
- `packages/drive/src/verification/verify-snapshot.ts:159` `is_blob_corrupt`, `catch` at `:167`.
- `packages/s3/src/adapters/s3-object-storage.adapter.ts:161` `exists` rethrows everything but
  `NotFound` and `NoSuchKey`.
- Reference for the split: `is_absent_object_error` in
  `packages/core/src/services/shared/absent-object.ts`, already used by the manifest repository.

## Interface

Both (CLI and SDK).

## Environment

```
OS: Ubuntu 24.04.4 LTS
Kernel: 6.18.44-fc-v42
Arch: x86_64
Node: v22.22.2
pnpm: 10.30.3
Atlas: 5.2.2
Git commit: 4d6ee39 (clean)
```

Found by code reading; not reproduced against a live bucket.

## Acceptance criteria

- An absent object counts as failed in both modes and both workload families.
- A failed AES-GCM tag or a checksum mismatch counts as failed.
- Any other storage error propagates, so the CLI exits with the category its status or network
  code maps to.
- Unit tests for both verifiers pin the three outcomes: absent, corrupt, and storage failure.
