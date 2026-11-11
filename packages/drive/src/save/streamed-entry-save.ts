import { add_stream_to_archive } from '@wisecom/atlas-core/services/shared/archive-stream-entry';
import type { FileArchive } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import {
  stream_sha256_from_storage,
  stream_verified_plaintext,
} from '@wisecom/atlas-core/services/shared/stream-decrypt';
import type { TenantContext } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import { verify_streaming_checksum } from '@/restore/streaming-restore';

/**
 * Saves one large entry into the archive without holding its plaintext, returning whether it was
 * written.
 *
 * A zip entry cannot be withdrawn once its bytes have gone out, so the object is verified before
 * anything is written: a first pass checks the GCM tag and the manifest checksum, and a failure
 * there is a per-file skip exactly as on the buffered path. The second pass streams the plaintext
 * into the archive and checks it against the first pass digest, so an object that changed between
 * the two reads aborts the archive rather than completing a wrong entry (issue #617). The price is
 * reading and decrypting the object twice.
 */
export async function save_streamed_entry(
  ctx: TenantContext,
  file_archive: FileArchive,
  entry: DriveManifestEntry,
  skip_integrity: boolean,
  integrity_failures: string[],
): Promise<boolean> {
  const storage_key = entry.storage_key!;
  const sha256_hex = await stream_sha256_from_storage(ctx, storage_key);
  if (!skip_integrity && !verify_streaming_checksum(entry, sha256_hex)) {
    integrity_failures.push(entry.file_id);
    return false;
  }
  await add_stream_to_archive(
    file_archive,
    entry.parent_path,
    entry.file_name,
    stream_verified_plaintext(ctx, storage_key, sha256_hex, entry.file_name),
  );
  return true;
}
