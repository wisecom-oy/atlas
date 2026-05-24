# Self-Hosting Guide

Atlas is a self-hosted backup engine. You run it on your own infrastructure, and your backup data never leaves your network. This guide covers everything you need to deploy Atlas in a home lab or production environment.

## Platform Recommendation

Atlas is designed and tested primarily for **Linux** systems. We recommend Ubuntu Server 22.04+ or Debian 12+ for production deployments.

Why Linux:

- **Docker volume drivers** are most mature and performant on Linux -- no VM translation layer like Docker Desktop on macOS/Windows.
- **systemd timers and cron** provide native scheduling for automated backups without third-party tools.
- **Filesystem semantics** (permissions, symlinks, mount points) are consistent and well-understood for server workloads.
- **Lower overhead** -- no desktop environment consuming resources on a dedicated backup server.

Atlas runs on macOS and Windows for development and testing, but all production guidance in this documentation targets Linux.

## System Requirements

| Resource | Minimum                    | Recommended                            |
| -------- | -------------------------- | -------------------------------------- |
| Node.js  | 20+                        | Latest LTS                             |
| RAM      | 1 GB                       | 2+ GB                                  |
| CPU      | 1 core                     | 2+ cores                               |
| Disk     | Depends on mailbox sizes   | See storage sizing below               |
| Network  | Stable internet connection | Dedicated link (see bandwidth section) |

Atlas itself is lightweight, but the data it moves is not. A tenant-wide backup of many large mailboxes can transfer tens or hundreds of gigabytes over HTTPS.

## Network and Bandwidth

This is often the most overlooked aspect of deploying Atlas. Understanding the bandwidth profile is critical for professional environments.

### Why Bandwidth Matters

Atlas pulls **full message bodies and all attachments** from Microsoft 365 via the Graph API over HTTPS. For a mailbox with 10 GB of email and attachments, a full initial backup will transfer approximately 10 GB of data over the internet. Delta (incremental) syncs after the first run only transfer new and changed messages, which is dramatically less -- but the initial backup is a significant transfer.

When you run tenant-wide backups with multiple concurrent workers (`-C 4` is the default), the bandwidth requirement multiplies. Four workers backing up four large mailboxes simultaneously can easily saturate a typical office internet connection.

### Professional Deployment Guidance

::: danger Business Network Impact
In professional environments, **always schedule backups during off-hours** (nights, weekends). Running Atlas during business hours on a shared internet connection will degrade network performance for all users -- video calls will drop, file downloads will slow, and cloud applications will become unresponsive.
:::

For organizations where off-hours scheduling is not sufficient, the recommended approach is to run the backup server on a **separate ISP connection or VLAN** that does not share bandwidth with employee traffic. This ensures that Graph API transfers never compete with business-critical network usage.

### Microsoft Graph API Throttling

Even with unlimited bandwidth on your side, Microsoft imposes its own limits. The Graph API returns **HTTP 429 (Too Many Requests)** responses when you exceed rate limits. Atlas handles this automatically with exponential backoff (up to 12 retries, honoring the `Retry-After` header), but it means effective throughput has a ceiling set by Microsoft, not your network.

Monitor your first full tenant backup closely to understand the real-world throughput for your environment. Use this baseline to plan scheduling and capacity.

### Sizing Estimates

| Scenario                 | Data Transfer (Full Backup) | Delta Sync                     |
| ------------------------ | --------------------------- | ------------------------------ |
| Single 5 GB mailbox      | ~5 GB                       | Only changes (typically KB-MB) |
| 10 users, avg 10 GB each | ~100 GB                     | Only changes per user          |
| 100 users, avg 5 GB each | ~500 GB                     | Only changes per user          |

These are approximate -- actual sizes depend on attachment volume, HTML email sizes, and how much mail is in each mailbox.

## Storage Backend: MinIO on Docker

