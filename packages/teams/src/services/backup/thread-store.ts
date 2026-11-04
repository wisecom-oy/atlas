import type {
  TeamsGraphResource,
  TeamsRootChange,
  TeamsStoredBlobRef,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { same_hosted_refs, store_hosted_contents } from '@/services/backup/thread-hosted-store';
import {
  digest_thread_blob,
  thread_blobs_present,
  write_blob,
} from '@/services/backup/thread-blob-writer';

/**
 * Stores one changed root and returns its entry. A root Graph reports with `deletedDateTime`
 * gets a tombstone blob and no hosted-content calls. A live root whose digest matches the previous
 * entry keeps that entry while its blobs are still in storage, so unchanged threads are not
 * uploaded again. `--full` rewrites every blob it reads.
 */
export async function store_thread(
  scope: BackupRunScope,
  channel_id: string,
  change: TeamsRootChange,
  previous: TeamsThreadEntry | undefined,
): Promise<TeamsThreadEntry> {
  scope.counters.threads_changed++;
  if (change.deleted) {
    return store_tombstone(scope, change.root, change.replies ?? [], previous);
  }
  const replies =
    change.replies ??
    (await scope.connector.list_replies(
      scope.tenant_id,
      scope.team_id,
      channel_id,
      change.root.id,
    ));
  return store_live_thread(scope, channel_id, change.root, replies, previous);
}

/**
 * Marks a thread removed from its channel without any Graph call. The entry keeps the last live
 * blob reference, so the content can still be restored.
 */
export function mark_thread_removed(
  scope: BackupRunScope,
  previous: TeamsThreadEntry,
): TeamsThreadEntry {
  if (previous.deleted_at !== undefined) {
    return previous;
  }
  scope.counters.threads_deleted++;
  return { ...previous, deleted_at: scope.backup_at, last_live: last_live_for(previous) };
}

async function store_tombstone(
  scope: BackupRunScope,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
  previous: TeamsThreadEntry | undefined,
): Promise<TeamsThreadEntry> {
  const digest = digest_thread_blob(scope, { root, replies });
  const same_tombstone =
    previous !== undefined &&
    previous.deleted_at !== undefined &&
    previous.checksum === digest.checksum;
  if (
    previous !== undefined &&
    same_tombstone &&
    !scope.force_full &&
    (await thread_blobs_present(scope, previous))
  ) {
    scope.counters.threads_deduplicated++;
    return previous;
  }
  await write_blob(scope, digest.storage_key, digest.plaintext, scope.force_full);
  scope.counters.threads_stored++;
  if (previous?.deleted_at === undefined) {
    scope.counters.threads_deleted++;
  }
  if (previous !== undefined && same_tombstone) {
    return previous;
  }
  return {
    storage_key: digest.storage_key,
    checksum: digest.checksum,
    size_bytes: digest.plaintext.length,
    last_modified_at:
      typeof root.lastModifiedDateTime === 'string' ? root.lastModifiedDateTime : '',
    reply_count: replies.length,
    hosted: previous?.hosted ?? {},
    backup_at: scope.backup_at,
    deleted_at: previous?.deleted_at ?? scope.backup_at,
    last_live: last_live_for(previous),
  };
}

async function store_live_thread(
  scope: BackupRunScope,
  channel_id: string,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
  previous: TeamsThreadEntry | undefined,
): Promise<TeamsThreadEntry> {
  const digest = digest_thread_blob(scope, { root, replies });
  const same_content = previous !== undefined && previous.checksum === digest.checksum;
  if (
    previous !== undefined &&
    same_content &&
    !scope.force_full &&
    (await thread_blobs_present(scope, previous))
  ) {
    scope.counters.threads_deduplicated++;
    return { ...previous, deleted_at: undefined, last_live: undefined };
  }
  const hosted = await store_hosted_contents(scope, channel_id, root, replies, previous);
  await write_blob(scope, digest.storage_key, digest.plaintext, scope.force_full);
  scope.counters.threads_stored++;
  if (previous !== undefined && same_content && same_hosted_refs(previous.hosted, hosted)) {
    return { ...previous, deleted_at: undefined, last_live: undefined };
  }
  return {
    storage_key: digest.storage_key,
    checksum: digest.checksum,
    size_bytes: digest.plaintext.length,
    last_modified_at:
      typeof root.lastModifiedDateTime === 'string' ? root.lastModifiedDateTime : '',
    reply_count: replies.length,
    hosted,
    backup_at: scope.backup_at,
  };
}

/** The last live blob: the entry's own blob while it is live, otherwise the one it kept. */
function last_live_for(previous: TeamsThreadEntry | undefined): TeamsStoredBlobRef | undefined {
  if (previous === undefined) {
    return undefined;
  }
  if (previous.deleted_at !== undefined) {
    return previous.last_live;
  }
  return {
    storage_key: previous.storage_key,
    checksum: previous.checksum,
    size_bytes: previous.size_bytes,
  };
}
