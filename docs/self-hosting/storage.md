# Storage Setup

Atlas stores backups in any S3-compatible object storage. For self-hosted deployments, MinIO running in Docker is the recommended option.

## Storage Backend: MinIO on Docker

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
