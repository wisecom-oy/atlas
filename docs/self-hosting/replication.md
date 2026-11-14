---
description: Set up a replica of your Atlas backups with AWS S3 replication, MinIO replication, Backblaze B2 Cloud Replication, rclone, or mc mirror.
---

# Replica setup

A replica is a second copy of the tenant bucket, kept by your storage provider or a copy tool in another location. With the primary and a replica on different media you have a 3-2-1 layout: three copies, two kinds of media, one off site.

Atlas does not copy the data itself. This page shows how to set each option up. How Atlas restores from and verifies a replica is in [Replicas](/operations/replication).

```bash
# MinIO primary to MinIO at another site: versions and existing objects, no deletes
mc replicate add primary/atlas-<tenant-id> \
  --remote-bucket 'https://<key>:<secret>@replica.example.com/atlas-<tenant-id>' \
  --replicate "existing-objects,metadata-sync"
```

## Choose a method

| Method | Keeps versions | Continuous | Same bucket name possible | Readable by Atlas today |
| --- | --- | --- | --- | --- |
| MinIO bucket or site replication to another deployment | Yes | Yes | Yes | Yes |
| `rclone copy` or `mc mirror` to another provider | No, current objects only | No, scheduled | Yes | Yes |
| AWS S3 Same-Region or Cross-Region Replication | Yes | Yes | No | After [#768](https://github.com/wisecom-oy/atlas/issues/768) |
| Backblaze B2 Cloud Replication | Yes | Yes | No | After [#768](https://github.com/wisecom-oy/atlas/issues/768) |

Atlas reads the bucket `atlas-<tenant-id>` on whatever endpoint it is given. AWS S3 and Backblaze B2 bucket names are unique across each provider, so their replica has a different name and needs the bucket-name override in #768. Until then, use one of the first two rows for those providers: a MinIO deployment or another S3-compatible provider, under the same name.

For every method:

- Create the replica bucket with **Object Lock** enabled. Some providers cannot add it to an existing bucket, and a lock on the primary does not carry to a bucket without one. See [Immutability](/operations/immutability).
- Keep **deletes off**. A replicated delete or delete marker turns an `atlas delete`, a purge, or a stolen primary key into data loss on both sides.
- Give the replica its **own credentials**. The Atlas host needs read-only keys for it; the primary's keys must not be able to delete there.
- Use `https://` for any endpoint that is not on loopback.

## MinIO replication

MinIO replicates a versioned bucket to a bucket on another deployment, continuously, with versions and Object Lock retention. Both buckets need versioning, and Object Lock on the target if you want it there.

```bash
mc mb --with-lock replica/atlas-<tenant-id>
mc replicate add primary/atlas-<tenant-id> \
  --remote-bucket 'https://<key>:<secret>@replica.example.com/atlas-<tenant-id>' \
  --replicate "existing-objects,metadata-sync"
mc replicate status primary/atlas-<tenant-id>
```

Leave `delete` and `delete-marker` out of `--replicate`. `existing-objects` copies what the bucket already holds. Site replication between whole deployments works too, but it replicates deletes, so prefer bucket replication for a backup replica. Check flag names against your `mc` release with `mc replicate add --help`.

## AWS S3 replication

S3 Same-Region and Cross-Region Replication copy every new version to a destination bucket, with Object Lock retention when the destination has Object Lock. Turn on versioning on both buckets, then add a replication rule on the source:

| Setting | Value |
| --- | --- |
| Scope | The whole bucket |
| Delete marker replication | Disabled |
| Replica modification sync | Disabled |
| Replication Time Control | Optional; bounds lag to 15 minutes for a fee |
| Existing objects | Run S3 Batch Replication once for objects written before the rule |

S3 never replicates a delete that names a version. Lifecycle expirations on the source are not replicated either, so set the replica's own lifecycle rules.

The destination has a different bucket name, so Atlas can read it only after #768.

## Backblaze B2 Cloud Replication

B2 Cloud Replication copies new files from a source bucket to a destination bucket in the same or another region or account. Create the destination with Object Lock, then add the rule in the B2 web console under **Cloud Replication**, with existing files included. Check in the rule whether hide markers, B2's equivalent of delete markers, are replicated, and protect the destination with Object Lock retention either way so they cannot remove data.

The destination has a different bucket name, so Atlas can read it only after #768.

## rclone or mc mirror

A scheduled copy works with any S3-compatible provider and keeps the bucket name. It copies current objects only, not older versions.

```bash
rclone copy primary:atlas-<tenant-id> offsite:atlas-<tenant-id> --checksum
# or
mc mirror --overwrite primary/atlas-<tenant-id> offsite/atlas-<tenant-id>
```

Never use `rclone sync` or `mc mirror --remove`: they delete on the replica whatever is gone from the primary.

Schedule the copy after the backups, so it does not catch a manifest before its objects:

```cron
# Backups at 2 AM, copy to the replica at 5 AM
0 5 * * * /usr/bin/rclone copy primary:atlas-<tenant-id> offsite:atlas-<tenant-id> --checksum >> $HOME/atlas-logs/replica-copy.log 2>&1
```

Then check the replica with `verify --fast`, as in [Replicas](/operations/replication#consistency).

Create `~/atlas-logs` for the service account first, as in [Scheduling](/self-hosting/scheduling).

## Bandwidth

The first copy moves the whole bucket, about the volume of the first full backups. Later runs move only new objects, because Atlas never rewrites a content object. For example, 50 GB over a 10 Mbps upload link takes about 11 hours.

Provider replication runs inside the provider's network and costs no egress from the Atlas host. Cross-region replication is billed as inter-region transfer by most providers. `rclone` and `mc mirror` stream every object through the host that runs them, so its download and upload both count.

## See also

- [Replicas](/operations/replication): restoring from and verifying a replica
- [Storage setup](/self-hosting/storage)
- [Scheduling and bandwidth](/self-hosting/scheduling)
