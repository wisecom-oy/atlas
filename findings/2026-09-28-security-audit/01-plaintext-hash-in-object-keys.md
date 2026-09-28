# Storage keys are the unkeyed SHA-256 of the plaintext, so bucket read access confirms which files and messages each owner holds

**Triage:** RECORD (high confidence, `bug`, `security`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Kerckhoffs's principle, as `docs/security.md` applies it: an attacker knows the design, the
formats and the storage layout, and the tenant passphrase is the only secret. Everything the
bucket reveals without that passphrase has to be safe to reveal.

Every content object is stored under the SHA-256 of its plaintext:

| Workload                      | Key                                  |
| ----------------------------- | ------------------------------------ |
| Outlook messages              | `data/{mailbox}/{sha256}`            |
| Outlook legacy attachments    | `attachments/{mailbox}/{sha256}`     |
| OneDrive files and versions   | `onedrive/data/{owner_id}/{sha256}`  |
| SharePoint files and versions | `sharepoint/data/{site_id}/{sha256}` |

The hash is unkeyed, so anyone who can list the bucket, or `HEAD` a key, can test whether a
given plaintext is in a given owner's backup. They need no passphrase and no data key. They hash
a candidate file and look for the key. `LastModified` then says roughly when it was first backed
up, and the same hash under two owners says both hold the same file.

This is a file-confirmation oracle. It is strongest for drive content, where documents are
shared verbatim: a leaked contract, a published report, a known malware sample, a
whistleblower's document. Outlook MIME messages are mostly unique per mailbox because of their
headers, but legacy attachment objects are raw file bytes.

Outlook also writes the hash a second time, as unencrypted S3 metadata:
`message-payload-store.ts:68` sets `x-plaintext-sha256` on every message object.

The documentation says the opposite of what the layout does:

- `docs/security.md:188` lists `x-message-id` as the only unencrypted metadata on mailbox
  objects. `x-plaintext-sha256` is not mentioned.
- `docs/security.md:198`: plaintext checksums "are stored exclusively inside encrypted manifests
  and version indexes, preventing known-plaintext fingerprinting via S3 `HeadObject`/`ListObjects`
  access". The key name is the checksum, so `ListObjects` is exactly the fingerprinting channel.

Who holds bucket read without the passphrase in practice: the storage provider, a backup
administrator, a leaked read-only S3 key, a misconfigured bucket policy, and whoever receives a
replica. The at-rest encryption is meant to make all of them harmless.

## Steps to reproduce

1. Back up a OneDrive owner who holds `Report.docx`.
2. With S3 read credentials only: `sha256sum Report.docx`, then
   `aws s3api head-object --bucket atlas-example-bucket --key onedrive/data/<owner-id>/<hash>`.
3. `200` confirms the owner has the file. Listing `onedrive/data/` and grouping by hash shows
   which owners share it.

## Expected

Object names reveal nothing about content to someone without the tenant key.

## Actual

Object names are a public function of the content.

## Code references

- `packages/outlook/src/services/backup/message-payload-store.ts:57-58` (key) and `:68`
  (metadata).
- `packages/outlook/src/services/backup/attachment-storage-sync.ts:42-43`.
- `packages/drive/src/shared/storage-keys.ts:99-102` `data_key(owner_id, checksum)`.
- `packages/core/src/services/shared/stream-encrypt-upload.ts:71`, the large-file path.
- `docs/security.md:188`, `:198`.

## Proposed direction

Keep content addressing, since it is what makes dedup work, but address by a keyed hash: derive
a naming key from the data key (HKDF with a fixed label) and name objects by
`HMAC-SHA256(naming_key, plaintext)`. Dedup within the tenant is unchanged, the name no longer
reveals anything without the key, and the manifest keeps the plain SHA-256 inside its encryption
for integrity checks. Existing objects keep their names, the same way headerless objects keep
working after #350, and the docs say so.

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

Found by code reading.

## Acceptance criteria

- New content objects are named by a keyed hash that cannot be computed without the tenant key.
- `x-plaintext-sha256` is no longer written.
- Dedup still works within a tenant across runs and across the buffered and streamed paths.
- Restore, save and verify read both naming schemes.
- `docs/security.md` states what an object name reveals for new and for existing objects, and
  the table of unencrypted metadata matches what the code writes.
