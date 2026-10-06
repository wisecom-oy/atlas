import { afterEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  graph_onedrive_create_folder,
  graph_onedrive_upload_large_file,
} from '@/adapters/graph-onedrive-restore.adapter';

const OWNER = 'aaaaaaaa-1111-2222-3333-444444444444';
const DRIVE = 'drive-1';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Restoring into a tree that already has the folder is the normal case, and Graph answers 409. */
describe('graph_onedrive_create_folder', () => {
  it('creates the folder without replacing an existing one and returns its id', async () => {
    const { client, calls } = stub_graph_client(() => ({ id: 'folder-new' }));

    const id = await graph_onedrive_create_folder(client as never, OWNER, DRIVE, 'root', 'Reports');

    expect(id).toBe('folder-new');
    expect(calls).toEqual([
      {
        method: 'post',
        url: `/users/${OWNER}/drives/${DRIVE}/root/children`,
        body: { name: 'Reports', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      },
    ]);
  });

  it('reuses the existing folder when the name conflicts, ignoring a file of the same name', async () => {
    const { client, calls } = stub_graph_client((call) => {
      if (call.method === 'post') throw graph_error(409, 'nameAlreadyExists');
      return {
        value: [
          { id: 'file-same-name', file: {} },
          { id: 'folder-existing', folder: { childCount: 0 } },
        ],
      };
    });

    const id = await graph_onedrive_create_folder(
      client as never,
      OWNER,
      DRIVE,
      'parent-7',
      "O'Brien files",
    );

    expect(id).toBe('folder-existing');
    const filter = encodeURIComponent("name eq 'O''Brien files'");
    expect(calls[1]).toEqual({
      method: 'get',
      url: `/users/${OWNER}/drives/${DRIVE}/items/parent-7/children?$filter=${filter}`,
    });
  });

  it('fails when the conflict names a folder that cannot be found', async () => {
    const { client } = stub_graph_client((call) => {
      if (call.method === 'post') throw graph_error(409, 'nameAlreadyExists');
      return { value: [] };
    });

    await expect(
      graph_onedrive_create_folder(client as never, OWNER, DRIVE, 'root', 'Reports'),
    ).rejects.toThrow(/conflict \(409\) but existing folder "Reports" was not found/);
  });

  it('propagates any other failure without looking for an existing folder', async () => {
    const { client, calls } = stub_graph_client(() => {
      throw graph_error(403, 'accessDenied');
    });

    await expect(
      graph_onedrive_create_folder(client as never, OWNER, DRIVE, 'root', 'Reports'),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toHaveLength(1);
  });
});

describe('graph_onedrive_upload_large_file', () => {
  it('fails before sending any bytes when the session has no upload URL', async () => {
    const fetch_stub = vi.fn();
    vi.stubGlobal('fetch', fetch_stub);
    const { client } = stub_graph_client(() => ({}));

    await expect(
      graph_onedrive_upload_large_file(
        client as never,
        OWNER,
        DRIVE,
        'root',
        'big.zip',
        Buffer.alloc(32),
      ),
    ).rejects.toThrow('Graph createUploadSession returned no uploadUrl');
    expect(fetch_stub).not.toHaveBeenCalled();
  });
});
