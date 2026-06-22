# Self-Hosting

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

## What's Next

| Topic | Description |
| ----- | ----------- |
| [Storage Setup](/self-hosting/storage) | Configure MinIO on Docker, bind mounts, RAID, and filesystem recommendations. |
| [Scheduling & Bandwidth](/self-hosting/scheduling) | Understand bandwidth requirements and automate backups with cron or systemd. |
| [Replication Setup](/self-hosting/replication) | Set up multi-location replication for a 3-2-1 backup strategy. |
