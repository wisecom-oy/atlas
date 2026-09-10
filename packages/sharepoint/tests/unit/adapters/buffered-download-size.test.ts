import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import { download_with_fallback } from '@/adapters/graph-sharepoint-download-executor';

/**
 * Issue #368, the SharePoint twin. Both buffered paths, the pre-authenticated URL and the Graph
 * `/content` fallback, returned whatever arrived. A well-framed 200 of the wrong length became a
 * backup with a checksum computed over the wrong bytes: healthy backup, passing verify, wrong
 * file on restore.
 */

const WRONG_BODY = Buffer.from('<html>error page</html>');
const URL_ADDRESS = 'https://cdn.example.invalid/file';

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'Budget.xlsx',
    parent_path: '/',
    size_bytes: 4096,
    deleted: false,
    download_url: URL_ADDRESS,
    ...overrides,
  } as SharePointDeltaItem;
}

/** Serves the wrong body on `/content`, so the fallback path can be exercised too. */
function make_client(): Client {
  const get = vi.fn().mockResolvedValue({ '@microsoft.graph.downloadUrl': URL_ADDRESS });
  const get_stream = vi.fn().mockImplementation(() => Readable.from([WRONG_BODY]));
  const select = vi.fn(() => ({ get }));
  return { api: vi.fn(() => ({ select, get, getStream: get_stream })) } as unknown as Client;
}

describe('SharePoint buffered downloads that do not match the recorded size', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a wrong-length body from the pre-authenticated URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: () =>
        Promise.resolve(
          WRONG_BODY.buffer.slice(
            WRONG_BODY.byteOffset,
            WRONG_BODY.byteOffset + WRONG_BODY.byteLength,
          ),
        ),
    } as unknown as Response);

    await expect(download_with_fallback(make_client(), make_item())).rejects.toThrow(
      /expected 4096/,
    );
  });

  it('refuses a wrong-length body drained from the /content fallback', async () => {
    // The pre-authenticated URL fails outright, so the fallback is the only path left.
    vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));

    await expect(download_with_fallback(make_client(), make_item())).rejects.toThrow(
      /expected 4096/,
    );
  });
});