Atlas stores backups in any S3-compatible object storage. For self-hosted deployments, we recommend [MinIO](https://min.io/) running in Docker.

The included `docker/docker-compose.yml` starts MinIO with a Docker named volume:

```yaml
services:
  minio:
    image: minio/minio:latest
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

This is fine for development and quick testing. For real deployments, you want to control where data is stored.

### Pointing MinIO to External Storage

To store backup data on a specific disk or mount point, replace the named volume with a **bind mount**. This gives you full control over the physical storage location.

For example, if you have an external drive mounted at `/mnt/backup-drive`:

```yaml
services:
  minio:
    image: minio/minio:latest
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

Make sure the directory exists and has correct permissions:

```bash
sudo mkdir -p /mnt/backup-drive/atlas-data
sudo chown -R 1000:1000 /mnt/backup-drive/atlas-data
```

The UID `1000` matches the default MinIO container user. If your MinIO image uses a different UID, check with `docker exec atlas-minio id`.

### Filesystem Recommendations

Format the storage volume with **ext4** or **XFS**. Both are stable, well-tested Linux filesystems suitable for object storage workloads:

- **ext4** -- the default on most Linux distributions, battle-tested, good all-around performance.
- **XFS** -- excels with large files and high-throughput sequential writes, which matches the pattern of backup data.

Avoid NTFS, FAT32, or network filesystems (NFS, CIFS) for the MinIO data directory. They lack the POSIX semantics MinIO relies on and will cause subtle corruption or performance issues.

## Single Drive vs. RAID Storage

::: danger Single Drive Warning
Storing mailbox backups on a single external hard drive is acceptable **only for home labs and personal testing**. A single drive is a single point of failure -- if it fails, all backup data is permanently lost. This setup must not be deployed in any professional or business environment.
:::

### Why Redundancy Matters

The entire point of a backup system is to protect against data loss. If your backup storage itself has no redundancy, you have not actually reduced risk -- you have just moved the single point of failure from Microsoft 365 to a USB drive on your desk.

For any environment where the backup data matters (which is every environment beyond a personal lab), you need **redundant storage**.

### RAID: Redundant Array of Independent Disks

RAID is a technology that combines multiple physical hard drives into a single logical volume with built-in redundancy. If one drive fails, the data survives on the remaining drives, and you can replace the failed drive without losing anything.

| RAID Level                      | Minimum Drives | How It Works                                                                             | Usable Capacity  | Recommendation                                   |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------ |
| **RAID 1** (mirror)             | 2              | Every write goes to both drives simultaneously. Either drive can fail without data loss. | 50% of total     | Small deployments (2-10 mailboxes)               |
| **RAID 5** (distributed parity) | 3              | Data is striped across all drives with parity blocks. Any single drive can fail.         | (N-1)/N of total | Medium deployments                               |
| **RAID 6** (double parity)      | 4              | Like RAID 5 but with two parity blocks. Any two drives can fail simultaneously.          | (N-2)/N of total | Large deployments where downtime is unacceptable |

For most Atlas deployments, **RAID 1 is the practical minimum**. It is simple to set up (Linux `mdadm` or hardware RAID controller), easy to understand, and provides full protection against a single drive failure.

::: warning RAID Is Not a Backup
RAID protects against hardware failure. It does **not** protect against accidental deletion, ransomware, or corruption that propagates to all mirrors. For critical data, combine RAID with off-site replication (e.g. a second MinIO instance at another location, or periodic copies to cloud storage).
:::

### Setting Up RAID 1 on Linux

A minimal RAID 1 setup with two drives:

```bash
# Create the RAID 1 array
sudo mdadm --create /dev/md0 --level=1 --raid-devices=2 /dev/sdb /dev/sdc

# Format with XFS
sudo mkfs.xfs /dev/md0

# Create mount point and mount
sudo mkdir -p /mnt/atlas-raid
sudo mount /dev/md0 /mnt/atlas-raid

# Add to /etc/fstab for persistence
echo '/dev/md0 /mnt/atlas-raid xfs defaults 0 0' | sudo tee -a /etc/fstab

# Save RAID configuration
sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
```

Then point your MinIO bind mount to `/mnt/atlas-raid/atlas-data`.

## MinIO Security

::: danger Change Default Credentials
The default MinIO credentials (`minioadmin`/`minioadmin`) are public knowledge. Anyone who can reach your MinIO port can read, modify, or delete all backup data. **Change these immediately** in any non-development deployment.
:::

Set strong credentials in your `docker/.env`:

```env
MINIO_ROOT_USER=atlas-backup-admin
MINIO_ROOT_PASSWORD=a-long-random-passphrase-at-least-32-characters
```

### TLS for Non-Localhost Deployments

If MinIO is accessible from the network (not just `localhost`), you should enable TLS. Without it, S3 credentials and backup data travel over the network in plaintext -- anyone on the same network segment can intercept them.

MinIO supports TLS natively by placing certificate files in the container. See the [MinIO TLS documentation](https://min.io/docs/minio/linux/operations/network-encryption.html) for setup instructions. When TLS is enabled, update your Atlas endpoint to use `https://`:

```env
ATLAS_S3_ENDPOINT="https://minio.internal:9000"
```

## Automated Backup Scheduling

Atlas is a CLI tool -- it runs, performs the backup, and exits. For continuous protection, schedule it to run automatically.

### Using cron

```bash
# Edit crontab
crontab -e
```

Example schedules:

```cron
# Nightly incremental backup at 2 AM
0 2 * * * /usr/bin/atlas outlook backup >> /var/log/atlas-backup.log 2>&1

# Weekly full backup (ignore delta state) every Sunday at 3 AM
0 3 * * 0 /usr/bin/atlas outlook backup --full >> /var/log/atlas-backup-full.log 2>&1
```

### Using systemd Timers

For more robust scheduling with logging and failure tracking:

```ini
# /etc/systemd/system/atlas-backup.service
[Unit]
Description=Atlas M365 Backup
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/atlas outlook backup
Environment=ATLAS_TENANT_ID=your-tenant-id
Environment=ATLAS_CLIENT_ID=your-client-id
EnvironmentFile=/etc/atlas/atlas.env
```

```ini
# /etc/systemd/system/atlas-backup.timer
[Unit]
Description=Run Atlas backup nightly

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-backup.timer
```

::: tip Off-Hours Scheduling
For professional deployments, always schedule backups outside business hours. A nightly 2 AM run avoids competing with daytime internet usage and Microsoft Graph API traffic from other applications in your tenant.
:::

## Multi-Location Replication

Atlas supports replicating completed snapshots to one or more secondary S3-compatible storage targets. This enables 3-2-1 backup strategies where data exists on multiple storage systems in multiple locations.

### Deployment Patterns

**Local MinIO primary + offsite MinIO replica:**

Run a primary MinIO instance on your local backup server and a second MinIO instance at a remote site (colocation, another office, or a VPS). After each backup, replicate to the offsite target:

```bash
atlas outlook backup -m user@company.com
atlas replicate -m user@company.com --target-config ./offsite.json
```

**Local MinIO primary + cloud S3 replica:**

Run MinIO locally for fast backups, then replicate to AWS S3, Backblaze B2, Wasabi, or any S3-compatible cloud storage for geographic redundancy:

```json
{
  "target_id": "aws-us-east",
  "s3_endpoint": "https://s3.us-east-1.amazonaws.com",
  "s3_access_key": "AKIA...",
  "s3_secret_key": "...",
  "s3_region": "us-east-1"
}
```

### Scheduling Replication

Schedule replication after backups using a second cron entry or systemd timer:

```cron
# Nightly backup at 2 AM, replicate at 4 AM
0 2 * * * /usr/bin/atlas outlook backup >> /var/log/atlas-backup.log 2>&1
0 4 * * * /usr/bin/atlas replicate -m user@company.com --target-config /etc/atlas/offsite.json >> /var/log/atlas-replicate.log 2>&1
```

### Bandwidth Considerations

Replication transfers encrypted objects over the network. The first replication of a mailbox transfers all historical data (similar to an initial backup). Subsequent replications only transfer new snapshots. Plan bandwidth and scheduling accordingly -- replicating 50 GB of backup data to a remote site over a 10 Mbps upload link takes approximately 11 hours.

See [Replication](/operations/replication) for full operational details, security model, and disaster recovery procedures.
