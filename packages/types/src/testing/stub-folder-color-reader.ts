import type { DriveFolderColor } from '@/domain/drive/item-metadata';
import type { DriveFolderColorConnector } from '@/ports/drive/folder-color.port';

/** A folder colour reader that answers in memory and records what a run asked for. */
export interface StubFolderColorReader {
  readonly connector: DriveFolderColorConnector;
  /** The folder ids of each `fetch_folder_colors` call, in order. */
  readonly calls: string[][];
}

/**
 * Answers each folder with its colour in `colors`, or with no colour when it is not listed. A
 * folder in `unreadable` is left out of the answer, as when its `$batch` read failed for good.
 */
export function stub_folder_color_reader(
  colors: Readonly<Record<string, DriveFolderColor>> = {},
  unreadable: readonly string[] = [],
): StubFolderColorReader {
  const calls: string[][] = [];
  const connector: DriveFolderColorConnector = {
    fetch_folder_colors: (_drive_id, item_ids) => {
      calls.push([...item_ids]);
      const answered = item_ids
        .filter((item_id) => !unreadable.includes(item_id))
        .map((item_id): [string, DriveFolderColor] => [item_id, colors[item_id] ?? {}]);
      return Promise.resolve(new Map(answered));
    },
  };
  return { connector, calls };
}
