import { createWriteStream } from 'node:fs';
import { ZipArchive, type Archiver } from 'archiver';

/** The archiver instance file entries are appended to. */
export type FileArchiveWriter = Archiver;

export interface FileArchive {
  readonly archive: FileArchiveWriter;
  readonly promise: Promise<number>;
}

/** Creates a zip archive writing to the given file path. Returns the archiver and a promise that resolves with total bytes written. */
export function create_file_archive(output_path: string): FileArchive {
  const output = createWriteStream(output_path);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const promise = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
  });

  archive.pipe(output);
  return { archive, promise };
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
