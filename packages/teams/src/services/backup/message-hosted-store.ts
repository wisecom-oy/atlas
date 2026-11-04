import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { TeamsGraphResource, TeamsHostedRef, TeamsMessageLocator } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  type HostedOwner,
  referenced_hosted_ids,
} from '@/services/backup/hosted-reference-scanner';
import { write_blob } from '@/services/backup/message-blob-writer';
import { graph_status_of } from '@/services/shared/graph-error-status';
import { teams_hosted_content_key } from '@/services/shared/storage-keys';

/** The hosted contents one message version references, and the referenced ids Graph lacks. */
export interface MessageHostedResult {
  readonly hosted: Record<string, TeamsHostedRef>;
  readonly missing: string[];
}

/**
 * Stores the hosted contents a message references. A message that references none makes no
 * call. Otherwise each referenced id is downloaded directly by its path (T4). Only when `relist`
 * is set, because a previous run left ids missing, does the message's `hostedContents` get listed
 * first, and an id the listing lacks is reported missing without a download attempt. A 404 on a
 * download also marks the id missing. The thread is still stored, and the next run retries it.
 * A previously stored item is reused while its blob exists.
 */
export async function store_message_hosted(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  owner: HostedOwner,
  message: TeamsGraphResource,
  previous: Record<string, TeamsHostedRef>,
  relist: boolean,
): Promise<MessageHostedResult> {
  const referenced = referenced_hosted_ids(message, owner);
  if (referenced.length === 0) {
    return { hosted: {}, missing: [] };
  }
  const listed = relist ? await list_by_id(scope, locator) : undefined;
  const hosted: Record<string, TeamsHostedRef> = {};
  const missing: string[] = [];
  for (const id of referenced) {
    if (listed !== undefined && !listed.has(id)) {
      missing.push(id);
      continue;
    }
    const ref =
      (await reusable_hosted_ref(scope, previous[id])) ??
      (await store_hosted_content(scope, locator, id, listed?.get(id)));
    if (ref === undefined) {
      missing.push(id);
    } else {
      hosted[id] = ref;
    }
  }
  return { hosted, missing };
}

/** Lists a message's hosted contents, keyed by id with the listed content type. */
async function list_by_id(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
): Promise<Map<string, TeamsGraphResource>> {
  const items = await scope.connector.list_hosted_contents(scope.tenant_id, locator);
  return new Map(items.map((item) => [item.id, item]));
}

async function reusable_hosted_ref(
  scope: BackupRunScope,
  previous: TeamsHostedRef | undefined,
): Promise<TeamsHostedRef | undefined> {
  if (previous === undefined) {
    return undefined;
  }
  return (await scope.ctx.storage.exists(previous.storage_key)) ? previous : undefined;
}

/** Downloads and stores one hosted item. Returns undefined when Graph has no such item. */
async function store_hosted_content(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  id: string,
  listed: TeamsGraphResource | undefined,
): Promise<TeamsHostedRef | undefined> {
  let bytes: Buffer;
  try {
    bytes = await scope.connector.download_hosted_content(scope.tenant_id, locator, id);
  } catch (err) {
    if (graph_status_of(err) === 404) {
      return undefined;
    }
    throw err;
  }
  const { checksum, content_name } = compute_content_digests(scope.ctx, bytes);
  const storage_key = teams_hosted_content_key(scope.team_id, content_name);
  await write_blob(scope, storage_key, bytes);
  scope.counters.hosted_content_stored++;
  const content_type = typeof listed?.contentType === 'string' ? listed.contentType : undefined;
  return { storage_key, checksum, size_bytes: bytes.length, content_type };
}
