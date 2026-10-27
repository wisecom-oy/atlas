# Keyed content object names

Content objects are named by a keyed hash of their plaintext instead of a plain SHA-256. No action is required: existing backups stay readable and Atlas does not rename them. This page covers what changes in the bucket and how to remove the old names if you need the stronger guarantee for existing data.

## What changed

| Area                              | Before                                  | Now                                                          |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Content object name               | SHA-256 of the plaintext                | HMAC-SHA256 of the plaintext, keyed from the tenant data key |
| `x-amz-meta-x-plaintext-sha256`   | Written on every Outlook message object | Not written                                                  |
| Manifest checksum                 | SHA-256 of the plaintext (encrypted)    | Unchanged                                                    |
| Reading objects written before it | Not applicable                          | Resolved through the manifest entry, as before               |

The naming key is derived with HKDF-SHA256 (info `atlas/object-name/v1`) from the tenant data key (DEK). Someone with read access to the bucket but without the passphrase can no longer hash a known file and check whether an owner holds it. See [What object names reveal](/security#what-object-names-reveal).

## Why

A plain SHA-256 name can be computed by anyone who has the file. A storage provider, a leaked read-only key, or a bucket replica could therefore confirm which documents each owner held, and roughly when they were first backed up, without the passphrase.

## What to expect after upgrading

- The first backup of each owner uploads content once more under its keyed name, because the old name no longer matches. Later runs deduplicate against the keyed name as before.
- Storage grows by about one copy of each owner's existing content. The old objects stay until the snapshots that reference them are deleted.
- Restore, save, and verify read old and new snapshots alike. Snapshots written before the upgrade keep pointing at their old objects.
- Objects written before the upgrade still carry SHA-256 names and, for Outlook messages, the `x-plaintext-sha256` header. They remain open to the fingerprinting described above until they are deleted.

## Removing the old names

Skip this if your threat model does not include bucket readers without the passphrase, or if retention will expire the old snapshots soon enough.

Deleting a single snapshot with `-s` removes only its manifest and keeps data objects, so it does not remove old names. To remove them, delete the owner's backup and take a fresh full backup:

```bash
atlas outlook delete -m user@company.com -y    # all data and manifests for one mailbox
atlas outlook backup -m user@company.com       # first backup stores keyed names only
```

`atlas delete --purge` does the same for the whole tenant. This also discards the owner's earlier restore points, so take the decision with your retention requirements in mind. Objects under Object Lock retention cannot be deleted until retention expires and are reported as retained.
