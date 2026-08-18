import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Container } from 'inversify';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import { GraphSharePointConnector } from '@/adapters/graph-sharepoint-connector.adapter';

interface MockGraphClient {
  api: Mock;
  _get: Mock;
  _select: Mock;
}

function make_mock_client(versions_response: { value: unknown[] }): MockGraphClient {
  const get_fn = vi.fn().mockResolvedValue(versions_response);
  const select_fn = vi.fn().mockReturnValue({ get: get_fn });
  const api_fn = vi.fn().mockReturnValue({ select: select_fn, get: get_fn });

  return { api: api_fn, _get: get_fn, _select: select_fn };
}

describe('GraphSharePointConnector.list_file_versions', () => {
  let connector: GraphSharePointConnector;
  let mock_client: MockGraphClient;

  beforeEach(() => {
    mock_client = make_mock_client({ value: [] });
    const container = new Container();
    container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
    container.bind(GraphSharePointConnector).toSelf();
    connector = container.get(GraphSharePointConnector);
  });

  // Issue #110: SharePoint numbers versions '1.0', '2.0', ..., so the previous guard compared
  // against the literal id '1' and matched nothing. The current version then went to the
  // version-content endpoint, which Graph rejects with HTTP 400.
  it('excludes the current version when ids use SharePoint dotted numbering', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '3.0', lastModifiedDateTime: '2026-03-03T00:00:00Z', size: 300 },
        { id: '2.0', lastModifiedDateTime: '2026-03-02T00:00:00Z', size: 200 },
        { id: '1.0', lastModifiedDateTime: '2026-03-01T00:00:00Z', size: 100 },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions.map((v) => v.version_id)).toEqual(['2.0', '1.0']);
  });

  it('returns nothing for a freshly uploaded file whose only version is current', async () => {
    mock_client._get.mockResolvedValue({
      value: [{ id: '1.0', lastModifiedDateTime: '2026-03-01T00:00:00Z', size: 100 }],
    });

    expect(await connector.list_file_versions('drive-1', 'item-1')).toEqual([]);
  });

  it('returns nothing when the file has no versions at all', async () => {
    mock_client._get.mockResolvedValue({ value: [] });

    expect(await connector.list_file_versions('drive-1', 'item-1')).toEqual([]);
  });

  it('drops entries with no id before excluding the current version', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: undefined, lastModifiedDateTime: '2026-03-04T00:00:00Z', size: 400 },
        { id: '3.0', lastModifiedDateTime: '2026-03-03T00:00:00Z', size: 300 },
        { id: '2.0', lastModifiedDateTime: '2026-03-02T00:00:00Z', size: 200 },
      ],
    });

    expect(
      await connector
        .list_file_versions('drive-1', 'item-1')
        .then((v) => v.map((x) => x.version_id)),
    ).toEqual(['2.0']);
  });

  it('maps Graph fields and defaults missing metadata', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '2.0', lastModifiedDateTime: '2026-03-02T00:00:00Z', size: 200 },
        { id: '1.0' },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toEqual([{ version_id: '1.0', last_modified_at: '', size_bytes: 0 }]);
  });
});
