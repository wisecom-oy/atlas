import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { GRAPH_CLIENT_TOKEN } from '@atlas/m365-graph';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

function make_mock_client(versions_response: { value: unknown[] }) {
  const get_fn = vi.fn().mockResolvedValue(versions_response);
  const select_fn = vi.fn().mockReturnValue({ get: get_fn });
  const api_fn = vi.fn().mockReturnValue({ select: select_fn });

  return { api: api_fn, _get: get_fn, _select: select_fn };
}

describe('GraphOneDriveConnector.list_file_versions', () => {
  let connector: GraphOneDriveConnector;
  let mock_client: ReturnType<typeof make_mock_client>;

  beforeEach(() => {
    mock_client = make_mock_client({ value: [] });
    const container = new Container();
    container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
    container.bind(GraphOneDriveConnector).toSelf();
    connector = container.get(GraphOneDriveConnector);
  });

  it('excludes the first (current) version from results', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '5.0', lastModifiedDateTime: '2025-03-15', size: 5000 },
        { id: '4.0', lastModifiedDateTime: '2025-03-14', size: 4000 },
        { id: '3.0', lastModifiedDateTime: '2025-03-13', size: 3000 },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toHaveLength(2);
    expect(versions[0].version_id).toBe('4.0');
    expect(versions[1].version_id).toBe('3.0');
  });

  it('returns empty array when only the current version exists', async () => {
    mock_client._get.mockResolvedValue({
      value: [{ id: '1.0', lastModifiedDateTime: '2025-01-01', size: 1000 }],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toEqual([]);
  });

  it('returns empty array when API returns no versions', async () => {
    mock_client._get.mockResolvedValue({ value: [] });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toEqual([]);
  });

  it('returns empty array when API returns undefined value', async () => {
    mock_client._get.mockResolvedValue({});

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toEqual([]);
  });

  it('filters out versions with no id before slicing', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '3.0', lastModifiedDateTime: '2025-03-15', size: 3000 },
        { id: null, lastModifiedDateTime: '2025-03-14', size: 2000 },
        { id: '1.0', lastModifiedDateTime: '2025-03-12', size: 1000 },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions).toHaveLength(1);
    expect(versions[0].version_id).toBe('1.0');
  });

  it('maps Graph fields to OneDriveFileVersion shape', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '2.0', lastModifiedDateTime: '2025-03-15T10:30:00Z', size: 2048 },
        { id: '1.0', lastModifiedDateTime: '2025-03-14T09:00:00Z', size: 1024 },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions[0]).toEqual({
      version_id: '1.0',
      last_modified_at: '2025-03-14T09:00:00Z',
      size_bytes: 1024,
    });
  });

  it('defaults size_bytes to 0 when size is missing', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '2.0', lastModifiedDateTime: '2025-03-15', size: undefined },
        { id: '1.0', lastModifiedDateTime: '2025-03-14' },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions[0].size_bytes).toBe(0);
  });

  it('defaults last_modified_at to empty string when missing', async () => {
    mock_client._get.mockResolvedValue({
      value: [
        { id: '2.0', size: 100 },
        { id: '1.0', size: 50 },
      ],
    });

    const versions = await connector.list_file_versions('drive-1', 'item-1');

    expect(versions[0].last_modified_at).toBe('');
  });
});
