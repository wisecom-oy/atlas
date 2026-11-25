---
description: Restore from and verify a replica of your Atlas backups, using the same commands you run against the primary bucket.
---

# Replicas

Your storage provider or a copy tool keeps the second copy of your backups. Atlas restores from that copy and verifies it with the same commands it runs against the primary bucket. Setting the replica up is covered in [Replica setup](/self-hosting/replication).

```bash
# Check a replica: point the S3 settings at it for this run only
ATLAS_S3_ENDPOINT=https://replica.example.com \
ATLAS_S3_ACCESS_KEY=<replica-read-only-key> \
ATLAS_S3_SECRET_KEY=<replica-read-only-secret> \
  atlas outlook verify -m user@example.com -s <snapshot-id> --fast
```

## What a replica needs

Atlas reads a replica exactly as it reads the primary. A copy is usable when all of these hold:

| Requirement | Why |
| --- | --- |
| Every object, under the same path | Each object is encrypted (AES-256-GCM) with its path's directory as associated data, so a moved object fails to decrypt |
| `_meta/dek.enc` is copied | It is the wrapped data key. Without it nothing on the replica can be decrypted |
| The same encryption passphrase | The passphrase unwraps `_meta/dek.enc`. A replica is no use without it |
| The bucket is named `atlas-<tenant-id>`, or Atlas is told its name | Atlas derives the bucket name from the tenant ID. A replica under another name is opened with a [bucket override](/configuration#bucket-override) |

::: tip AWS S3 and Backblaze B2 replicas have another name
Bucket names on AWS S3 and Backblaze B2 are unique across the whole provider, so a replica there cannot be called `atlas-<tenant-id>`. Name it with `ATLAS_S3_BUCKET` for one run, or with `--bucket` on a tenant profile kept for the replica. The tenant ID still determines the key, so the replica opens with the same passphrase.
:::

## Restore and verify from a replica

### For one run

Environment variables override the configured endpoint and keys, so pointing one run at the replica changes nothing on the host:

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

### With a tenant profile

For a replica you use regularly, keep a tenant profile for it. It uses the same Entra app registration as the primary and adds only the bucket name:

```bash
pbpaste | atlas tenants add contoso-replica --tenant-id <tenant-id> --client-id <client-id> --client-secret - --bucket contoso-replica
atlas --profile contoso-replica tenants validate   # HeadBucket on contoso-replica
```

The profile's bucket applies to every run with `--profile contoso-replica`. Point the endpoint and keys at the replica's provider for those runs too, as above.

### Read-only access

Give Atlas **read-only** credentials on the replica. With them:

| Command | Behaviour on a read-only replica |
| --- | --- |
| `verify`, `list`, `stats`, `save` | Never write, including the identity registry update a lookup by email would otherwise make |
| Restore | Runs without an [owner lease](/operations/storage-layout#owner-leases) and says so. With write access it takes one |
| Backup pointed at the replica by mistake | Fails on its first write instead of forking the history |

Under `ATLAS_S3_BUCKET`, a run reaches only the selected profile's tenant. Any other tenant is refused. Atlas never creates the named bucket, so a mistyped name fails instead of starting an empty store.

::: danger Never back up into a replica
Backups write manifests, sync checkpoints, and the summary index. Written into a replica, they diverge from the primary, and the provider may overwrite them on its next sync. Keep backups on the primary and give the Atlas host no write access to the replica.
:::

### Leases on a replica

Provider replication copies the [lease objects](/operations/storage-layout#owner-leases) a running backup writes, and a lease expires 10 minutes after its holder last renewed it. A restore from the replica may therefore refuse an owner with exit code `12` for up to 10 minutes after the primary's backup of that owner stopped. Wait and rerun.

## Consistency

Providers replicate object by object, in no guaranteed order. A copy taken while a backup runs can hold a manifest before every object it references has arrived.

| Check | How often | What it proves |
| --- | --- | --- |
| Schedule `rclone` and `mc mirror` after the backups finish | Every copy | The copy does not catch a backup half written |
| `verify --fast` against the replica | On a schedule | Every referenced object exists. One `HeadObject` per object, nothing downloaded |
| Full `verify` against the replica | Periodically | Every object downloads, decrypts, and matches its hash. The only proof the replica restores |

## Deletes and immutability

A replica protects you only if deletions on the primary do not reach it.

| Setting | Recommendation | Why |
| --- | --- | --- |
| Delete-marker replication | Off | Otherwise an `atlas delete`, a purge, or an attacker with primary credentials deletes the replica too |
| Copy tools | `rclone copy` or `mc mirror` without `--remove` | `rclone sync` deletes on the destination whatever is gone from the source |
| Object Lock | On, on the replica bucket | Locks set on the primary are not carried to a bucket without its own Object Lock. Enable it when you create the replica bucket. See [Immutability](/operations/immutability) |
| Credentials | Separate keys per bucket | Primary keys must not be able to delete on the replica |

::: warning Erasure requests and replica retention
With retention on the replica, `atlas delete` on the primary no longer removes that data everywhere. Plan erasure requests with the replica's retention in mind.
:::

## Key rotation and replicas

All copies share the passphrase and the tenant data key. `atlas keys rewrap` writes a new `_meta/dek.enc` on the primary. Provider replication carries it to the replica as a new version, and a copy tool carries it on its next run.

Older versions of `_meta/dek.enc`, wrapped under the old passphrase, stay on a versioned replica. AWS S3 never replicates a delete that names a version, so removing old wrappers on the primary does not remove them on the replica. When you retire a passphrase because it leaked, delete those versions on the replica too.

## Legacy Atlas 6 objects

Replicas that `atlas replicate` wrote under Atlas 6 meet every requirement above. They hold the same bucket name on a different endpoint, and Atlas 7 reads them as they are. Such a replica holds no snapshot summary index, so reads against it decrypt every manifest.

Atlas 6 also wrote replication status records under `_meta/replication/` in the primary bucket and `_meta/replica.marker` in each replica. Atlas 7 neither writes nor reads them. They are inert: `atlas stats storage` counts them under `meta`, a tenant purge deletes them, and `atlas outlook delete -m` still removes the records of the snapshots it deletes. To remove the rest once, run against the primary bucket:

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
