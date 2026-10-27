---
description: Run MinIO in Docker as the S3-compatible bucket for self-hosted Atlas, and plan its redundancy, permissions, and filesystem for a safe archive.
---

# Storage setup

Atlas writes backups to any S3-compatible object store. For self-hosted deployments, run MinIO in Docker. The bucket is where your backups live, so its redundancy, permissions, and filesystem determine how safe the archive is.

## MinIO on Docker

The repository's `docker/docker-compose.yml` starts MinIO with a named volume:

```yaml
services:
  minio:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
    container_name: atlas-minio
    ports:
      - '${MINIO_API_PORT:-9000}:9000'
      - '${MINIO_CONSOLE_PORT:-9001}:9001'
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
    volumes:
      - minio_data:/data
    command: server /data --console-address ":9001"

volumes:
  minio_data:
```

A named volume is fine for development. For production, store data on a disk you choose, as described below.

- The image comes from `quay.io`. Docker Hub refuses anonymous pulls of `minio/minio`, which makes `docker compose up` fail with `pull access denied`.
- The tag is pinned to a release rather than `latest`. Object Lock and versioning behaviour differs between MinIO releases, and immutable backups depend on both. Bump the tag deliberately, then run `atlas storage-check` to confirm the bucket still reports `lock-capable`.

### Bind mount to external storage

Replace the named volume with a bind mount to the disk or mount point that holds the backups. For a drive mounted at `/mnt/backup-drive`:

```yaml
services:
  minio:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
    container_name: atlas-minio
    ports:
      - '9000:9000'
      - '9001:9001'
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - /mnt/backup-drive/atlas-data:/data
    command: server /data --console-address ":9001"
```

Create the directory and give the MinIO container user ownership:

```bash
sudo mkdir -p /mnt/backup-drive/atlas-data
sudo chown -R 1000:1000 /mnt/backup-drive/atlas-data
```

UID `1000` is the default MinIO container user. If your image uses a different UID, check it with `docker exec atlas-minio id`.

### Filesystem

Format the volume with **ext4** or **XFS**:

- **ext4** is the default on most Linux distributions and performs well in general.
- **XFS** handles large files and sequential writes well, which matches backup data.

Do not place the MinIO data directory on NTFS, FAT32, or network filesystems such as NFS or CIFS. MinIO depends on POSIX semantics those filesystems do not provide, which can cause silent corruption or poor performance.

## Redundancy

A single drive is acceptable only for a home lab or personal testing. A single drive failure loses every backup on it. Do not use a single drive in a professional or business environment.

Redundant storage protects against hardware failure. It does not protect against deletion, ransomware, or corruption that reaches every mirror, so pair it with a second copy in another location (see [Replication setup](/self-hosting/replication)).

| RAID level                      | Minimum drives | Behaviour                                                              | Usable capacity  | Suited to                                 |
| ------------------------------- | -------------- | ---------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| **RAID 1** (mirror)             | 2              | Every write goes to both drives. Either drive can fail.                | 50% of total     | Small deployments (up to about 10 mailboxes) |
| **RAID 5** (distributed parity) | 3              | Data and one parity block per stripe. One drive can fail.              | (N-1)/N of total | Medium deployments                        |
| **RAID 6** (double parity)      | 4              | Two parity blocks per stripe. Any two drives can fail.                 | (N-2)/N of total | Large deployments with low downtime tolerance |

For most Atlas deployments, RAID 1 is the practical minimum. Linux `mdadm` or a hardware controller can build it, and it survives a single drive failure.

Example RAID 1 setup with two drives:

```bash
# Create the mirror
sudo mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc

# Format and mount
sudo mkfs.xfs /dev/md0
sudo mkdir -p /mnt/atlas-raid
sudo mount /dev/md0 /mnt/atlas-raid

# Persist the mount and the array definition
echo '/dev/md0 /mnt/atlas-raid xfs defaults 0 0' | sudo tee -a /etc/fstab
sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
```

