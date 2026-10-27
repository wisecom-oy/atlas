# Replication setup

Atlas can copy completed snapshots to one or more secondary S3-compatible stores. Keeping a second copy in another location gives you a 3-2-1 layout: three copies, on two kinds of media, with one copy off site.

This page covers deployment patterns and scheduling. For safety rules, status tracking, and disaster recovery, see [Replication](/operations/replication).

## Target configuration

A replication target is a JSON file. The three S3 fields are required. `target_id` and `s3_region` are optional:

```json
{
  "target_id": "offsite-minio",
  "s3_endpoint": "https://offsite.example.com:9000",
  "s3_access_key": "<access-key>",
  "s3_secret_key": "<secret-key>",
  "s3_region": "us-east-1"
}
```

Store the file with `chmod 600`, since it holds the secret key. Replication uses the encryption passphrase from your Atlas configuration, so the target stores ciphertext that only your passphrase can open. The target must use the same passphrase as the primary. Use `https://` for any endpoint that is not on loopback.

## Deployment patterns

### Local MinIO primary, offsite MinIO replica

Run MinIO on your backup server and a second MinIO at another site, such as a colocation facility, another office, or a VPS. After each backup, replicate to the offsite target:

```bash
atlas outlook backup -m user@company.com
atlas replicate -m user@company.com --target-config ./offsite.json

atlas onedrive backup -o user@company.com
atlas replicate -o user@company.com --target-config ./offsite.json

atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas replicate --site https://contoso.sharepoint.com/sites/Engineering --target-config ./offsite.json
```

### Local MinIO primary, cloud S3 replica

Keep fast local backups on MinIO, then replicate to AWS S3, Backblaze B2, Wasabi, or another S3-compatible cloud store for geographic separation. Only the endpoint, keys, and region in the target file change.

```json
{
  "target_id": "aws-us-east",
  "s3_endpoint": "https://s3.us-east-1.amazonaws.com",
  "s3_access_key": "<access-key>",
  "s3_secret_key": "<secret-key>",
  "s3_region": "us-east-1"
}
```

## Schedule replication

Schedule replication after the backup it copies. This crontab backs up at 2 AM and replicates at 4 AM:

```cron
# Nightly Outlook backup at 2 AM
0 2 * * * /usr/bin/atlas outlook backup -m user@company.com >> $HOME/atlas-logs/outlook-backup.log 2>&1

# Replicate the same mailbox at 4 AM
0 4 * * * /usr/bin/atlas replicate -m user@company.com --target-config /etc/atlas/offsite.json >> $HOME/atlas-logs/replicate.log 2>&1
```

Leave a gap longer than your longest backup. Two hours is a reasonable start. Adjust it to the durations you observe in the logs.

Create `~/atlas-logs` for the service account first, as in [Scheduling](/self-hosting/scheduling).

## Bandwidth

Replication sends encrypted objects over the network. The first replication of a mailbox, OneDrive owner, or SharePoint site copies all of its history, which is about the same volume as the first backup. Later replications send only new snapshots, because unchanged content is never copied twice.

Estimate the first transfer from your upload speed. For example, 50 GB over a 10 Mbps upload link takes about 11 hours.

## See also

- [Replication](/operations/replication): ordering, safety rules, replica status, and rehydration
- [Storage setup](/self-hosting/storage)
- [Scheduling and bandwidth](/self-hosting/scheduling)
