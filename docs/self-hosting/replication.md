# Replication Setup

Atlas supports replicating completed snapshots to one or more secondary S3-compatible storage targets. This enables 3-2-1 backup strategies where data exists on multiple storage systems in multiple locations.

Replication covers all workloads -- Outlook mailboxes, OneDrive owners, and SharePoint sites share the same encrypted object store and replication engine.

## Deployment Patterns

**Local MinIO primary + offsite MinIO replica:**

Run a primary MinIO instance on your local backup server and a second MinIO instance at a remote site (colocation, another office, or a VPS). After each backup, replicate to the offsite target:

```bash
atlas outlook backup -m user@company.com
atlas replicate -m user@company.com --target-config ./offsite.json

atlas onedrive backup -o user@company.com
# OneDrive snapshots replicate with the same tenant bucket and DEK

atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas replicate --site https://contoso.sharepoint.com/sites/Engineering --target-config ./offsite.json
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

## Scheduling Replication

Pair replication with backup scheduling by adding a second cron entry that runs after the backup completes:

```cron
# Nightly Outlook backup at 2 AM, replicate at 4 AM
0 2 * * * /usr/bin/atlas outlook backup >> /var/log/atlas-outlook-backup.log 2>&1
0 4 * * * /usr/bin/atlas replicate -m user@company.com --target-config /etc/atlas/offsite.json >> /var/log/atlas-replicate.log 2>&1
```

The two-hour gap between backup and replication gives time for a large backup to complete before replication starts. Adjust based on your observed backup durations.

## Bandwidth Considerations

Replication transfers encrypted objects over the network. The first replication of a mailbox, OneDrive owner, or SharePoint site transfers all historical data (similar in volume to the initial backup). Subsequent replications only transfer new snapshots -- the same content-addressed deduplication that saves space on primary also means unchanged objects are never re-copied.

Plan bandwidth and scheduling accordingly: replicating 50 GB of backup data to a remote site over a 10 Mbps upload link takes approximately 11 hours.

## Full Operational Detail

The information above covers the self-hosting setup perspective. For the complete replication reference -- including the shared encryption model, DEK mismatch protection, replica markers, the `atlas rehydrate` disaster recovery procedure, and replication status tracking -- see [Replication](/operations/replication).