Create the data directory owned by the MinIO container user (UID 1000) before bind-mounting it:

```bash
sudo mkdir -p /mnt/atlas-raid/atlas-data
sudo chown -R 1000:1000 /mnt/atlas-raid/atlas-data
```

Then bind-mount `/mnt/atlas-raid/atlas-data` into the MinIO container.

## Credentials and access

::: danger Change the default credentials
The default MinIO credentials (`minioadmin` / `minioadmin`) are public. Anyone who can reach the MinIO port can read, change, or delete every backup. Replace them before the service is reachable from any network.
:::

Set strong credentials in `docker/.env`. Generate a unique root password for each deployment:

```bash
openssl rand -hex 32
```

Hex output has no characters that need quoting in an env file.

```env
MINIO_ROOT_USER=atlas-backup-admin
MINIO_ROOT_PASSWORD=<output of openssl rand -hex 32>
```

Use the root account only for administration. Give Atlas a dedicated access key, scoped to the buckets it writes, through `atlas config set s3.access-key` and `atlas config set s3.secret-key`, or through `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY`. Per-command IAM permissions are described in [Security](/security#s3-permissions-by-command-class).

### TLS for network-reachable deployments

If MinIO accepts connections from other hosts, enable TLS. Backup content is always encrypted (AES-256-GCM, with SigV4 signing that never sends the secret key), but plain HTTP still exposes the rest:

- Anyone on the network path can read object keys in clear. Outlook and OneDrive keys contain Entra object IDs.
- They can see the access key ID and which owners are backed up, when, and how much data each run moved.
- They can answer an upload with a forged `200`. The backup then reports success for an object that was never stored, and only a later `atlas outlook verify` detects it.

Atlas logs one warning per run when the endpoint is plain `http://` on any host other than loopback (`localhost`, `127.0.0.0/8`, `::1`). The local Docker setup on loopback does not trigger it.

Port 9000 and 9001 are published on every host interface by `docker/docker-compose.yml`. To keep MinIO reachable from the host only, set `MINIO_API_PORT=127.0.0.1:9000` and `MINIO_CONSOLE_PORT=127.0.0.1:9001` in `docker/.env`. Docker writes its own firewall rules, which bypass `ufw` and `firewalld` INPUT rules, so a host firewall does not restrict published ports on its own.

MinIO supports TLS by placing certificate files in its configuration directory. See the [MinIO network encryption guide](https://min.io/docs/minio/linux/operations/network-encryption.html). Then set the endpoint to `https://`:

```env
ATLAS_S3_ENDPOINT="https://minio.example.com:9000"
```

## Bucket provisioning and Object Lock

Atlas creates each tenant's bucket on the first backup, named `atlas-{tenant_id}`. Since v2.1.0 it creates the bucket **lock-capable**: `CreateBucket` sets `ObjectLockEnabledForBucket: true`, which also enables versioning.

This matters because Object Lock can only be enabled when a bucket is created on MinIO, and MinIO does not allow it later. AWS S3 also accepts `PutObjectLockConfiguration` on an existing versioned bucket, which is the call `--retention-days` makes, so a legacy AWS bucket can become lock-capable that way. A lock-capable bucket with no retention policy behaves like a normal versioned bucket. Immutability starts only when a backup command receives `--retention-days`.

New buckets also receive lifecycle rules:

| Rule                                 | Effect                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Abort incomplete multipart uploads   | Aborted after 7 days                                                                      |
| Expire delete markers                | Orphaned delete markers are removed                                                       |
| `atlas-expire-noncurrent-versions`   | Noncurrent object versions expire after 30 days                                           |

Atlas does not read noncurrent versions. Its version history is stored as separate objects, so the expiry only removes superseded delta cursors and indexes.

Only write paths create buckets. Read-only commands (`list`, `read`, `status`, `verify`, `stats`, `list-users`) never create a bucket or a data key. They fail with `No backups found for tenant <id>` when the tenant has no stored key, so a mistyped `-t` cannot create an empty, billable bucket.

Check a bucket's class with `atlas storage-check -t <id>`. It reports one of:

- `lock-capable`: supports `--retention-days` immutability.
- `versioned-only (legacy)`: created before v2.1.0 with versioning but without Object Lock.
- `unversioned (legacy)`: created before versioning was enabled.

Backends that reject `ObjectLockEnabledForBucket` create a plain bucket and log a warning. Immutability does not work on those backends.

### Migrating a legacy bucket

Migrate one tenant at a time. Atlas names the bucket `atlas-<tenant_id>` on whichever endpoint it uses, and bucket names are unique per endpoint (across all of AWS S3). The replacement must therefore sit on a different endpoint, and the legacy bucket keeps its name until you retire it. On AWS S3, the in-place option above may avoid a migration.

1. **Create a lock-capable bucket** on the new endpoint with the name `atlas-<tenant_id>`: `aws s3api create-bucket --bucket atlas-<tenant_id> --object-lock-enabled-for-bucket`, or `mc mb --with-lock` for MinIO. `atlas replicate` creates a missing bucket the same way, so pre-creating only sets the region or other options.
2. **Replicate into it.** Run `atlas replicate -m <mailbox> --target-config ./new-endpoint.json` for each mailbox, `-o <owner>` for each OneDrive owner, and `--site <site-url>` for each SharePoint site. The file holds the new endpoint and its credentials, not a bucket name. Each run copies the data key first, then the snapshots, and verifies checksums. See [Replication](/operations/replication) for the ordering and safety rules.
3. **Point Atlas at the new endpoint.** Atlas resolves the bucket from the tenant ID alone, so cutover changes the endpoint and keys, not the bucket: `atlas config set s3.endpoint <new-endpoint>`, `s3.access-key`, and `s3.secret-key`. The legacy bucket on the old endpoint is no longer read.
4. **Verify.** Run `atlas storage-check -t <id>`. It should report `lock-capable`. Then run the verify command for each workload, such as `atlas outlook verify -m <mailbox> -s <snapshot-id>`.
5. **Retire the old bucket** after one full backup cycle has succeeded against the new one.

Until a tenant is migrated, its legacy bucket keeps working for backups. Only `--retention-days` is affected: on a backend that rejects Object Lock on an existing bucket, the backup fails with `ObjectLockUnsupportedError` instead of appearing immutable.

## Protecting the tenant data key

Each tenant bucket stores its wrapped data-encryption key at `_meta/dek.enc`. Atlas writes this object once, with a create-only conditional write (`If-None-Match: *`). If two processes bootstrap the same tenant at the same time, the second write fails with `412 Precondition Failed`, and that process uses the key already stored. Overwriting a live key would make every object encrypted with it permanently unreadable.

Add a bucket policy that blocks overwrites of the key object, so a buggy or outdated client cannot replace it. This example is for AWS S3, using the [`s3:if-none-match` condition key](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html):

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

::: warning Some S3-compatible stores ignore the header
Older MinIO releases, some Ceph RGW versions, and various emulators silently ignore unknown conditional headers. On those backends the create-only guarantee does not hold. Test it by writing the same key twice with `If-None-Match: *`. The second write must fail with 412. After bootstrap, Atlas also reads back the stored key and uses it, so concurrent bootstraps still converge when the header is ignored.
:::

## Object layout and billable sizes

Some providers bill each object at a minimum size, even when it is smaller. A drive with 20,000 files carries roughly 8 MB of version index data. Stored as one object per file, which older Atlas versions did, a 64 KB minimum bills those 8 MB as about 1.28 GB per month. Stored as one object per backup run, the minimum applies once.

Atlas therefore writes version indexes as one object per owner or site per run:

- OneDrive: `onedrive/index/<owner_id>/runs/<snapshot_id>.json`
- SharePoint: `sharepoint/index/<site_id>/runs/<snapshot_id>.json`

A run that stores nothing writes no index object. Buckets from earlier versions keep their per-file index objects under `.../index/<id>/files/<file_id>.json`. These stay readable, and reads merge them with the per-run objects, until you purge them.

Content blobs remain one object per file, named by a keyed hash of their content (`onedrive/data/<owner_id>/<content_name>`). Atlas does not pack several files into one object. S3 Object Lock applies to the whole object, so a pack would lock every file in it together, and the design needs range reads and compaction first.

Minimum billable sizes by provider:

| Provider                                                     | Minimum billable object size              | Note                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Hetzner Object Storage                                       | 64 KB                                     | API calls are free, so fewer larger objects cost nothing ([pricing](https://www.hetzner.com/storage/object-storage/))                   |
| Wasabi                                                       | 4 KB                                      | Plus a 90-day minimum storage duration ([pricing FAQ](https://wasabi.com/pricing/faq))                                                  |
| AWS S3 Standard                                              | None                                      |                                                                                                                                          |
| AWS S3 Standard-IA / One Zone-IA / Glacier Instant Retrieval | 128 KB                                    | Plus a 30 or 90-day minimum duration ([storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)) |
| AWS S3 Glacier Flexible Retrieval / Deep Archive             | No floor, about 40 KB metadata per object | Billed partly at the Standard rate ([S3 pricing](https://aws.amazon.com/s3/pricing/))                                                   |
| Cloudflare R2                                                | None documented                           | Billed per GB-month; Infrequent Access has a 30-day minimum ([pricing](https://developers.cloudflare.com/r2/pricing/))                   |
| Scaleway                                                     | None documented                           | Recommends objects above 1 MB for Glacier tiers ([FAQ](https://www.scaleway.com/en/docs/object-storage/faq/))                           |
| Backblaze B2                                                 | None documented                           | Some services round up to 128 KB ([cost comparison](https://www.backblaze.com/cloud-storage/pricing))                                   |
| MinIO self-hosted                                            | None                                      | The filesystem block size still applies                                                                                                  |

## Object size limits

Large files upload as a multipart stream to a staging key, then move to their content-addressed key with a server-side copy. S3 limits bound this:

| Limit                      | Value  | How Atlas stays within it                                                    |
| -------------------------- | ------ | ---------------------------------------------------------------------------- |
| Single `CopyObject` source | 5 GB   | Larger sources are promoted with ranged `UploadPartCopy` requests            |
| Object size                | 5 TB   | Not enforced by Atlas. Larger files cannot be stored in S3                   |
| Parts per multipart upload | 10,000 | 1 GiB copy parts: 10,000 parts cover 9.8 TiB, above the 5 TB limit          |

The copy happens inside the backend. No file data returns through Atlas. Ciphertext, checksum, metadata, and Object Lock retention are the same whichever request is used. Retention on a ranged copy is set when the multipart upload starts.

The practical ceiling is S3's 5 TB per object. Microsoft 365 caps a single OneDrive or SharePoint file at 250 GB, so that limit is never reached.

## Measuring a storage backend

When you run Atlas against a storage service you do not operate, provider metrics are often unavailable. An SDK host can measure the backend directly with [storage request events](/reference/storage-request-events). Each S3 request emits one event with its latency, the time it waited for a connection, SDK retries and backoff after throttling, and the payload size. The CLI does not report these events.

Two readings matter for capacity planning:

- **`networkMs` on small requests** (such as `HeadObject` and manifest reads) is the backend's latency as Atlas sees it, including the network path.
- **`retryDelayMs` with `errorType: 'SlowDown'`** means the backend is throttling Atlas. Lower the concurrency or add backend capacity.

A high `socketWaitMs` with normal `networkMs` means the backend is healthy and Atlas is queueing requests behind its own 50-connection pool.
