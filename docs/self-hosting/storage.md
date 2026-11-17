---
description: Set up the S3-compatible bucket that holds your Atlas backups, from disks and MinIO in Docker to credentials, TLS, Object Lock, and the data key.
---

# Storage setup

Atlas writes backups to any S3-compatible object store. This page sets up a self-hosted MinIO in Docker and checks that the bucket is safe to hold the archive. The bucket's redundancy, credentials, and settings decide how well your backups survive hardware failure, mistakes, and attackers.

Set up storage in this order:

1. [Choose a storage backend](#choose-a-storage-backend).
2. [Prepare the disk](#prepare-the-disk) with redundancy and a suitable filesystem.
3. [Run MinIO in Docker](#minio-on-docker).
4. [Secure access](#credentials-and-access): credentials, network exposure, and TLS.
5. [Check the tenant bucket](#bucket-provisioning-and-object-lock) after the first backup.
6. [Protect the tenant data key](#protecting-the-tenant-data-key).

## Choose a storage backend

Any S3-compatible store works if it meets two requirements:

| Requirement | Why it matters |
| --- | --- |
| Object Lock, enabled when the bucket is created | Needed for immutable backups with `--retention-days`. Most backends, MinIO included, cannot add it to an existing bucket. See [Immutability](/operations/immutability). |
| Conditional writes (`If-None-Match`, `If-Match`) honoured | Keeps two runs from overwriting each other's state. See [Conditional writes](#conditional-writes). |

`atlas storage-check` tests both. Run it against a new backend before you rely on it.

Some providers bill each object at a minimum size even when it is smaller. Atlas keeps the object count low where it can: a OneDrive or SharePoint backup writes one version index object per owner or site per run, not one per file, and a run that stores nothing writes no index. Each backed-up file is still its own object, so many small files cost more on a provider with a high minimum.

| Provider | Minimum billable object size | Note |
| --- | --- | --- |
| Hetzner Object Storage | 64 KB | API calls are free, so fewer larger objects cost nothing ([pricing](https://www.hetzner.com/storage/object-storage/)) |
| Wasabi | 4 KB | Plus a 90-day minimum storage duration ([pricing FAQ](https://wasabi.com/pricing/faq)) |
| AWS S3 Standard | None | |
| AWS S3 Standard-IA / One Zone-IA / Glacier Instant Retrieval | 128 KB | Plus a 30 or 90-day minimum duration ([storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)) |
| AWS S3 Glacier Flexible Retrieval / Deep Archive | No floor, about 40 KB metadata per object | Billed partly at the Standard rate ([S3 pricing](https://aws.amazon.com/s3/pricing/)) |
| Cloudflare R2 | None documented | Billed per GB-month; Infrequent Access has a 30-day minimum ([pricing](https://developers.cloudflare.com/r2/pricing/)) |
| Scaleway | None documented | Recommends objects above 1 MB for Glacier tiers ([FAQ](https://www.scaleway.com/en/docs/object-storage/faq/)) |
| Backblaze B2 | None documented | Some services round up to 128 KB ([cost comparison](https://www.backblaze.com/cloud-storage/pricing)) |
| MinIO self-hosted | None | The filesystem block size still applies |

::: details Object layout and billable sizes
A drive with 20,000 files carries roughly 8 MB of version index data. Stored as one object per file, a 64 KB minimum would bill those 8 MB as about 1.28 GB per month. Stored as one object per run, the minimum applies once.

- OneDrive: `onedrive/index/<owner_id>/runs/<snapshot_id>.json`
- SharePoint: `sharepoint/index/<site_id>/runs/<snapshot_id>.json`

Buckets written by earlier versions keep per-file index objects under `.../index/<id>/files/<file_id>.json`. They stay readable, and history reads merge them with the per-run objects, until you purge them. File content is one object per file, named by a keyed hash of the content (`onedrive/data/<owner_id>/<content_name>`). Atlas does not pack several files into one object, because Object Lock applies to a whole object and would lock every file in a pack together. The full layout is in [Storage layout](/operations/storage-layout).
:::

## Prepare the disk

### Redundancy

A single drive is acceptable only for a home lab or personal testing. One drive failure loses every backup on it. Do not use a single drive in a professional or business environment.

| RAID level | Minimum drives | Behaviour | Usable capacity | Suited to |
| --- | --- | --- | --- | --- |
| **RAID 1** (mirror) | 2 | Every write goes to both drives. Either drive can fail. | 50% of total | Small deployments (up to about 10 mailboxes) |
| **RAID 5** (distributed parity) | 3 | Data and one parity block per stripe. One drive can fail. | (N-1)/N of total | Medium deployments |
| **RAID 6** (double parity) | 4 | Two parity blocks per stripe. Any two drives can fail. | (N-2)/N of total | Large deployments with low downtime tolerance |

RAID 1 is the practical minimum for most deployments. Linux `mdadm` or a hardware controller can build it.

::: warning RAID is not a backup of the backup
Redundant storage protects against hardware failure. It does not protect against deletion, ransomware, or corruption that reaches every mirror. Pair it with a second copy in another location, as described in [Replica setup](/self-hosting/replication).
:::

To build a RAID 1 mirror from two drives and prepare it for MinIO:

1. Create the mirror:

   ```bash
   sudo mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc
   ```

2. Format and mount it:

   ```bash
   sudo mkfs.xfs /dev/md0
   sudo mkdir -p /mnt/atlas-raid
   sudo mount /dev/md0 /mnt/atlas-raid
   ```

3. Persist the mount and the array definition:

   ```bash
   echo '/dev/md0 /mnt/atlas-raid xfs defaults 0 0' | sudo tee -a /etc/fstab
   sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
   ```

4. Create the data directory, owned by the MinIO container user (UID 1000):

   ```bash
   sudo mkdir -p /mnt/atlas-raid/atlas-data
   sudo chown -R 1000:1000 /mnt/atlas-raid/atlas-data
   ```

5. Bind-mount `/mnt/atlas-raid/atlas-data` into the MinIO container, as in [Store data on your own disk](#bind-mount-to-external-storage).

### Filesystem

Format the volume with **ext4** or **XFS**:

- **ext4** is the default on most Linux distributions and performs well in general.
- **XFS** handles large files and sequential writes well, which matches backup data.

Do not place the MinIO data directory on NTFS, FAT32, or network filesystems such as NFS or CIFS. MinIO depends on POSIX semantics those filesystems do not provide, which can cause silent corruption or poor performance.

## Run MinIO in Docker {#minio-on-docker}

The repository's `docker/docker-compose.yml` starts MinIO with a named volume.

1. Copy the example environment file and restrict it to your account:

   ```bash
   cd docker
   cp .env.example .env && chmod 600 .env
   ```

2. Generate a root password and set it as `MINIO_ROOT_PASSWORD` in `.env`, along with `MINIO_ROOT_USER`:

   ```bash
   openssl rand -hex 32
   ```

3. Start MinIO:

   ```bash
   docker compose up -d
   ```

   The first `up` builds the MinIO image from source, which takes about a minute and needs outbound HTTPS to Docker Hub and `proxy.golang.org`. Later starts reuse the local image.

The compose file:

```yaml
services:
  minio:
    build: minio
    image: atlas-minio:7aac2a2c5b7c
    container_name: atlas-minio
    ports:
      - '${MINIO_BIND_ADDRESS:-127.0.0.1}:${MINIO_API_PORT:-9000}:9000'
      - '${MINIO_BIND_ADDRESS:-127.0.0.1}:${MINIO_CONSOLE_PORT:-9001}:9001'
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in docker/.env}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in docker/.env, for example to the output of openssl rand -hex 32}
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9001"

volumes:
  minio_data:
```

| Variable | Default | Notes |
| --- | --- | --- |
| `MINIO_ROOT_USER` | none | Required. Compose refuses to start without it |
| `MINIO_ROOT_PASSWORD` | none | Required. Compose refuses to start while it is empty, which it is in `.env.example` |
| `MINIO_BIND_ADDRESS` | `127.0.0.1` | Host address both ports are published on. See [Network exposure](#network-exposure) |
| `MINIO_API_PORT` | `9000` | Host port for the S3 API. A port number only |
| `MINIO_CONSOLE_PORT` | `9001` | Host port for the web console. A port number only |

Without a password, `docker compose up` stops before creating anything:

```text
required variable MINIO_ROOT_PASSWORD is missing a value: Set MINIO_ROOT_PASSWORD in docker/.env, for example to the output of openssl rand -hex 32
```

About the image:

- MinIO publishes no community image any more. It stopped shipping community binaries and images in October 2025 and has since archived the `minio/minio` repository. Docker Hub removed `minio/minio`, and `quay.io` refuses anonymous pulls of it, so a compose file that pins either fails with `unauthorized` or `pull access denied`.
- `docker/minio/Dockerfile` therefore compiles the server and the `mc` client from MinIO's own source, the method MinIO's README now gives for the community edition. `go install` fetches the code through `proxy.golang.org` and checks every module against the Go checksum database, so a tampered download fails the build. The Go and Alpine base images are Docker Official Images pinned by digest.
- The server is pinned to commit `7aac2a2c5b7c`, the final head of the archived repository. It includes every fix in the last release, `RELEASE.2025-10-15T17-29-55Z`, which closed a privilege escalation through session policies ([GHSA-jjjj-jwhf-8rgr](https://github.com/minio/minio/security/advisories/GHSA-jjjj-jwhf-8rgr)) that the previously pinned `RELEASE.2025-09-07T16-13-09Z` still has. `minio --version` reports `DEVELOPMENT.2026-02-12T20-18-48Z` with that commit ID.
- The pin is a commit rather than a moving branch, because Object Lock and versioning behaviour differs between MinIO builds and immutable backups depend on both. To bump it, change `MINIO_COMMIT` in the Dockerfile and the `image:` tag in the compose file together, run `docker compose up -d --build`, then run `atlas storage-check` to confirm the bucket still reports `lock-capable`.
- The archived source receives no further security fixes. The build keeps the bundled setup working on a pinned, reviewable version, but for storage reachable from a network, weigh that against a maintained S3 backend that supports Object Lock. See [Choose a storage backend](#choose-a-storage-backend).

### Store data on your own disk {#bind-mount-to-external-storage}

A named volume is fine for development. For production, replace it with a bind mount to the disk that holds the backups. For a drive mounted at `/mnt/backup-drive`:

```yaml
services:
  minio:
    build: minio
    image: atlas-minio:7aac2a2c5b7c
    container_name: atlas-minio
    ports:
      - '${MINIO_BIND_ADDRESS:-127.0.0.1}:9000:9000'
      - '${MINIO_BIND_ADDRESS:-127.0.0.1}:9001:9001'
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?Set MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD}
    volumes:
      - /mnt/backup-drive/atlas-data:/data
    command: server /data --console-address ":9001"
```

Create the directory:

```bash
sudo mkdir -p /mnt/backup-drive/atlas-data
```

The bundled image runs MinIO as root, like the image MinIO used to publish, so existing volumes keep working and the directory needs no ownership change. If you run MinIO under another user, give that UID ownership of the directory. `docker exec atlas-minio id` shows the UID.

## Secure access {#credentials-and-access}

::: danger Root on the bucket can delete every backup
Anyone with the MinIO root credentials can read, change, or delete every backup that is not under compliance-mode Object Lock, because root may bypass governance-mode retention. The compose file has no fallback password, so a new deployment never runs on the public `minioadmin` / `minioadmin` pair. A `docker/.env` copied from an older `.env.example` still sets that pair explicitly. Replace it there.
:::

1. Generate a unique root password for each deployment. Hex output needs no quoting in an env file:

   ```bash
   openssl rand -hex 32
   ```

   ```env
   MINIO_ROOT_USER=atlas-backup-admin
   MINIO_ROOT_PASSWORD=<output of openssl rand -hex 32>
   ```

2. Use the root account only for administration. Create a dedicated access key for Atlas, scoped to the buckets it writes.
3. Give that key to Atlas with `atlas config set s3.access-key` and `atlas config set s3.secret-key`, or with `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY`. The permissions each command needs are in [Security](/security#s3-permissions-by-command-class).

### Network exposure

Both ports are published on `127.0.0.1` by default, so MinIO is reachable from the Docker host only. Docker writes its own firewall rules, which bypass `ufw` and `firewalld` INPUT rules, so a host firewall does not restrict published ports. The bind address is the control that matters.

To let Atlas on another machine reach MinIO, set the interface to listen on in `docker/.env`, and enable TLS as described below:

```env
MINIO_BIND_ADDRESS=192.168.10.20   # one LAN interface
# MINIO_BIND_ADDRESS=0.0.0.0       # every interface
```

If compose fails with `invalid IP address: 127.0.0.1:127.0.0.1`, your `docker/.env` is from an older release and sets `MINIO_API_PORT` or `MINIO_CONSOLE_PORT` to `127.0.0.1:9000`. Remove the address from those lines and keep the port number.

### TLS for network-reachable deployments

Enable TLS whenever MinIO accepts connections from other hosts. Backup content is always encrypted (AES-256-GCM, with SigV4 signing that never sends the secret key), but plain HTTP exposes the rest:

- Anyone on the network path can read object paths in clear. Outlook and OneDrive paths contain Entra object IDs.
- They can see the access key ID, which owners are backed up, when, and how much data each run moved.
- They can answer an upload with a forged `200`. The backup then reports success for an object that was never stored, and only a later `atlas outlook verify` detects it.

Atlas logs one warning per run when the endpoint is plain `http://` on any host other than loopback (`localhost`, `127.0.0.0/8`, `::1`). The local Docker setup on loopback does not trigger it.

To enable TLS, place the certificate files in MinIO's configuration directory as described in the [MinIO network encryption guide](https://min.io/docs/minio/linux/operations/network-encryption.html), then set the endpoint to `https://`:

```env
ATLAS_S3_ENDPOINT="https://minio.example.com:9000"
```

## Check the tenant bucket {#bucket-provisioning-and-object-lock}

```bash
atlas storage-check -t <tenant-id>
```

Atlas creates each tenant's bucket on the first backup, named `atlas-{tenant_id}`. It creates the bucket **lock-capable** (`ObjectLockEnabledForBucket: true`), which also enables versioning. A lock-capable bucket with no retention behaves like a normal versioned bucket. Immutability starts only when a backup command receives `--retention-days`.

`atlas storage-check` reports the bucket class:

| Bucket class | Meaning | What to do |
| --- | --- | --- |
| `lock-capable` | Supports `--retention-days` immutability | Nothing |
| `versioned-only (legacy)` | Created by Atlas before 2.1.0, with versioning but without Object Lock | [Migrate it](#migrating-a-legacy-bucket) if you need immutability |
| `unversioned (legacy)` | Created before versioning was enabled, or on a backend without Object Lock | [Migrate it](#migrating-a-legacy-bucket) if you need immutability |

It also probes conditional writes and reports any bucket default retention. It exits `1` and prints `not-ready` unless the bucket is reachable, versioned, lock-capable, supports the requested lock mode, and does not ignore conditional writes.

::: warning Object Lock is set when the bucket is created
MinIO cannot enable Object Lock on an existing bucket, and Atlas never enables it on one. On a bucket without Object Lock, a backup with `--retention-days` fails with `ObjectLockUnsupportedError` instead of appearing immutable. Backups without retention keep working.
:::

Backends that do not implement `ObjectLockEnabledForBucket` (`NotImplemented`), or that reject it with an error naming Object Lock, get a plain bucket and a warning. Immutability does not work there: `storage-check` reports `unversioned (legacy)`, and a backup with `--retention-days` fails before writing anything. Any other creation error, such as `InvalidArgument` without Object Lock wording, aborts bucket creation rather than leaving an unlocked bucket behind.

New buckets also get lifecycle rules:

| Rule | Effect |
| --- | --- |
| Abort incomplete multipart uploads | Aborted after 7 days |
| Expire delete markers | Orphaned delete markers are removed |
| `atlas-expire-noncurrent-versions` | Noncurrent object versions expire after 30 days |

Atlas never reads noncurrent versions. Its own version history is stored as separate objects, so the expiry removes only superseded sync checkpoints, indexes, and [owner leases](#owner-leases-and-conditional-writes). A bucket Atlas did not create, such as one opened with a [bucket override](/configuration#bucket-override), has none of these rules.

Only commands that write create a bucket. Read-only commands (`list`, `read`, `status`, `verify`, `stats`, `list-users`) never create a bucket or a data key. They fail with `No backups found for tenant <id>` when the tenant has no stored key, so a mistyped `-t` cannot create an empty, billable bucket.

::: details Two runs creating the same bucket
When two runs start the first backup of a tenant at once, both see the bucket missing and both send `CreateBucket`.

| Backend answer | What Atlas does |
| --- | --- |
| `BucketAlreadyOwnedByYou` (AWS outside us-east-1, MinIO) | The losing run uses the bucket the other created |
| Success (AWS us-east-1, Ceph RGW) | Both runs proceed |
| `BucketAlreadyExists` | Another account owns the name. The run fails rather than write tenant data next to it |

Ceph RGW with `rgw_bucket_eexist_override` enabled returns `BucketAlreadyExists` for your own bucket too, and the run fails there as well.
:::

### Removing a bucket default retention

```bash
# AWS S3: rewrite the configuration without a rule
aws s3api put-object-lock-configuration --bucket atlas-<tenant_id> \
  --object-lock-configuration ObjectLockEnabled=Enabled

# MinIO
mc retention clear --default <alias>/atlas-<tenant_id>
```

Atlas locks each object it writes and needs no bucket default retention. OneDrive and SharePoint backups with `--retention-days` set one before 6.1.0, and `atlas storage-check` reports it when it finds one. Remove it, because a leftover default locks objects that should not be locked:

- every write of a run without `--retention-days`
- the staging copy of every large file, which stays as a locked noncurrent version for the full period after Atlas deletes it
- every version of every [owner lease](#owner-leases-and-conditional-writes)

Removing the default changes no existing object. Objects already written keep their retain-until date, and runs with `--retention-days` keep locking what they write. In `COMPLIANCE` mode, removing the default is allowed even though the locked objects themselves cannot be shortened.

### Migrating a legacy bucket

On AWS S3, which accepts `PutObjectLockConfiguration` on an existing versioned bucket, a legacy bucket can be made lock-capable in place, once:

```bash
aws s3api put-object-lock-configuration --bucket atlas-<tenant_id> \
  --object-lock-configuration ObjectLockEnabled=Enabled
```

::: warning This is permanent
AWS cannot disable Object Lock once it is on. Atlas never makes this call itself. OneDrive and SharePoint backups with `--retention-days` before 6.1.0 did, as a side effect of setting a bucket default retention.
:::

Everywhere else, move the tenant to a new lock-capable bucket. Atlas names the bucket `atlas-<tenant_id>` on whichever endpoint it uses, and bucket names are unique per endpoint (across all of AWS S3), so the new bucket must be on a different endpoint. Migrate one tenant at a time:

1. **Create a lock-capable bucket** named `atlas-<tenant_id>` on the new endpoint: `aws s3api create-bucket --bucket atlas-<tenant_id> --object-lock-enabled-for-bucket`, or `mc mb --with-lock` for MinIO.
2. **Copy into it.** Stop scheduled backups, then run `rclone copy legacy:atlas-<tenant_id> new:atlas-<tenant_id> --checksum` or `mc mirror legacy/atlas-<tenant_id> new/atlas-<tenant_id>`. Every object must keep its path, including `_meta/dek.enc`, because each object is encrypted with its location as associated data. See [Replica setup](/self-hosting/replication#rclone-or-mc-mirror).
3. **Point Atlas at the new endpoint.** Atlas finds the bucket from the tenant ID alone, so cutover changes the endpoint and keys, not the bucket name: `atlas config set s3.endpoint <new-endpoint>`, `s3.access-key`, and `s3.secret-key`. Atlas no longer reads the old bucket.
4. **Verify.** `atlas storage-check -t <id>` should report `lock-capable`. Then run the verify command for each workload, such as `atlas outlook verify -m <mailbox> -s <snapshot-id>`.
5. **Retire the old bucket** after one full backup cycle has succeeded against the new one.

Until a tenant is migrated, its legacy bucket keeps working for backups. Only `--retention-days` is affected.

## Protecting the tenant data key

Each tenant bucket stores its wrapped data key at `_meta/dek.enc`. Overwriting it would make every object encrypted with it permanently unreadable, so Atlas writes it once, create-only (`If-None-Match: *`). If two processes set up the same tenant at once, the second write fails with `412 Precondition Failed` and that process uses the key already stored.

Add a bucket policy that blocks overwrites, so a buggy or outdated client cannot replace the key. This example is for AWS S3, using the [`s3:if-none-match` condition key](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyDekOverwrite",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::atlas-*/_meta/dek.enc",
      "Condition": { "StringNotEquals": { "s3:if-none-match": "*" } }
    }
  ]
}
```

More ways to protect the key are in [The DEK object](/operations/storage-layout#the-dek-object).

## Conditional writes

```bash
atlas storage-check   # the `Conditional writes` row must read `supported`
```

Several objects depend on the backend refusing a write with `412` when its condition fails: the data key, snapshot manifests, owner leases, and the identity registry. `atlas storage-check` probes this and reports `supported`, `IGNORED`, or `not probed`.

::: warning Some S3-compatible stores ignore the header
Older MinIO releases, some Ceph RGW versions, and various emulators silently ignore unknown conditional headers. To test by hand, write the same object twice with `If-None-Match: *`, and overwrite an object with `If-Match` set to a stale ETag. Both writes must fail with 412. On a backend that ignores them, run one backup per tenant at a time. After setup, Atlas reads back the stored data key and uses it, so two simultaneous first runs still agree on one key.
:::

### Create-only snapshot objects and the read-back

```text
onedrive/manifests/<owner-id>/od-snap-1767225600000-a1b2c3.json   # PUT with If-None-Match: *, then one GET
onedrive/_meta/<owner-id>/delta.json                              # plain PUT, then one GET
```

Snapshot manifests, OneDrive and SharePoint version indexes, and Teams snapshot indexes are never rewritten, so Atlas writes them create-only like the data key. This needs nothing beyond what the data key needs. On a store that ignores the header, a snapshot ID collision overwrites instead of failing. Sync checkpoints are overwritten by every run and carry no condition.

After the upload, Atlas reads each manifest, run index, Teams index, and sync checkpoint back and compares it with what it sent. That is one `GET` of the object's own size per object, a fixed number per run:

| Workload | Extra `GET` requests per mailbox, owner, site, or team per run |
| --- | --- |
| Outlook | 2: manifest and cursor |
| OneDrive, SharePoint | 3: manifest, version index, and cursor |
| Contacts, Calendar | 2: manifest and cursor |
| Teams | 1: snapshot index |

A run that changed nothing writes no snapshot and reads back only its cursor. The read-back needs no new permission, because backups already read from the bucket. See [Metadata is checked before and after it is stored](/security#metadata-is-checked-before-and-after-it-is-stored) for what each step proves.

### Owner leases and conditional writes

Atlas runs one operation at a time per mailbox, drive owner, site, or team. A backup, restore, deletion, or quarantine holds a small unencrypted lease object for its owner, and a second operation on the same owner fails with `ATLAS_OWNER_BUSY` (exit `12`) instead of overwriting the first one's state. A purge or key re-wrap holds one tenant lease, `_meta/tenant-lease.json`, and every owner operation of the tenant checks it. See [Concurrent operations](/reference/sdk#concurrent-operations) and [Owner leases](/operations/storage-layout#owner-leases).

| Consideration | Detail |
| --- | --- |
| Backend | Must refuse a create-only write onto an existing object and a compare-and-swap with a stale ETag, both with `412`. A backend that accepts them lets two runs hold one lease for up to 60 seconds |
| Requests | Per operation: 2 to acquire and 2 to release, 3 when the delete is refused. While it runs: 2 per minute, one `GET` and one `PUT` of about 200 bytes. Nothing per object |
| Permissions | `s3:PutObject` and `s3:GetObject` on the lease objects, and `s3:DeleteObject` to remove a lease when its run ends |
| Delete denied | Under a policy that denies `DeleteObject`, such as on `_meta/*`, the run marks its lease released with a conditional `PUT`, and the object stays as a free lease |
| Versioned bucket | Each renewal replaces the lease, leaving one noncurrent version per minute of the run, plus a delete marker. The `atlas-expire-noncurrent-versions` and delete marker rules remove them |
| Other buckets | A bucket Atlas did not create has no such rule. Add a noncurrent-version expiry, or the lease versions accumulate |
| Default retention | A lease is never written with retention, but a bucket default retention locks every version of it. See [Removing a bucket default retention](#removing-a-bucket-default-retention) |
| Clocks | Hosts that share a bucket must agree on the time to within a few minutes, because expiry compares one host's timestamp with another host's clock |

A 6-hour backup renews its lease 360 times, which in a versioned bucket is about 72 KB of noncurrent versions until the lifecycle rule removes them.

::: details How a lease is taken
The lease is taken with `If-None-Match: *`, renewed and taken over with `If-Match`, and read back after every acquire.
:::

### The identity registry under concurrent runs

```text
identity-registry.json  # one per tenant bucket, encrypted
```

Backups record every user they look up by email in one tenant-wide object, `identity-registry.json`. It is the only record of departed users that Microsoft 365 no longer resolves. Several backups of one tenant can run at once and each may add users, so every write is a compare-and-swap:

- The first registry is written create-only (`If-None-Match: *`).
- Every later write carries the ETag the registry was read at (`If-Match`).
- On `412 Precondition Failed`, or the `409 ConditionalRequestConflict` S3 returns when two conditional writes arrive together, Atlas re-reads the registry, applies its change on top of the other writer's, and tries again. After 8 attempts with a short jittered pause, the run fails with `ATLAS_STORAGE_FAILURE`.

On a backend that ignores `If-Match`, the last writer wins and concurrent runs can drop each other's new entries. If `storage-check` does not report `supported`, run one backup per tenant at a time.

## Object size limits

Large files upload as a multipart stream to a staging object, then move to their final path with a server-side copy. S3 limits bound this:

| Limit | Value | How Atlas stays within it |
| --- | --- | --- |
| Single `CopyObject` source | 5 GB | Larger sources are promoted with ranged `UploadPartCopy` requests |
| Object size | 5 TB | Not enforced by Atlas. Larger files cannot be stored in S3 |
| Parts per multipart upload | 10,000 | 1 GiB copy parts: 10,000 parts cover 9.8 TiB, above the 5 TB limit |

The copy happens inside the backend, so no file data returns through Atlas. Ciphertext, checksum, metadata, and Object Lock retention are the same whichever request is used. Retention on a ranged copy is set when the multipart upload starts.

The practical ceiling is S3's 5 TB per object. Microsoft 365 caps a single OneDrive or SharePoint file at 250 GB, so that limit is never reached.

## Measuring a storage backend

When you run Atlas against a storage service you do not operate, provider metrics are often unavailable. An SDK host can measure the backend with [storage request events](/reference/storage-request-events): one event per S3 request with its latency, the time it waited for a connection, SDK retries and backoff after throttling, and the payload size. The CLI does not report these events.

| Reading | Meaning |
| --- | --- |
| `networkMs` on small requests (`HeadObject`, manifest reads) | The backend's latency as Atlas sees it, including the network path |
| `retryDelayMs` with `errorType: 'SlowDown'` | The backend is throttling Atlas. Lower the concurrency or add backend capacity |
| High `socketWaitMs` with normal `networkMs` | The backend is healthy. Atlas is queueing requests behind its own 50-connection pool |

## See also

- [Storage layout](/operations/storage-layout): every object in the bucket
- [Immutability](/operations/immutability): Object Lock and retention
- [Scheduling and bandwidth](/self-hosting/scheduling)
- [Replica setup](/self-hosting/replication)
