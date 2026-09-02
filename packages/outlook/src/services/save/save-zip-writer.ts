import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { ZipArchive, type Archiver } from 'archiver';
import { logger } from '@wisecom/atlas-core/utils/logger';

export interface SaveArchive {
  readonly archive: ArchiveWriter;
  readonly promise: Promise<number>;
  /**
   * Moves the finished archive onto the output path. Call it after the archive is finalized and
   * the byte count has resolved; until then the output path is untouched.
   */
  publish(): Promise<void>;
  /** Destroys the stream and removes the temporary file, for a run that failed before publishing. */
  abort(): Promise<void>;
}

/** The archiver instance EML entries are appended to. */
export type ArchiveWriter = Archiver;

/**
 * Creates a zip archive with maximum compression, streaming to a sibling temporary file.
 *
 * The archive is moved onto the output path by {@link SaveArchive.publish}, so nothing appears
 * there until it is complete. A truncated zip is indistinguishable from a finished one (issue
 * #307), and a failed save must not destroy a file that was already at the path it was given.
 */
export function create_save_archive(output_path: string): SaveArchive {
  const staging_path = `${output_path}.part-${randomBytes(6).toString('hex')}`;
  const output = createWriteStream(staging_path);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    output.on('error', reject);
  });
  // Attach a handler now, so an error raised while entries are still being appended is not an
  // unhandled rejection. Awaiting `promise` later still sees the rejection.
  promise.catch(() => undefined);

  archive.pipe(output);
  return {
    archive,
    promise,
    publish: () => rename(staging_path, output_path),
    abort: () => abort_save_archive(archive, output, staging_path),
  };
}

async function abort_save_archive(
  archive: ArchiveWriter,
  output: WriteStream,
  staging_path: string,
): Promise<void> {
  try {
    archive.abort();
  } catch {
    // Already destroyed or never started; the stream teardown below is what matters.
  }
  output.destroy();
  try {
    await rm(staging_path, { force: true });
  } catch (err) {
    logger.warn(
      `Could not remove the partial archive at ${staging_path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Appends an EML buffer and waits for it to be compressed and flushed.
 *
 * Backpressure: archiver.append() is fire-and-forget — it queues the buffer
 * internally and compresses in the background. Without waiting, the loop in
 * save-entry-processor would download the next message from S3 immediately,
 * causing the queue (and heap) to grow without bound. For a 500 GB mailbox
 * that means OOM long before the archive is finished.
 *
 * By awaiting the 'entry' event we guarantee each EML is compressed and
 * written to the output stream before the next S3 download starts, keeping
 * peak memory at roughly one message + its attachments.
 */
export function add_eml_to_archive(
  archive: ArchiveWriter,
  folder_path: string,
  filename: string,
  content: Buffer,
): Promise<void> {
  // Nested mail folders become nested zip directories; each level is sanitized
  // on its own so the separator survives while illegal characters do not.
  //
  // The file name is sanitized here too, not just by the caller. It derives from a
  // message subject, which is chosen by whoever sent the mail, and an entry path like
  // `../../../.ssh/authorized_keys` escapes the destination directory in any extractor
  // that honours entry paths. Today's callers pass a name that is already safe, so this
  // changes no existing archive; it means a future caller passing an item or attachment
  // name cannot reintroduce the traversal (issue #258).
  const dir_path = folder_path.split('/').map(sanitize_path_segment).join('/');
  const entry_path = `${dir_path}/${sanitize_path_segment(filename)}`;
  return new Promise<void>((resolve, reject) => {
    const on_entry = (): void => {
      archive.removeListener('error', on_error);
      resolve();
    };
    const on_error = (err: Error): void => {
      archive.removeListener('entry', on_entry);
      reject(err);
    };
    archive.once('entry', on_entry);
    archive.once('error', on_error);
    archive.append(content, { name: entry_path });
  });
}

/** Finalizes the archive. The returned promise resolves to total bytes written. */
export async function finalize_archive(archive: ArchiveWriter): Promise<void> {
  await archive.finalize();
}

function sanitize_path_segment(segment: string): string {
  return (
    segment
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '') || 'Unknown'
  );
}
