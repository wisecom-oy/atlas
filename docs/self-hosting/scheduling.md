# Scheduling & Bandwidth

Atlas is a CLI tool: it runs, performs the backup, and exits. Continuous protection means scheduling it to run automatically. How often you can run it is bounded by how much data each run pulls from Microsoft 365, so plan the schedule and the bandwidth together.

## Automated Backup Scheduling

### Using cron

```bash
# Edit crontab
crontab -e
```

Example schedules:

```cron
# Nightly Outlook incremental backup at 2 AM
0 2 * * * /usr/bin/atlas outlook backup >> /var/log/atlas-outlook-backup.log 2>&1

# Weekly Outlook full backup (ignore delta state) every Sunday at 3 AM
0 3 * * 0 /usr/bin/atlas outlook backup --full >> /var/log/atlas-outlook-backup-full.log 2>&1

# Nightly OneDrive backup at 1 AM (stagger from Outlook)
0 1 * * * /usr/bin/atlas onedrive backup -o user@company.com >> /var/log/atlas-onedrive-backup.log 2>&1

# Nightly SharePoint backup at 4 AM
0 4 * * * /usr/bin/atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering >> /var/log/atlas-sharepoint-backup.log 2>&1
```

Stagger workload schedules so concurrent Graph API traffic does not compound throttling.

### Using systemd Timers

For more robust scheduling with logging and failure tracking:

```ini
# /etc/systemd/system/atlas-outlook-backup.service
[Unit]
Description=Atlas M365 Outlook Backup
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/atlas outlook backup -m user@company.com
Environment=ATLAS_TENANT_ID=your-tenant-id
Environment=ATLAS_CLIENT_ID=your-client-id
EnvironmentFile=/etc/atlas/atlas.env
```

```ini
# /etc/systemd/system/atlas-outlook-backup.timer
[Unit]
Description=Run Atlas Outlook backup nightly

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-outlook-backup.timer
```

:::: tip Off-Hours Scheduling
A nightly 2 AM run avoids competing with daytime internet usage and with Microsoft Graph API traffic from other applications in your tenant.
::::

## Network and Bandwidth

### Why Bandwidth Matters

Atlas pulls **full message bodies and all attachments** from Microsoft 365 via the Graph API over HTTPS. For a mailbox with 10 GB of email and attachments, a full initial backup transfers approximately 10 GB over the internet. Delta (incremental) syncs after the first run only transfer new and changed messages, which is dramatically less, but that first run is a significant transfer.

OneDrive and SharePoint follow the same pattern: the first backup of a large drive or document library transfers the full file content. Large files (512 MiB and above) stream through Atlas without buffering the entire file in memory, but network throughput still limits how quickly they complete.

Tenant-wide Outlook backups multiply the requirement by the worker count (`-C 4` is the default). Four workers backing up four large mailboxes simultaneously can saturate a typical office internet connection.

### Sizing Estimates

| Scenario                 | Data Transfer (Full Backup) | Delta Sync                     |
| ------------------------ | --------------------------- | ------------------------------ |
| Single 5 GB mailbox      | ~5 GB                       | Only changes (typically KB-MB) |
| 10 users, avg 10 GB each | ~100 GB                     | Only changes per user          |
| 100 users, avg 5 GB each | ~500 GB                     | Only changes per user          |
| OneDrive user, 50 GB     | ~50 GB                      | Only changed files             |
| SharePoint site, 200 GB  | ~200 GB                     | Only changed files per library |

These are approximate. Actual sizes depend on attachment volume, HTML email sizes, and how much data is in each mailbox, drive, or site.

### Microsoft Graph API Throttling

Even with unlimited bandwidth on your side, Microsoft imposes its own limits. The Graph API returns **HTTP 429 (Too Many Requests)** when you exceed rate limits. Atlas handles this automatically with exponential backoff (up to 12 retries, honoring the `Retry-After` header), so effective throughput has a ceiling set by Microsoft rather than by your network.

Monitor your first full tenant backup to establish a real throughput baseline, then plan scheduling and capacity from it.

### Professional Deployment Guidance

:::: danger Business Network Impact
In professional environments, **always schedule backups during off-hours** (nights, weekends). Running Atlas during business hours on a shared internet connection degrades network performance for everyone: video calls drop, file downloads slow, and cloud applications become unresponsive.
::::

Where off-hours scheduling is not enough, run the backup server on a **separate ISP connection or VLAN** that does not share bandwidth with employee traffic, so Graph API transfers never compete with business-critical network usage.
