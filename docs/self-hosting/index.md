---
description: Run Atlas on your own infrastructure, with backups in an S3-compatible bucket you control so Microsoft 365 data never has to leave your network.
---

# Self-hosting

Atlas runs on your own infrastructure and writes backups to an S3-compatible bucket you control, so the data never has to leave your network.

## In this section

Set up a self-hosted deployment in this order:

| Step | Page | What you do |
| --- | --- | --- |
| 1 | [Storage setup](/self-hosting/storage) | Prepare redundant disks, run MinIO in Docker, secure it, and check the tenant bucket. |
| 2 | [Scheduling and bandwidth](/self-hosting/scheduling) | Plan bandwidth and run backups on a schedule with cron or systemd timers. |
| 3 | [Replica setup](/self-hosting/replication) | Keep a second copy in another location with provider replication or a copy tool. |

Once the replica exists, [Replicas](/operations/replication) covers restoring from it and verifying it.

## Platform recommendation

Run Atlas in production on **Linux**: Ubuntu Server 22.04 or later, or Debian 12 or later. Atlas is designed and tested primarily there.

- Docker volume drivers and bind mounts perform best on Linux. Docker Desktop on macOS and Windows adds a virtual machine between the container and the disk.
- systemd timers and cron schedule backups without extra tooling.
- File permissions, symlinks, and mount points behave predictably, and a dedicated server carries no desktop overhead.

Atlas also runs on macOS and Windows for development and testing. The guidance in this section assumes Linux.

## System requirements

| Resource | Minimum | Recommended |
| --- | --- | --- |
| Node.js | 22.12 or later (SDK: 22.8) | Current LTS |
| RAM | 1 GB | 2 GB or more |
| CPU | 1 core | 2 cores or more |
| Disk | Depends on mailbox sizes | See [Storage setup](/self-hosting/storage) |
| Network | Stable internet connection | Dedicated uplink, see [Scheduling and bandwidth](/self-hosting/scheduling) |

Atlas itself is lightweight. The data it moves is not: a tenant-wide backup of many large mailboxes can transfer tens or hundreds of gigabytes over HTTPS.
