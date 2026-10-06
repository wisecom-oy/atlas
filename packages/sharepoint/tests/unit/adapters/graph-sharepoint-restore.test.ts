import { afterEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  graph_sharepoint_create_folder,
  graph_sharepoint_upload_large_file,
  graph_sharepoint_upload_small_file,
} from '@/adapters/graph-sharepoint-restore.adapter';

const SITE = 'contoso.sharepoint.com,site-guid,web-guid';
const DRIVE = 'drive-1';
const CAPTURED = { created_at: '2019-03-04T10:00:00Z', last_modified_at: '2021-07-08T11:30:00Z' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('graph_sharepoint_create_folder', () => {
  it('creates the folder without replacing an existing one and returns its id', async () => {
    const { client, calls } = stub_graph_client(() => ({ id: 'folder-new' }));

    const id = await graph_sharepoint_create_folder(
      client as never,
      SITE,
      DRIVE,
      'root',
      'Reports',
    );

    expect(id).toBe('folder-new');
    expect(calls).toEqual([
      {
        method: 'post',
        url: `/sites/${SITE}/drives/${DRIVE}/root/children`,
        body: { name: 'Reports', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      },
    ]);
  });

  it('addresses a non-root parent by item id', async () => {
    const { client, calls } = stub_graph_client(() => ({ id: 'folder-new' }));

    await graph_sharepoint_create_folder(client as never, SITE, DRIVE, 'parent-7', 'Reports');

    expect(calls[0]?.url).toBe(`/sites/${SITE}/drives/${DRIVE}/items/parent-7/children`);
  });

  it('reuses the existing folder when the name conflicts, ignoring a file of the same name', async () => {
    const { client, calls } = stub_graph_client((call) => {
      if (call.method === 'post') throw graph_error(409, 'nameAlreadyExists');
      return {
        value: [
          { id: 'file-same-name', file: {} },
          { id: 'folder-existing', folder: { childCount: 3 } },
        ],
      };
    });

    const id = await graph_sharepoint_create_folder(
      client as never,
      SITE,
      DRIVE,
      'parent-7',
      "O'Brien files",
    );

    expect(id).toBe('folder-existing');
    // The name is quoted for OData, so an apostrophe is doubled before encoding.
    const filter = encodeURIComponent("name eq 'O''Brien files'");
    expect(calls[1]).toEqual({
      method: 'get',
      url: `/sites/${SITE}/drives/${DRIVE}/items/parent-7/children?$filter=${filter}`,
    });
  });

  it('fails when the conflict names a folder that cannot be found', async () => {
    const { client } = stub_graph_client((call) => {
      if (call.method === 'post') throw graph_error(409, 'nameAlreadyExists');
      return { value: [{ id: 'file-same-name', file: {} }] };
    });

    await expect(
      graph_sharepoint_create_folder(client as never, SITE, DRIVE, 'root', 'Reports'),
    ).rejects.toThrow(/conflict \(409\) but existing folder "Reports" was not found/);
  });

  it('propagates any other failure without looking for an existing folder', async () => {
    const { client, calls } = stub_graph_client(() => {
      throw graph_error(403, 'accessDenied');
    });

    await expect(
      graph_sharepoint_create_folder(client as never, SITE, DRIVE, 'root', 'Reports'),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toHaveLength(1);
  });

  it('fails when Graph creates the folder but returns no id', async () => {
    const { client } = stub_graph_client(() => ({}));

    await expect(
      graph_sharepoint_create_folder(client as never, SITE, DRIVE, 'root', 'Reports'),
    ).rejects.toThrow('Graph create folder returned no id');
  });
});

describe('graph_sharepoint_upload_small_file', () => {
  it('PUTs the content under an encoded name, then stamps the captured timestamps', async () => {
    const { client, calls } = stub_graph_client((call) =>
      call.method === 'put' ? { id: 'item-9' } : {},
    );

    await graph_sharepoint_upload_small_file(
      client as never,
      SITE,
      DRIVE,
      'root',
      'Q1 report#1.docx',
      Buffer.from('content'),
      'replace',
      CAPTURED,
    );

    expect(calls).toEqual([
      {
        method: 'put',
        url:
          `/sites/${SITE}/drives/${DRIVE}/root:/${encodeURIComponent('Q1 report#1.docx')}` +
          ':/content?@microsoft.graph.conflictBehavior=replace',
        body: Buffer.from('content'),
      },
      {
        method: 'patch',
        url: `/sites/${SITE}/drives/${DRIVE}/items/item-9`,
        body: {
          fileSystemInfo: {
            createdDateTime: CAPTURED.created_at,
            lastModifiedDateTime: CAPTURED.last_modified_at,
          },
        },
      },
    ]);
  });

  it('encodes the conflict behaviour so it cannot add a second query parameter', async () => {
    const { client, calls } = stub_graph_client(() => ({ id: 'item-9' }));

    await graph_sharepoint_upload_small_file(
      client as never,
      SITE,
      DRIVE,
      'root',
      'a.txt',
      Buffer.from('x'),
      'rename&@microsoft.graph.conflictBehavior=replace',
    );

    expect(calls[0]?.url).toMatch(/conflictBehavior=rename%26%40microsoft/);
  });

  it('skips the timestamp patch when nothing was captured', async () => {
    const { client, calls } = stub_graph_client(() => ({ id: 'item-9' }));

    await graph_sharepoint_upload_small_file(
      client as never,
      SITE,
      DRIVE,
      'root',
      'a.txt',
      Buffer.from('x'),
    );

    expect(calls.map((call) => call.method)).toEqual(['put']);
  });

  it('keeps the upload when the timestamp patch fails', async () => {
    const { client, calls } = stub_graph_client((call) => {
      if (call.method === 'patch') throw graph_error(404, 'itemNotFound');
      return { id: 'item-9' };
    });

    await expect(
      graph_sharepoint_upload_small_file(
        client as never,
        SITE,
        DRIVE,
        'root',
        'a.txt',
        Buffer.from('x'),
        'rename',
        CAPTURED,
      ),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['put', 'patch']);
  });
});

describe('graph_sharepoint_upload_large_file', () => {
  it('opens a session carrying the conflict behaviour and timestamps, then uploads into it', async () => {
    const fetch_stub = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetch_stub);
    const { client, calls } = stub_graph_client(() => ({ uploadUrl: 'https://upload.test/s1' }));

    await graph_sharepoint_upload_large_file(
      client as never,
      SITE,
      DRIVE,
      'parent-7',
      'big.zip',
      Buffer.alloc(32),
      'rename',
      CAPTURED,
    );

    expect(calls).toEqual([
      {
        method: 'post',
        url: `/sites/${SITE}/drives/${DRIVE}/items/parent-7:/big.zip:/createUploadSession`,
        body: {
          item: {
            '@microsoft.graph.conflictBehavior': 'rename',
            fileSystemInfo: {
              createdDateTime: CAPTURED.created_at,
              lastModifiedDateTime: CAPTURED.last_modified_at,
            },
          },
        },
      },
    ]);
    expect(fetch_stub).toHaveBeenCalledWith(
      'https://upload.test/s1',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('fails before sending any bytes when the session has no upload URL', async () => {
    const fetch_stub = vi.fn();
    vi.stubGlobal('fetch', fetch_stub);
    const { client } = stub_graph_client(() => ({}));

    await expect(
      graph_sharepoint_upload_large_file(
        client as never,
        SITE,
        DRIVE,
        'root',
        'big.zip',
        Buffer.alloc(32),
      ),
    ).rejects.toThrow('Graph createUploadSession returned no uploadUrl');
    expect(fetch_stub).not.toHaveBeenCalled();
  });
});
