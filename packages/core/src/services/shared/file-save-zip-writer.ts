import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

export interface FileArchive {
  readonly archive: archiver.Archiver;
  readonly promise: Promise<number>;
}

/** Creates a zip archive writing to the given file path. Returns the archiver and a promise that resolves with total bytes written. */
export function create_file_archive(output_path: string): FileArchive {
  const output = createWriteStream(output_path);
  const archive = archiver('zip', { zlib: { level: 6 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
  });

  archive.pipe(output);
  return { archive, promise };
}

/** Adds a file to the archive under the given folder path. */
export async function add_file_to_archive(
  archive: archiver.Archiver,
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
export async function finalize_file_archive(archive: archiver.Archiver): Promise<void> {
  await archive.finalize();
}
