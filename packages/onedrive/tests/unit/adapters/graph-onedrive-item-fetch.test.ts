import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { graph_onedrive_fetch_item_by_id } from '@/adapters/graph-onedrive-item-fetch';

// Issue #34: retrying a failed item hangs on telling "gone" apart from "broken".
// Only a genuine 404 may resolve undefined, since undefined drops the item from
// the failure ledger and would lose the file for good.

function make_client(get: () => Promise<unknown>): Client {
  const select = vi.fn().mockReturnValue({ get });
  return { api: vi.fn().mockReturnValue({ select }) } as unknown as Client;
}

describe('graph_onedrive_fetch_item_by_id', () => {
  it('maps a fetched item the same way delta does', async () => {
    const client = make_client(() =>
      Promise.resolve({
        id: 'item-1',
        name: 'report.docx',
        size: 42,
        eTag: 'etag-1',
        parentReference: { path: '/drive/root:/Docs' },
        file: {},
      }),
    );

    const item = await graph_onedrive_fetch_item_by_id(client, 'd1', 'item-1');

    expect(item).toMatchObject({
      item_id: 'item-1',
      drive_id: 'd1',
      kind: 'file',
      file_name: 'report.docx',
      parent_path: '/Docs',
      size_bytes: 42,
      deleted: false,
      etag: 'etag-1',
    });
    expect(client.api).toHaveBeenCalledWith('/drives/d1/items/item-1');
  });

  it('resolves undefined for a 404 status', async () => {
    const client = make_client(() =>
      Promise.reject(Object.assign(new Error('gone'), { statusCode: 404 })),
    );

    await expect(graph_onedrive_fetch_item_by_id(client, 'd1', 'item-1')).resolves.toBeUndefined();
  });

  it('resolves undefined for an itemNotFound code', async () => {
    const client = make_client(() =>
      Promise.reject(Object.assign(new Error('gone'), { code: 'itemNotFound' })),
    );

    await expect(graph_onedrive_fetch_item_by_id(client, 'd1', 'item-1')).resolves.toBeUndefined();
  });

  it('propagates any other Graph error rather than treating it as a deletion', async () => {
    const client = make_client(() =>
      Promise.reject(Object.assign(new Error('forbidden'), { statusCode: 403 })),
    );

    await expect(graph_onedrive_fetch_item_by_id(client, 'd1', 'item-1')).rejects.toThrow(
      'forbidden',
    );
  });
});
