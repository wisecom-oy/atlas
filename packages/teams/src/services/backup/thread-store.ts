import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  TeamsGraphResource,
  TeamsHostedContentRef,
  TeamsMessageLocator,
  TeamsThreadBlob,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { TEAMS_KEYS, teams_hosted_content_key } from '@/services/shared/storage-keys';

/**
 * Stores one changed root thread and returns its entry. The thread blob is written only when its
 * digest differs from the previous entry; an identical thread keeps the previous entry.
 */
export async function store_thread(
  scope: BackupRunScope,
  channel_id: string,
  root: TeamsGraphResource,
  previous: TeamsThreadEntry | undefined,
): Promise<TeamsThreadEntry> {
  scope.counters.threads_changed++;
  const replies = await scope.connector.list_replies(
    scope.tenant_id,
    scope.team_id,
    channel_id,
    root.id,
  );
  const blob: TeamsThreadBlob = { root, replies };
  const plaintext = Buffer.from(JSON.stringify(blob), 'utf-8');
  const { checksum, content_name } = compute_content_digests(scope.ctx, plaintext);
  if (previous?.checksum === checksum) {
    scope.counters.threads_deduplicated++;
    return { ...previous, deleted_at: undefined };
  }
  const hosted = await store_hosted_contents(scope, channel_id, root.id, replies, previous);
  const storage_key = TEAMS_KEYS.data_key(scope.team_id, content_name);
  await scope.ctx.storage.put(storage_key, scope.ctx.encrypt(plaintext, storage_key));
  scope.counters.threads_stored++;
  return {
    storage_key,
    checksum,
    size_bytes: plaintext.length,
    last_modified_at:
      typeof root.lastModifiedDateTime === 'string' ? root.lastModifiedDateTime : '',
    reply_count: replies.length,
    hosted,
    backup_at: scope.backup_at,
  };
}

/**
 * Stores every hosted content of the root and its live replies. An item already recorded on the
 * previous entry is reused, because Graph hosted-content IDs do not change content.
 */
async function store_hosted_contents(
  scope: BackupRunScope,
  channel_id: string,
  root_id: string,
  replies: TeamsGraphResource[],
  previous: TeamsThreadEntry | undefined,
): Promise<Record<string, TeamsHostedContentRef>> {
  const locators: TeamsMessageLocator[] = [
    { team_id: scope.team_id, channel_id, root_id },
    ...replies
      .filter((reply) => !reply.deletedDateTime)
      .map((reply) => ({ team_id: scope.team_id, channel_id, root_id, reply_id: reply.id })),
  ];
  const hosted: Record<string, TeamsHostedContentRef> = {};
  for (const locator of locators) {
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
  await scope.ctx.storage.put(storage_key, scope.ctx.encrypt(bytes, storage_key));
  scope.counters.hosted_content_stored++;
  const content_type = typeof item.contentType === 'string' ? item.contentType : undefined;
  return { storage_key, checksum, size_bytes: bytes.length, content_type };
}
