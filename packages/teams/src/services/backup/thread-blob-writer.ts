import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { TeamsThreadBlob, TeamsThreadEntry } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { canonical_json } from '@/services/shared/canonical-json';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';
import { thread_stored_blobs } from '@/services/shared/thread-blobs';

/** A thread blob ready to store: its plaintext, digest, and the key it is stored under. */
export interface DigestedBlob {
  readonly plaintext: Buffer;
  readonly checksum: string;
  readonly storage_key: string;
}

/** Serializes a thread blob canonically, so the same content always hashes to the same key. */
export function digest_thread_blob(scope: BackupRunScope, blob: TeamsThreadBlob): DigestedBlob {
  const plaintext = Buffer.from(canonical_json(blob), 'utf-8');
  const { checksum, content_name } = compute_content_digests(scope.ctx, plaintext);
  return { plaintext, checksum, storage_key: TEAMS_KEYS.data_key(scope.team_id, content_name) };
}

/**
 * Writes a blob under its content-addressed key. An existing blob is kept unless `rewrite` is set,
 * which `--full` uses to rewrite every thread blob it reads.
 */
export async function write_blob(
  scope: BackupRunScope,
  storage_key: string,
  plaintext: Buffer,
  rewrite: boolean,
): Promise<void> {
  if (!rewrite && (await scope.ctx.storage.exists(storage_key))) {
    return;
  }
  await scope.ctx.storage.put(storage_key, scope.ctx.encrypt(plaintext, storage_key));
}

/** True when every blob a thread entry references is still in storage. */
export async function thread_blobs_present(
  scope: BackupRunScope,
  entry: TeamsThreadEntry,
): Promise<boolean> {
  const present = await Promise.all(
    thread_stored_blobs(entry).map((ref) => scope.ctx.storage.exists(ref.storage_key)),
  );
  return present.every(Boolean);
}
