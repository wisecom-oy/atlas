import { describe, expect, it } from 'vitest';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';
import type { DriveDeltaItem } from '@/drive-ports';
import { DriveFolderColorCapture } from '@/backup/folder-color-capture';
import { fetch_drive_folder_colors } from '@/graph/graph-folder-color-fetch';

function item(fields: Partial<DriveDeltaItem>): DriveDeltaItem {
  return {
    item_id: 'x',
    drive_id: 'drive-1',
    kind: 'folder',
    file_name: 'Projects',
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    ...fields,
  };
}

const folders = (count: number): DriveDeltaItem[] =>
  Array.from({ length: count }, (_, i) => item({ item_id: `folder-${i}` }));

describe('DriveFolderColorCapture (#581)', () => {
  it('reads only live folders, never files, deletions or the drive root', async () => {
    const reader = stub_folder_color_reader();
    const capture = new DriveFolderColorCapture(reader.connector);

    await capture.prefetch('drive-1', [
      item({ item_id: 'root', is_root: true }),
      item({ item_id: 'file', kind: 'file' }),
      item({ item_id: 'gone', deleted: true }),
      item({ item_id: 'folder' }),
    ]);

    expect(reader.calls).toEqual([['folder']]);
  });

  it('costs three `$batch` requests for 45 folders delta returned beside files', async () => {
    const posts: GraphCall[] = [];
    const graph = stub_graph_client((call) => {
      posts.push(call);
      const requests = (call.body as { requests: { id: string }[] }).requests;
      return { responses: requests.map(({ id }) => ({ id, status: 200, body: {} })) };
    });
    const capture = new DriveFolderColorCapture({
      fetch_folder_colors: (drive_id, item_ids) =>
        fetch_drive_folder_colors(graph.client, drive_id, item_ids),
    });
    const files = Array.from({ length: 30 }, (_, i) =>
      item({ item_id: `file-${i}`, kind: 'file' }),
    );

    await capture.prefetch('drive-1', [...files, ...folders(45)]);

    expect(posts.map((call) => call.url)).toEqual(['/$batch', '/$batch', '/$batch']);
    const urls = posts.flatMap((call) =>
      (call.body as { requests: { url: string }[] }).requests.map((request) => request.url),
    );
    expect(urls).toHaveLength(45);
    expect(urls.every((url) => url.includes('/items/folder-'))).toBe(true);
  });

  it('compares the read colour with the one the cursor recorded', async () => {
    const reader = stub_folder_color_reader({ a: { color_hex: '6' }, b: { color_hex: '3' } });
    const capture = new DriveFolderColorCapture(reader.connector);
    const tracking = { folder_color_by_item_id: { a: { color_hex: '6' }, c: { color_hex: '1' } } };
    await capture.prefetch('drive-1', [
      item({ item_id: 'a' }),
      item({ item_id: 'b' }),
      item({ item_id: 'c' }),
    ]);

    expect(await capture.observe(item({ item_id: 'a' }), tracking)).toEqual({
      read: true,
      color: { color_hex: '6' },
      changed: false,
    });
    expect(await capture.observe(item({ item_id: 'b' }), tracking)).toMatchObject({
      color: { color_hex: '3' },
      changed: true,
    });
    expect(await capture.observe(item({ item_id: 'c' }), tracking)).toEqual({
      read: true,
      color: undefined,
      changed: true,
    });
    expect(reader.calls).toHaveLength(1);
  });

  it('reports a failed read as not read, and does not repeat it within the run', async () => {
    const reader = stub_folder_color_reader({}, ['a']);
    const capture = new DriveFolderColorCapture(reader.connector);

    expect(await capture.observe(item({ item_id: 'a' }), {})).toEqual({ read: false });
    expect(await capture.observe(item({ item_id: 'a' }), {})).toEqual({ read: false });
    expect(reader.calls).toEqual([['a']]);
  });
});
