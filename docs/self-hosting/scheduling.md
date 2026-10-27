# Scheduling and bandwidth

Atlas is a CLI that runs one backup and exits. Continuous protection comes from scheduling those runs. How often you can run depends on how much data each run pulls from Microsoft 365, so plan the schedule and the bandwidth together.

## Schedule with cron

Edit the crontab for the account that runs Atlas with `crontab -e`:

```cron
# Nightly Outlook incremental backup at 2 AM
0 2 * * * flock -n $HOME/atlas-logs/outlook.lock /usr/bin/atlas outlook backup -m user@company.com >> $HOME/atlas-logs/outlook-backup.log 2>&1

# Weekly Outlook full backup, ignoring delta state, every Sunday at 3 AM
0 3 * * 0 flock -n $HOME/atlas-logs/outlook.lock /usr/bin/atlas outlook backup -m user@company.com --full >> $HOME/atlas-logs/outlook-backup-full.log 2>&1

# Nightly OneDrive backup at 1 AM
0 1 * * * /usr/bin/atlas onedrive backup -o user@company.com >> $HOME/atlas-logs/onedrive-backup.log 2>&1

# Nightly SharePoint backup at 4 AM
0 4 * * * /usr/bin/atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering >> $HOME/atlas-logs/sharepoint-backup.log 2>&1
```

Stagger the workloads. Overlapping runs send more Graph API requests at once, which brings throttling sooner.

Create the log directory once as the service account: `mkdir -p ~/atlas-logs`. Cron runs as that account and cannot write to `/var/log`.

Atlas has no built-in run lock. The two Outlook lines share `outlook.lock` through `flock -n`, so a Sunday full run that starts while the nightly run is still going exits without running and writes nothing to its log. Check for a missed week.

## Schedule with systemd timers

systemd timers give you logging through the journal and a clear view of failed runs. This service and timer back up one mailbox nightly:

```ini
# /etc/systemd/system/atlas-outlook-backup.service
[Unit]
Description=Atlas Outlook backup
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/atlas outlook backup -m user@company.com
EnvironmentFile=/etc/atlas/atlas.env
```

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

Put the configuration in `/etc/atlas/atlas.env`. Atlas reads these variables from the environment:

| Variable                         | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `ATLAS_TENANT_ID`                | Microsoft 365 tenant ID                      |
| `ATLAS_CLIENT_ID`                | Application (client) ID                      |
| `ATLAS_CLIENT_SECRET`            | Client secret for the application            |
| `ATLAS_S3_ENDPOINT`              | S3 endpoint, such as `https://minio.example.com:9000` |
| `ATLAS_S3_ACCESS_KEY`            | S3 access key                                |
| `ATLAS_S3_SECRET_KEY`            | S3 secret key                                |
| `ATLAS_S3_REGION`                | S3 region, if your backend needs one         |
| `ATLAS_ENCRYPTION_PASSPHRASE`    | Passphrase that protects the tenant data key |

The file holds credentials. Restrict it to the service account with `chmod 600 /etc/atlas/atlas.env`. Atlas also reads these values from `atlas config`, from `atlas.config.json`, and from a `.env` file. Real environment variables take precedence over all of them.

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-outlook-backup.timer
```

::: tip Run at night
A 2 AM run avoids daytime internet traffic and Graph API traffic from other applications in your tenant.
:::

## Plan bandwidth

### What a run transfers

Atlas downloads **full message bodies and all attachments** from Microsoft 365 over HTTPS through the Graph API. The first run for a mailbox transfers its whole contents. Later delta runs transfer only new and changed messages, which is much less, but the first run is a significant transfer.

OneDrive and SharePoint follow the same pattern. The first backup of a large drive or document library transfers all file content. Network throughput sets how long that takes.

A tenant-wide Outlook backup runs four mailboxes in parallel by default. Four large mailboxes at once can saturate a typical office connection. No command-line flag changes this count.

### Estimated transfer

| Scenario                 | Full backup transfer | Delta sync                     |
| ------------------------ | -------------------- | ------------------------------ |
| Single 5 GB mailbox      | About 5 GB           | Only changes (typically KB to MB) |
| 10 users, average 10 GB  | About 100 GB         | Only changes per user          |
| 100 users, average 5 GB  | About 500 GB         | Only changes per user          |
| OneDrive user, 50 GB     | About 50 GB          | Only changed files             |
| SharePoint site, 200 GB  | About 200 GB         | Only changed files per library |

These figures are approximate. Actual sizes depend on attachment volume, HTML message size, and how much data each mailbox, drive, or site holds. Measure your first full tenant backup and plan from that result.

### Microsoft Graph throttling

Microsoft limits request rates regardless of your bandwidth. When you exceed a limit, the Graph API returns **HTTP 429 (Too Many Requests)**. Atlas retries with exponential backoff, up to 12 retries, and honours the `Retry-After` header. Throughput then depends on Microsoft's limits as much as on your network. See [Graph rate limits](/operations/graph-rate-limits) for the per-service pools.

## Keep the backup host off the business network

::: danger Schedule outside business hours
On a shared connection, a backup during the workday slows video calls, file transfers, and cloud applications for everyone. Schedule runs for nights or weekends.
:::

If off-hours runs are not enough, put the backup server on a **separate ISP connection or VLAN** that does not carry employee traffic. Graph API transfers then never compete with business applications.

## See also

- [Storage setup](/self-hosting/storage)
- [Replication setup](/self-hosting/replication)
- [Graph rate limits](/operations/graph-rate-limits)
