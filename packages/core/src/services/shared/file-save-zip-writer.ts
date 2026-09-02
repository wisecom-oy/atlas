import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { ZipArchive, type Archiver } from 'archiver';
import { logger } from '@/utils/logger';

/** The archiver instance file entries are appended to. */
export type FileArchiveWriter = Archiver;

export interface FileArchive {
  readonly archive: FileArchiveWriter;
  readonly promise: Promise<number>;
  /**
   * Moves the finished archive onto the output path. Call it after the archive is finalized and
   * the byte count has resolved; until then the output path is untouched.
   */
  publish(): Promise<void>;
  /** Destroys the stream and removes the temporary file, for a run that failed before publishing. */
  abort(): Promise<void>;
}

/**
 * Creates a zip archive for the given output path. Returns the archiver and a promise that
 * resolves with total bytes written.
 *
 * Entries are written to a sibling temporary file and moved onto the output path by
 * {@link FileArchive.publish}, so nothing appears there until the archive is complete. A
 * truncated zip is indistinguishable from a finished one, which is worse than no file at all when
 * the reason an operator ran a save is that they need the bytes (issue #307), and a save that
 * fails must not destroy a file that was already sitting at the path it was pointed at.
 */
export function create_file_archive(output_path: string): FileArchive {
  const staging_path = `${output_path}.part-${randomBytes(6).toString('hex')}`;
  const output = createWriteStream(staging_path);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    // Errors on the destination are not forwarded through pipe(), so without this a failed write
    // resolves on `close` and the caller reports a successful save.
    output.on('error', reject);
  });
  // Attach a handler now, so an error raised while entries are still being written is not an
  // unhandled rejection. Awaiting `promise` later still sees the rejection.
  promise.catch(() => undefined);

  archive.pipe(output);
  return {
    archive,
    promise,
    publish: () => rename(staging_path, output_path),
    abort: () => abort_archive(archive, output, staging_path),
  };
}

async function abort_archive(
  archive: FileArchiveWriter,
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

/** Adds a file to the archive under the given folder path. */
export async function add_file_to_archive(
  archive: FileArchiveWriter,
  folder_path: string,
  file_name: string,
  content: Buffer,
): Promise<void> {
  const normalized =
    folder_path === '/' || folder_path === '' ? '' : folder_path.replace(/^\//, '');
  const entry_path = normalized ? `${normalized}/${file_name}` : file_name;
  archive.append(content, { name: entry_path });
}

/** Finalizes the archive (must be called after all files are added). */
export async function finalize_file_archive(archive: FileArchiveWriter): Promise<void> {
  await archive.finalize();
}
