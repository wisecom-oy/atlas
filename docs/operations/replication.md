---
description: Keep a second copy of Atlas backups with your storage provider's replication, then restore from and verify that replica with Atlas.
---

# Replicas

Your storage provider keeps the second copy of your backups. Atlas restores from that copy and verifies it, using the same commands it runs against the primary bucket.

```bash
# Check a replica: point the S3 settings at it for this run only
ATLAS_S3_ENDPOINT=https://replica.example.com \
ATLAS_S3_ACCESS_KEY=<replica-read-only-key> \
ATLAS_S3_SECRET_KEY=<replica-read-only-secret> \
  atlas outlook verify -m user@example.com -s <snapshot-id> --fast
```

Setup recipes for AWS S3, MinIO, Backblaze B2, rclone, and `mc mirror` are in [Replica setup](/self-hosting/replication).

## What a replica needs

Atlas reads a replica exactly as it reads the primary. A copy is usable when all of these hold:

| Requirement | Why |
| --- | --- |
| Every object, under the same key | Each object is encrypted (AES-256-GCM) with its key's directory as associated data, so a moved object fails to decrypt. |
| `_meta/dek.enc` is copied | It is the wrapped data key. Without it nothing on the replica can be decrypted. |
| The same encryption passphrase | The passphrase unwraps `_meta/dek.enc`. A replica is no use without it. |
| The bucket is named `atlas-<tenant-id>`, or Atlas is told its name | Atlas derives the bucket name from the tenant ID. A replica under another name is opened with a [bucket override](/configuration#bucket-override). |

::: tip AWS S3 and Backblaze B2 replicas have another name
Bucket names on AWS S3 and Backblaze B2 are unique across the whole provider, so a replica there cannot be called `atlas-<tenant-id>`. Name it with `ATLAS_S3_BUCKET` for one run, or with `--bucket` on a tenant profile kept for the replica. The tenant ID still derives the key, so the replica opens with the same passphrase.
:::

Replicas that `atlas replicate` wrote under Atlas 6 already meet every requirement. They hold the same bucket name on a different endpoint, so Atlas 7 reads them as they are.

## Restore and verify from a replica

For a replica you use regularly, keep a tenant profile for it instead of exporting variables. The profile uses the same Entra app registration as the primary and only adds the bucket name:

```bash
pbpaste | atlas tenants add contoso-replica --tenant-id <tenant-id> --client-id <client-id> --client-secret - --bucket contoso-replica
atlas --profile contoso-replica tenants validate   # HeadBucket on contoso-replica
```

The profile's bucket applies to every run with `--profile contoso-replica`. Point the endpoint and keys at the replica's provider for those runs too, as below.

Point the S3 settings at the replica for one run. Environment variables override the configured endpoint and keys, so nothing on the host changes:

```bash
export ATLAS_S3_ENDPOINT=https://replica.example.com
export ATLAS_S3_ACCESS_KEY=<replica-read-only-key>
export ATLAS_S3_SECRET_KEY=<replica-read-only-secret>
export ATLAS_S3_BUCKET=<replica-bucket>   # only when the replica's name differs

atlas outlook list
atlas outlook verify -m user@example.com -s <snapshot-id>
atlas onedrive verify -o user@example.com -s <snapshot-id>
atlas sharepoint verify --site <site-url> -s <snapshot-id>
atlas outlook restore -s <snapshot-id>
atlas stats storage                     # physical bytes the replica holds
```

Give Atlas **read-only** credentials on the replica. `verify`, `list`, `stats`, and `save` never write, including the identity registry update a lookup by email would otherwise make. Under `ATLAS_S3_BUCKET` a run reaches only the selected profile's tenant; any other tenant is refused. Atlas never creates the named bucket, so a mistyped name fails instead of starting an empty store. A restore takes an [owner lease](/operations/storage-layout#owner-leases) when it can write, and with read-only credentials it runs without one and says so. A backup pointed at a replica by mistake then fails on its first write instead of forking the history.

::: danger Never back up into a replica
Backups write manifests, cursors, and the summary index. Written into a replica, they diverge from the primary, and the provider may overwrite them on its next sync. Keep backups on the primary and give the Atlas host no write access to the replica.
:::

### Leases on a replica

Provider replication copies the [lease objects](/operations/storage-layout#owner-leases) a running backup writes. A lease expires 5 minutes after its holder last renewed it. A restore from the replica may therefore refuse an owner with exit code `12` for up to 5 minutes after the primary's backup of that owner stopped. Wait and rerun.

## Consistency

Providers replicate object by object, in no guaranteed order. A copy taken while a backup runs can hold a manifest before every object it references has arrived.

- Schedule `rclone` and `mc mirror` runs after the backups finish.
- Run `verify --fast` against the replica on a schedule. It checks that every referenced object exists with one `HeadObject` per key and downloads nothing.
- Run a full `verify` on the replica periodically. It downloads, decrypts, and hashes every object, which is the only proof the replica restores.

## Deletes and immutability

A replica protects you only if deletions on the primary do not reach it.

| Setting | Recommendation | Why |
| --- | --- | --- |
| Delete-marker replication | Off | Otherwise an `atlas delete`, a purge, or an attacker with primary credentials deletes the replica too. |
| Copy tools | `rclone copy` or `mc mirror` without `--remove` | `rclone sync` deletes on the destination whatever is gone from the source. |
| Object Lock | On, on the replica bucket | Locks set on the primary are not carried to a bucket without its own Object Lock. Enable it when you create the replica bucket. See [Immutability](/operations/immutability). |
| Credentials | Separate keys per bucket | Primary keys must not be able to delete on the replica. |

Retention on the replica means `atlas delete` on the primary no longer removes that data everywhere. Plan erasure requests with the replica's retention in mind.

## Key rotation and replicas

All copies share the passphrase and the tenant data key. `atlas keys rewrap` writes a new `_meta/dek.enc` on the primary, and provider replication carries it to the replica as a new version. A copy tool carries it on its next run.

Older versions of `_meta/dek.enc`, wrapped under the old passphrase, stay on a versioned replica. AWS S3 never replicates a delete that names a version, so removing old wrappers on the primary does not remove them on the replica. Delete them on the replica too when a passphrase is retired because it leaked.

## Legacy Atlas 6 objects

Atlas 6 wrote replication status records under `_meta/replication/` in the primary bucket and `_meta/replica.marker` in each replica. Atlas 7 writes neither and reads neither.

They are inert. `atlas stats storage` counts them under `meta`, a tenant purge deletes them, and `atlas outlook delete -m` still removes the records of the snapshots it deletes. To remove the rest once, run against the primary bucket:

```bash
aws s3 rm --recursive s3://atlas-<tenant-id>/_meta/replication/
# or, for MinIO
mc rm --recursive --force <alias>/atlas-<tenant-id>/_meta/replication/
```

Objects still under Object Lock retention are refused until it expires.

## See also

- [Replica setup](/self-hosting/replication): provider replication and copy tools, step by step
- [Immutability](/operations/immutability): Object Lock on the replica bucket
- [Storage layout](/operations/storage-layout): the objects a replica holds
