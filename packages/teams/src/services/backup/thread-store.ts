import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  TeamsGraphResource,
  TeamsHostedContentRef,
  TeamsMessageLocator,
  TeamsRootChange,
  TeamsStoredBlobRef,
  TeamsThreadBlob,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { TEAMS_KEYS, teams_hosted_content_key } from '@/services/shared/storage-keys';

/** A thread blob ready to store: its plaintext, digest, and the key it is stored under. */
interface DigestedBlob {
  readonly plaintext: Buffer;
  readonly checksum: string;
  readonly storage_key: string;
}

/**
 * Stores one changed root and returns its entry. A root Graph reports with `deletedDateTime`
 * gets a tombstone blob and no hosted-content calls. A live root whose digest matches the previous
 * entry keeps that entry, so unchanged threads are not uploaded again.
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
  await put_once(scope, digest.storage_key, digest.plaintext);
  scope.counters.threads_stored++;
  if (previous?.deleted_at === undefined) {
    scope.counters.threads_deleted++;
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
  if (previous?.checksum === digest.checksum) {
    scope.counters.threads_deduplicated++;
    return { ...previous, deleted_at: undefined, last_live: undefined };
  }
  const hosted = await store_hosted_contents(scope, channel_id, root, replies, previous);
  await put_once(scope, digest.storage_key, digest.plaintext);
  scope.counters.threads_stored++;
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

/**
 * Stores hosted contents referenced by the root or a live reply. Messages whose body and
 * attachments do not mention `/hostedContents/` are not listed. An item already recorded on the
 * previous entry is reused, because Graph hosted-content IDs do not change content.
 */
async function store_hosted_contents(
  scope: BackupRunScope,
  channel_id: string,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
  previous: TeamsThreadEntry | undefined,
): Promise<Record<string, TeamsHostedContentRef>> {
  const targets: Array<{ message: TeamsGraphResource; locator: TeamsMessageLocator }> = [
    { message: root, locator: { team_id: scope.team_id, channel_id, root_id: root.id } },
    ...replies
      .filter((reply) => !reply.deletedDateTime)
      .map((reply) => ({
        message: reply,
        locator: { team_id: scope.team_id, channel_id, root_id: root.id, reply_id: reply.id },
      })),
  ];
  const hosted: Record<string, TeamsHostedContentRef> = {};
  for (const { message, locator } of targets) {
    const references = JSON.stringify({ body: message.body, attachments: message.attachments });
    if (!references.includes('/hostedContents/')) {
      continue;
    }
    const items = await scope.connector.list_hosted_contents(scope.tenant_id, locator);
    for (const item of items) {
      hosted[item.id] =
        previous?.hosted[item.id] ?? (await store_hosted_content(scope, locator, item));
    }
  }
  return hosted;
}

async function store_hosted_content(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  item: TeamsGraphResource,
): Promise<TeamsHostedContentRef> {
  const bytes = await scope.connector.download_hosted_content(scope.tenant_id, locator, item.id);
  const { checksum, content_name } = compute_content_digests(scope.ctx, bytes);
  const storage_key = teams_hosted_content_key(scope.team_id, content_name);
  await put_once(scope, storage_key, bytes);
  scope.counters.hosted_content_stored++;
  const content_type = typeof item.contentType === 'string' ? item.contentType : undefined;
  return { storage_key, checksum, size_bytes: bytes.length, content_type };
}

function digest_thread_blob(scope: BackupRunScope, blob: TeamsThreadBlob): DigestedBlob {
  const plaintext = Buffer.from(JSON.stringify(blob), 'utf-8');
  const { checksum, content_name } = compute_content_digests(scope.ctx, plaintext);
  return { plaintext, checksum, storage_key: TEAMS_KEYS.data_key(scope.team_id, content_name) };
}

/** Uploads a blob unless its content-addressed key already exists in storage. */
async function put_once(
  scope: BackupRunScope,
  storage_key: string,
  plaintext: Buffer,
): Promise<void> {
  if (await scope.ctx.storage.exists(storage_key)) {
    return;
  }
  await scope.ctx.storage.put(storage_key, scope.ctx.encrypt(plaintext, storage_key));
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
