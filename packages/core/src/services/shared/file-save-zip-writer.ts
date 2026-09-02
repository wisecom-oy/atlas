import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { ZipArchive, type Archiver } from 'archiver';
import { logger } from '@/utils/logger';

/** The archiver instance file entries are appended to. */
export type FileArchiveWriter = Archiver;

export interface FileArchive {
  readonly archive: FileArchiveWriter;
  readonly promise: Promise<number>;
  /**
   * Destroys the stream and removes the partial file, for a run that failed before finalizing.
   *
   * A truncated zip left at the output path is indistinguishable from a complete one, which is
   * worse than no file at all when the reason an operator ran a save is that they need the bytes
   * (issue #307). A path that already held a file is never removed: the caller may have been
   * handed the path of something unrelated.
   */
  abort(): Promise<void>;
}

/** Creates a zip archive writing to the given file path. Returns the archiver and a promise that resolves with total bytes written. */
export function create_file_archive(output_path: string): FileArchive {
  const pre_existing = existsSync(output_path);
  const output = createWriteStream(output_path);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
  });
  // Attach a handler now, so an archive error raised while entries are still being written is
  // not an unhandled rejection. Awaiting `promise` later still sees the rejection.
  promise.catch(() => undefined);

  archive.pipe(output);
  return {
    archive,
    promise,
    abort: () => abort_archive(archive, output, output_path, pre_existing),
  };
}

async function abort_archive(
  archive: FileArchiveWriter,
  output: WriteStream,
  output_path: string,
  pre_existing: boolean,
): Promise<void> {
  try {
    archive.abort();
  } catch {
    // Already destroyed or never started; the stream teardown below is what matters.
  }
  output.destroy();
  if (pre_existing) return;
  try {
    await rm(output_path, { force: true });
  } catch (err) {
    logger.warn(
      `Could not remove the partial archive at ${output_path}: ${err instanceof Error ? err.message : String(err)}`,
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
