import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { BucketStats, MailboxStats, FolderStats, MonthlyBreakdown } from '@/domain/stats';

interface EntryAccumulator {
  readonly message_size: number;
  readonly att_count: number;
  readonly att_size: number;
}

/** Extracts message size and attachment totals from a single manifest entry. */
function accumulate_entry_stats(entry: ManifestEntry): EntryAccumulator {
  let att_count = 0;
  let att_size = 0;

  if (entry.attachments) {
    for (const att of entry.attachments) {
      att_count += 1;
      att_size += att.size_bytes;
    }
  }

  return { message_size: entry.size_bytes, att_count, att_size };
}

/** Formats a Date as a "YYYY-MM" string for monthly grouping. */
function to_month_key(date: Date): string {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Aggregates bucket-wide statistics across all mailboxes in a single pass. */
export function aggregate_bucket_stats(
  tenant_id: string,
  manifests: readonly Manifest[],
): BucketStats {
  const mailbox_ids = new Set<string>();
  let total_messages = 0;
  let total_size = 0;
  let att_count = 0;
  let att_size = 0;

  const monthly = new Map<
    string,
    { snapshots: number; messages: number; size: number; att_count: number; att_size: number }
  >();

  for (const manifest of manifests) {
    mailbox_ids.add(manifest.mailbox_id);

    const key = to_month_key(manifest.created_at);
    const bucket = monthly.get(key) ?? {
      snapshots: 0,
      messages: 0,
      size: 0,
      att_count: 0,
      att_size: 0,
    };
    bucket.snapshots += 1;

    for (const entry of manifest.entries) {
      const acc = accumulate_entry_stats(entry);
      total_messages += 1;
      total_size += acc.message_size + acc.att_size;
      att_count += acc.att_count;
      att_size += acc.att_size;

      bucket.messages += 1;
      bucket.size += acc.message_size + acc.att_size;
      bucket.att_count += acc.att_count;
      bucket.att_size += acc.att_size;
    }

    monthly.set(key, bucket);
  }

  return {
    tenant_id,
    mailbox_count: mailbox_ids.size,
    snapshot_count: manifests.length,
    total_messages,
    total_size_bytes: total_size,
    attachment_count: att_count,
    attachment_size_bytes: att_size,
    monthly_breakdown: build_sorted_breakdown(monthly),
  };
}

/** Aggregates statistics for a single mailbox from its manifests. */
export function aggregate_mailbox_stats(
  mailbox_id: string,
  manifests: readonly Manifest[],
): MailboxStats {
  let total_messages = 0;
  let total_size = 0;
  let att_count = 0;
  let att_size = 0;

  const folder_map = new Map<
    string,
    { messages: number; size: number; att_count: number; att_size: number }
  >();
  const monthly = new Map<
    string,
    { snapshots: number; messages: number; size: number; att_count: number; att_size: number }
  >();

  for (const manifest of manifests) {
    const month_key = to_month_key(manifest.created_at);
    const month_bucket = monthly.get(month_key) ?? {
      snapshots: 0,
      messages: 0,
      size: 0,
      att_count: 0,
      att_size: 0,
    };
    month_bucket.snapshots += 1;

    for (const entry of manifest.entries) {
      const acc = accumulate_entry_stats(entry);
      const entry_total = acc.message_size + acc.att_size;

      total_messages += 1;
      total_size += entry_total;
      att_count += acc.att_count;
      att_size += acc.att_size;

      month_bucket.messages += 1;
      month_bucket.size += entry_total;
      month_bucket.att_count += acc.att_count;
      month_bucket.att_size += acc.att_size;

      const folder_id = entry.folder_id ?? 'unknown';
      const folder = folder_map.get(folder_id) ?? {
        messages: 0,
        size: 0,
        att_count: 0,
        att_size: 0,
      };
      folder.messages += 1;
      folder.size += entry_total;
      folder.att_count += acc.att_count;
      folder.att_size += acc.att_size;
      folder_map.set(folder_id, folder);
    }

    monthly.set(month_key, month_bucket);
  }

  return {
    mailbox_id,
    snapshot_count: manifests.length,
    total_messages,
    total_size_bytes: total_size,
    attachment_count: att_count,
    attachment_size_bytes: att_size,
    folders: build_sorted_folders(folder_map),
    monthly_breakdown: build_sorted_breakdown(monthly),
  };
}

/** Groups manifest entries by folder_id in a single pass. */
export function aggregate_folder_stats(entries: readonly ManifestEntry[]): FolderStats[] {
  const folder_map = new Map<
    string,
    { messages: number; size: number; att_count: number; att_size: number }
  >();

  for (const entry of entries) {
    const acc = accumulate_entry_stats(entry);
    const folder_id = entry.folder_id ?? 'unknown';
    const folder = folder_map.get(folder_id) ?? { messages: 0, size: 0, att_count: 0, att_size: 0 };
    folder.messages += 1;
    folder.size += acc.message_size + acc.att_size;
    folder.att_count += acc.att_count;
    folder.att_size += acc.att_size;
    folder_map.set(folder_id, folder);
  }

  return build_sorted_folders(folder_map);
}

/** Groups manifests by calendar month in a single pass. */
export function aggregate_monthly_breakdown(manifests: readonly Manifest[]): MonthlyBreakdown[] {
  const monthly = new Map<
    string,
    { snapshots: number; messages: number; size: number; att_count: number; att_size: number }
  >();

  for (const manifest of manifests) {
    const key = to_month_key(manifest.created_at);
    const bucket = monthly.get(key) ?? {
      snapshots: 0,
      messages: 0,
      size: 0,
      att_count: 0,
      att_size: 0,
    };
    bucket.snapshots += 1;

    for (const entry of manifest.entries) {
      const acc = accumulate_entry_stats(entry);
      bucket.messages += 1;
      bucket.size += acc.message_size + acc.att_size;
      bucket.att_count += acc.att_count;
      bucket.att_size += acc.att_size;
    }

    monthly.set(key, bucket);
  }

  return build_sorted_breakdown(monthly);
}

/** Converts the monthly accumulator map into a sorted MonthlyBreakdown array. */
function build_sorted_breakdown(
  monthly: Map<
    string,
    { snapshots: number; messages: number; size: number; att_count: number; att_size: number }
  >,
): MonthlyBreakdown[] {
  const result: MonthlyBreakdown[] = [];

  for (const [month, data] of monthly) {
    result.push({
      month,
      snapshot_count: data.snapshots,
      message_count: data.messages,
      size_bytes: data.size,
      attachment_count: data.att_count,
      attachment_size_bytes: data.att_size,
    });
  }

  return result.sort((a, b) => a.month.localeCompare(b.month));
}

/** Converts the folder accumulator map into an alphabetically sorted FolderStats array. */
function build_sorted_folders(
  folder_map: Map<string, { messages: number; size: number; att_count: number; att_size: number }>,
): FolderStats[] {
  const result: FolderStats[] = [];

  for (const [folder_id, data] of folder_map) {
    result.push({
      folder_id,
      message_count: data.messages,
      total_size_bytes: data.size,
      attachment_count: data.att_count,
      attachment_size_bytes: data.att_size,
    });
  }

  return result.sort((a, b) => a.folder_id.localeCompare(b.folder_id));
}
