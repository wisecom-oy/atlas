---
description: Run Atlas on your own infrastructure, with backups in an S3-compatible bucket you control so Microsoft 365 data never has to leave your network.
---

# Self-hosting

Atlas runs on your own infrastructure. Backup data is written to an S3-compatible bucket you control, so it never has to leave your network.

## In this section

| Topic                                                 | What it covers                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Storage setup](/self-hosting/storage)                | MinIO on Docker, bind mounts, RAID, filesystem choice, and bucket provisioning. |
| [Scheduling and bandwidth](/self-hosting/scheduling)  | Bandwidth planning and automating backups with cron or systemd timers.          |
| [Replication setup](/self-hosting/replication)        | Deployment patterns for a second copy of your backups in another location.      |

## Platform recommendation

Atlas is designed and tested primarily on **Linux**. Use Ubuntu Server 22.04 or later, or Debian 12 or later, for production.

Linux suits a backup host for three reasons:

- Docker volume drivers and bind mounts perform best on Linux. Docker Desktop on macOS and Windows adds a virtual machine layer between the container and the disk.
- systemd timers and cron schedule backups without extra tooling.
- File permissions, symlinks, and mount points behave predictably, and a dedicated server carries no desktop overhead.

Atlas also runs on macOS and Windows for development and testing. The production guidance in these pages assumes Linux.

## System requirements

| Resource | Minimum                    | Recommended                                                              |
| -------- | -------------------------- | ------------------------------------------------------------------------ |
| Node.js  | 22.12 or later (SDK: 22.8) | Current LTS                                                              |
| RAM      | 1 GB                       | 2 GB or more                                                             |
| CPU      | 1 core                     | 2 cores or more                                                          |
| Disk     | Depends on mailbox sizes   | See [Storage setup](/self-hosting/storage)                               |
| Network  | Stable internet connection | Dedicated uplink, see [Scheduling and bandwidth](/self-hosting/scheduling) |

Atlas itself is lightweight. The data it moves is not: a tenant-wide backup of many large mailboxes can transfer tens or hundreds of gigabytes over HTTPS.
