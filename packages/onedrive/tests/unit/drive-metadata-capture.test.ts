import { describe, it, expect, vi, afterEach } from 'vitest';
import { DRIVE_DELTA_SELECT_FIELDS, map_delta_item } from '@/adapters/graph-onedrive-delta-mapper';
import {
  graph_onedrive_upload_large_file,
  graph_onedrive_upload_small_file,
} from '@/adapters/graph-onedrive-restore.adapter';
import { build_stored_entry } from '@/services/onedrive-backup-builders';

const FILE_SYSTEM_INFO = {
  createdDateTime: '2019-03-04T10:00:00Z',
  lastModifiedDateTime: '2021-07-08T11:30:00Z',
};

function raw_item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    name: 'report.docx',
    size: 1024,
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    parentReference: { path: '/drive/root:/Documents' },
    file: {},
    fileSystemInfo: FILE_SYSTEM_INFO,
    createdBy: { user: { displayName: 'Alice', email: 'alice@contoso.com', id: 'u-1' } },
    lastModifiedBy: { user: { displayName: 'Bob', id: 'u-2' } },
    ...overrides,
  };
}

/** A Graph client stub recording the request each call made. */
function make_client(put_result: unknown = { id: 'new-item' }): {
  client: { api: ReturnType<typeof vi.fn> };
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const api = vi.fn((url: string) => {
    const chain = {
      header: vi.fn(() => chain),
      select: vi.fn(() => chain),
      put: vi.fn(async () => {
        calls.push({ url, method: 'put' });
        return put_result;
      }),
      patch: vi.fn(async (body: unknown) => {
        calls.push({ url, method: 'patch', body });
        return {};
      }),
      post: vi.fn(async (body: unknown) => {
        calls.push({ url, method: 'post', body });
        return { uploadUrl: 'https://upload.example/session' };
      }),
      get: vi.fn(async () => ({})),
    };
    return chain;
  });
  return { client: { api }, calls };
}

describe('drive metadata capture (issue #54)', () => {
  it('requests the metadata fields, since $select strips anything unasked for', () => {
    expect(DRIVE_DELTA_SELECT_FIELDS).toContain('fileSystemInfo');
    expect(DRIVE_DELTA_SELECT_FIELDS).toContain('createdBy');
    expect(DRIVE_DELTA_SELECT_FIELDS).toContain('lastModifiedBy');
  });

  it('maps client timestamps separately from the service-side timestamp', () => {
    const item = map_delta_item(raw_item(), 'drive-1');

    expect(item.file_system_info).toEqual({
      created_at: '2019-03-04T10:00:00Z',
      last_modified_at: '2021-07-08T11:30:00Z',
    });
    // The service-side value is when Microsoft 365 saw the file, and stays put.
    expect(item.last_modified_at).toBe('2026-01-01T00:00:00Z');
  });

  it('maps both authors', () => {
    const item = map_delta_item(raw_item(), 'drive-1');

    expect(item.created_by).toEqual({
      display_name: 'Alice',
      email: 'alice@contoso.com',
      id: 'u-1',
    });
    expect(item.last_modified_by).toEqual({ display_name: 'Bob', id: 'u-2' });
  });

  it('omits the fields entirely when Graph returned none', () => {
    const item = map_delta_item(
      raw_item({ fileSystemInfo: undefined, createdBy: undefined, lastModifiedBy: undefined }),
      'drive-1',
    );

    expect(item.file_system_info).toBeUndefined();
    expect(item.created_by).toBeUndefined();
    expect(item.last_modified_by).toBeUndefined();
  });

  it('carries the metadata onto the manifest entry', () => {
    const entry = build_stored_entry(
      map_delta_item(raw_item(), 'drive-1'),
      'key',
      'sum',
      'created',
    );

    expect(entry.file_system_info?.created_at).toBe('2019-03-04T10:00:00Z');
    expect(entry.created_by?.display_name).toBe('Alice');
    expect(entry.last_modified_by?.display_name).toBe('Bob');
  });
});

describe('restoring original timestamps (issue #54)', () => {
  const captured = { created_at: '2019-03-04T10:00:00Z', last_modified_at: '2021-07-08T11:30:00Z' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The chunk PUTs go straight to the session URL, bypassing the Graph client. */
  const stub_chunk_uploads = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 202 })),
    );
  };

  it('patches the uploaded item, because PUT /content carries bytes only', async () => {
    const { client, calls } = make_client();

    await graph_onedrive_upload_small_file(
      client as never,
      'owner-1',
      'drive-1',
      'root',
      'report.docx',
      Buffer.from('x'),
      'rename',
      captured,
    );

    const patch = calls.find((c) => c.method === 'patch');
    expect(patch?.url).toContain('/items/new-item');
    expect(patch?.body).toEqual({
      fileSystemInfo: {
        createdDateTime: '2019-03-04T10:00:00Z',
        lastModifiedDateTime: '2021-07-08T11:30:00Z',
      },
    });
  });

  it('sends no patch when nothing was captured', async () => {
    const { client, calls } = make_client();

    await graph_onedrive_upload_small_file(
      client as never,
      'owner-1',
      'drive-1',
      'root',
      'report.docx',
      Buffer.from('x'),
      'rename',
    );

    expect(calls.some((c) => c.method === 'patch')).toBe(false);
  });

  it('keeps the upload when the timestamp patch fails', async () => {
    // A restored file with wrong timestamps still beats no restored file.
    const calls: string[] = [];
    const api = vi.fn(() => {
      const chain = {
        header: vi.fn(() => chain),
        put: vi.fn(async () => {
          calls.push('put');
          return { id: 'new-item' };
        }),
        patch: vi.fn(async () => {
          calls.push('patch');
          throw new Error('itemNotFound');
        }),
      };
      return chain;
    });

    await expect(
      graph_onedrive_upload_small_file(
        { api } as never,
        'owner-1',
        'drive-1',
        'root',
        'report.docx',
        Buffer.from('x'),
        'rename',
        captured,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toContain('put');
  });

  it('sends timestamps with the upload session, which accepts item metadata', async () => {
    stub_chunk_uploads();
    const { client, calls } = make_client();

    await graph_onedrive_upload_large_file(
      client as never,
      'owner-1',
      'drive-1',
      'root',
      'big.zip',
      Buffer.alloc(16),
      'rename',
      captured,
    );

    const session = calls.find((c) => c.method === 'post');
    expect(session?.body).toMatchObject({
      item: {
        '@microsoft.graph.conflictBehavior': 'rename',
        fileSystemInfo: {
          createdDateTime: '2019-03-04T10:00:00Z',
          lastModifiedDateTime: '2021-07-08T11:30:00Z',
        },
      },
    });
  });

  it('leaves the session body unchanged when nothing was captured', async () => {
    stub_chunk_uploads();
    const { client, calls } = make_client();

    await graph_onedrive_upload_large_file(
      client as never,
      'owner-1',
      'drive-1',
      'root',
      'big.zip',
      Buffer.alloc(16),
      'rename',
    );

    const session = calls.find((c) => c.method === 'post');
    expect(session?.body).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'rename' } });
  });
});
