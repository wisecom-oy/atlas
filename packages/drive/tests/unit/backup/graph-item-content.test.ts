import { describe, expect, it, vi, type Mock } from 'vitest';
import { binary_graph_response } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  download_via_graph_content,
  resolve_download_url,
  type DriveDownloadItem,
  type DriveGraphClient,
} from '@/backup/graph-item-content';

// Only the retry wrapper is stubbed, so it cannot multiply call counts.
vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

const FRESH_URL = 'https://cdn.example.invalid/fresh';
const CONTENT_BODY = Buffer.from('graph-content');

interface GraphClientMock {
  client: DriveGraphClient;
  api: Mock;
  select: Mock;
}

function make_client(graph_item: Record<string, unknown>, body = CONTENT_BODY): GraphClientMock {
  const get = vi.fn().mockResolvedValue(graph_item);
  const get_stream = vi.fn(() => Promise.resolve(binary_graph_response(body)));
  const select = vi.fn(() => ({ get }));
  const api = vi.fn(() => ({ select, get, responseType: () => ({ get: get_stream }) }));
  return { client: { api } as unknown as DriveGraphClient, api, select };
}

function make_item(size_bytes = 0): DriveDownloadItem {
  return { drive_id: 'drive-1', item_id: 'item-1', file_name: 'file.bin', size_bytes };
}

describe('resolve_download_url', () => {
  it('returns the @microsoft.graph.downloadUrl value', async () => {
    const mock = make_client({ '@microsoft.graph.downloadUrl': FRESH_URL });

    await expect(resolve_download_url(mock.client, make_item())).resolves.toBe(FRESH_URL);
    expect(mock.api).toHaveBeenCalledWith('/drives/drive-1/items/item-1');
    expect(mock.select).toHaveBeenCalledWith('@microsoft.graph.downloadUrl');
  });

  it('returns undefined when Graph omits the property', async () => {
    const mock = make_client({});

    await expect(resolve_download_url(mock.client, make_item())).resolves.toBeUndefined();
  });
});

describe('download_via_graph_content', () => {
  it('requests /content and drains the stream', async () => {
    const mock = make_client({});

    await expect(download_via_graph_content(mock.client, make_item())).resolves.toEqual(
      CONTENT_BODY,
    );
    expect(mock.api).toHaveBeenCalledWith('/drives/drive-1/items/item-1/content');
  });

  it('refuses a drained body that is not the recorded length (issue #368)', async () => {
    const mock = make_client({}, Buffer.from('<html>error page</html>'));

    await expect(download_via_graph_content(mock.client, make_item(4096))).rejects.toThrow(
      /expected 4096/,
    );
  });
});
