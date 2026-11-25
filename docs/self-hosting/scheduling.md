---
description: Schedule Atlas backups with cron or systemd timers and plan bandwidth against how much data each Microsoft 365 run pulls.
---

# Scheduling and bandwidth

Atlas runs one backup and exits. Continuous protection comes from running it on a schedule. How often you can run depends on how much data each run pulls from Microsoft 365, so plan the schedule and the bandwidth together.

## Schedule with cron

1. As the account that runs Atlas, create the log directory. Cron runs as that account and cannot write to `/var/log`:

   ```bash
   mkdir -p ~/atlas-logs
   ```

2. Store the Microsoft Graph credentials as a tenant profile with `atlas tenants add`, as described in [Tenant profiles](/configuration#tenant-profiles).
3. Open the crontab with `crontab -e` and add one line per workload:

   ```cron
   # Nightly Outlook incremental backup at 2 AM
   0 2 * * * flock -n $HOME/atlas-logs/outlook.lock /usr/bin/atlas outlook backup -m user@example.com >> $HOME/atlas-logs/outlook-backup.log 2>&1

   # Weekly Outlook full backup, ignoring the sync checkpoint, every Sunday at 3 AM
   0 3 * * 0 flock -n $HOME/atlas-logs/outlook.lock /usr/bin/atlas outlook backup -m user@example.com --full >> $HOME/atlas-logs/outlook-backup-full.log 2>&1

   # Nightly OneDrive backup at 1 AM
   0 1 * * * /usr/bin/atlas onedrive backup -o user@example.com >> $HOME/atlas-logs/onedrive-backup.log 2>&1

   # Nightly SharePoint backup at 4 AM
   0 4 * * * /usr/bin/atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering >> $HOME/atlas-logs/sharepoint-backup.log 2>&1

   # Daily Teams backup at 5 AM, one run per day
   0 5 * * * flock -n $HOME/atlas-logs/teams.lock /usr/bin/atlas teams backup --all >> $HOME/atlas-logs/teams-backup.log 2>&1
   ```

Stagger the workloads. Overlapping runs send more Microsoft Graph requests at once, which brings throttling sooner.

### Overlapping runs

Atlas runs one operation at a time per mailbox, drive owner, site, or team. A second backup of an owner that is already being backed up exits `12` (`ATLAS_OWNER_BUSY`) and writes nothing. See [Concurrent operations](/reference/sdk#concurrent-operations).

`flock -n` stops the overlapping job before it starts. In the example, the two Outlook lines share `outlook.lock`, so a Sunday full backup that starts while the nightly run is still going exits without running and writes nothing to its log. Check for a missed week.

### Teams: once a day

Microsoft's [Teams API overview](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0) says an app may poll a resource only once a day, and that more frequent updates need change notifications. The page does not mention incremental (delta) reads. Treat Atlas's Teams backups as polling under that rule and run them once a day.

## Schedule with systemd timers

systemd timers log to the journal and show failed runs clearly.

1. Create the service, which backs up one mailbox:

   ```ini
   # /etc/systemd/system/atlas-outlook-backup.service
   [Unit]
   Description=Atlas Outlook backup
   After=network-online.target docker.service

   [Service]
   Type=oneshot
   ExecStart=/usr/bin/atlas outlook backup -m user@example.com
   EnvironmentFile=/etc/atlas/atlas.env
   ```

2. Create the timer, which runs it nightly:

   ```ini
   # /etc/systemd/system/atlas-outlook-backup.timer
   [Unit]
   Description=Run the Atlas Outlook backup nightly

   [Timer]
   OnCalendar=*-*-* 02:00:00
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

3. Store the Microsoft Graph credentials as a tenant profile: run `atlas tenants add` once as the service account, with the client secret on stdin. See [Tenant profiles](/configuration#tenant-profiles).
4. Put the rest of the configuration in `/etc/atlas/atlas.env` (variables below) and restrict it to the service account, because it holds credentials:

   ```bash
   sudo chmod 600 /etc/atlas/atlas.env
   ```

5. Enable the timer:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now atlas-outlook-backup.timer
   ```

| Variable | Purpose |
| --- | --- |
| `ATLAS_PROFILE` | Tenant profile to run, if you store several |
| `ATLAS_TENANT_ID` | Optional. Overrides the selected profile's tenant ID |
| `ATLAS_CLIENT_ID` | Optional. Overrides the selected profile's client ID |
| `ATLAS_CLIENT_SECRET` | Optional. Overrides the selected profile's client secret |
| `ATLAS_S3_ENDPOINT` | S3 endpoint, such as `https://minio.example.com:9000` |
| `ATLAS_S3_ACCESS_KEY` | S3 access key |
| `ATLAS_S3_SECRET_KEY` | S3 secret key |
| `ATLAS_S3_REGION` | S3 region, if your backend needs one |
| `ATLAS_S3_IDLE_TIMEOUT_MS` | Optional. How long an S3 request may stay silent before the attempt fails, default 5 minutes. See [S3 timeouts and retries](/self-hosting/storage#s3-timeouts-and-retries) |
| `ATLAS_ENCRYPTION_PASSPHRASE` | Passphrase that protects the tenant data key |

Atlas also reads S3 and passphrase settings from `atlas config`, from `atlas.config.json`, and from a `.env` file. Real environment variables take precedence over all of them. See [Configuration](/configuration).

## Plan bandwidth

### What a run transfers

Atlas downloads **full message bodies and all attachments** from Microsoft 365 over HTTPS. The first backup of a mailbox transfers its whole contents. Later incremental backups transfer only new and changed messages.

OneDrive and SharePoint follow the same pattern. The first backup of a large drive or document library transfers all file content, and network throughput sets how long that takes.

Each `atlas outlook backup` backs up one mailbox, so parallelism is whatever your scheduler starts at once. Four large mailboxes at once can saturate a typical office connection.

### Estimated transfer

| Scenario | Full backup transfer | Incremental backup |
| --- | --- | --- |
| Single 5 GB mailbox | About 5 GB | Only changes (typically KB to MB) |
| 10 users, average 10 GB | About 100 GB | Only changes per user |
| 100 users, average 5 GB | About 500 GB | Only changes per user |
| OneDrive user, 50 GB | About 50 GB | Only changed files |
| SharePoint site, 200 GB | About 200 GB | Only changed files per library |

These figures are approximate. Actual sizes depend on attachment volume, HTML message size, and how much each mailbox, drive, or site holds. Measure your first full tenant backup and plan from that.

### Microsoft Graph throttling

Microsoft limits request rates regardless of your bandwidth. When Microsoft 365 throttles a request (HTTP 429, Too Many Requests), Atlas waits as long as the `Retry-After` header asks, backs off exponentially, and retries up to 12 times. Throughput then depends on Microsoft's limits as much as on your network. See [Graph rate limits](/operations/graph-rate-limits) for the per-service limits.

## Keep the backup host off the business network

::: danger Schedule outside business hours
On a shared connection, a backup during the workday slows video calls, file transfers, and cloud applications for everyone. Schedule runs for nights or weekends.
:::

::: tip Run at night
A 2 AM run avoids daytime internet traffic and Microsoft Graph traffic from other applications in your tenant.
:::

If off-hours runs are not enough, put the backup server on a **separate ISP connection or VLAN** that carries no employee traffic. Backup transfers then never compete with business applications.

## See also

- [Storage setup](/self-hosting/storage)
- [Replica setup](/self-hosting/replication)
- [Graph rate limits](/operations/graph-rate-limits)
