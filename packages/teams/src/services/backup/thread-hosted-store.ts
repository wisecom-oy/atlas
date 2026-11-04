import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  TeamsGraphResource,
  TeamsHostedContentRef,
  TeamsMessageLocator,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { referenced_hosted_ids } from '@/services/backup/hosted-reference-scanner';
import { write_blob } from '@/services/backup/thread-blob-writer';
import { teams_hosted_content_key } from '@/services/shared/storage-keys';

/**
 * Stores hosted contents referenced by the root or a live reply. A message whose body and
 * attachments reference none is not listed. A referenced id Graph does not list is returned in
 * `missing` rather than failing the root, so the thread is still backed up and the entry records
 * the gap. A previously stored item is reused while its blob exists.
 */
export async function store_hosted_contents(
  scope: BackupRunScope,
  channel_id: string,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
  previous: TeamsThreadEntry | undefined,
): Promise<{ hosted: Record<string, TeamsHostedContentRef>; missing: string[] }> {
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
  const missing: string[] = [];
  for (const { message, locator } of targets) {
    const referenced = referenced_hosted_ids(message);
    if (referenced.length === 0) {
      continue;
    }
    const items = await scope.connector.list_hosted_contents(scope.tenant_id, locator);
    missing.push(...unlisted_references(referenced, items));
    for (const item of items) {
      hosted[item.id] =
        (await reusable_hosted_ref(scope, previous?.hosted[item.id])) ??
        (await store_hosted_content(scope, locator, item));
    }
  }
  return { hosted, missing };
}

/** True when two hosted maps reference the same blobs with the same checksums. */
export function same_hosted_refs(
  a: Record<string, TeamsHostedContentRef>,
  b: Record<string, TeamsHostedContentRef>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        b[key] !== undefined &&
        b[key].storage_key === a[key]?.storage_key &&
        b[key].checksum === a[key]?.checksum,
    )
  );
}

function unlisted_references(referenced: string[], items: TeamsGraphResource[]): string[] {
  const listed = new Set(items.map((item) => item.id));
  return referenced.filter((id) => !listed.has(id));
}

async function reusable_hosted_ref(
  scope: BackupRunScope,
  previous: TeamsHostedContentRef | undefined,
): Promise<TeamsHostedContentRef | undefined> {
  if (previous === undefined) {
    return undefined;
  }
  return (await scope.ctx.storage.exists(previous.storage_key)) ? previous : undefined;
}

async function store_hosted_content(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  item: TeamsGraphResource,
): Promise<TeamsHostedContentRef> {
  const bytes = await scope.connector.download_hosted_content(scope.tenant_id, locator, item.id);
  const { checksum, content_name } = compute_content_digests(scope.ctx, bytes);
  const storage_key = teams_hosted_content_key(scope.team_id, content_name);
  await write_blob(scope, storage_key, bytes);
  scope.counters.hosted_content_stored++;
  const content_type = typeof item.contentType === 'string' ? item.contentType : undefined;
  return { storage_key, checksum, size_bytes: bytes.length, content_type };
}
