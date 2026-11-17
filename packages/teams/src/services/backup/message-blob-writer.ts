import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { canonical_json } from '@/services/shared/canonical-json';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

/** A message blob ready to store: its plaintext, digest, and the key it is stored under. */
export interface DigestedBlob {
  readonly plaintext: Buffer;
  readonly checksum: string;
  readonly storage_key: string;
}

/**
 * Graph keys that are not message content: OData annotations (`@odata.etag`, `@odata.nextLink`)
 * and the reply list, which is stored in its own blobs. A GET and a list read differ only here.
 */
export function strip_volatile_keys(message: TeamsGraphResource): TeamsGraphResource {
  return Object.fromEntries(
    Object.entries(message).filter(
      ([key]) => !(key.startsWith('@odata.') || key === 'replies' || key.startsWith('replies@')),
    ),
  ) as TeamsGraphResource;
}

/**
 * Serializes one raw Graph message canonically, so the same content always hashes to the same key.
 * The blob is the Graph message minus the keys {@link strip_volatile_keys} removes.
 */
export function digest_message_blob(
  scope: BackupRunScope,
  message: TeamsGraphResource,
): DigestedBlob {
  const plaintext = Buffer.from(canonical_json(strip_volatile_keys(message)), 'utf-8');
  const { checksum, content_name } = compute_content_digests(scope.ctx, plaintext);
  return { plaintext, checksum, storage_key: TEAMS_KEYS.data_key(scope.team_id, content_name) };
}

/**
 * Writes a blob under its content-addressed key and returns true when it wrote the blob. An
 * existing blob is kept as is, even under `--full`: the key is a keyed digest of the content, so a
 * stored blob already holds these bytes, and rewriting it would create a new version under Object
 * Lock.
 */
export async function write_blob(
  scope: BackupRunScope,
  storage_key: string,
  plaintext: Buffer,
): Promise<boolean> {
  if (await scope.ctx.storage.exists(storage_key)) {
    return false;
  }
  await scope.ctx.storage.put(storage_key, scope.ctx.encrypt(plaintext, storage_key));
  return true;
}
