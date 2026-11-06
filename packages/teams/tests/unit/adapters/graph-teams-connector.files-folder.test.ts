import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';
const FILES_FOLDER = `/teams/${TEAM}/channels/${CHANNEL}/filesFolder`;

/** A connector whose every Graph call either resolves with `response` or, for an Error, rejects. */
function connector_answering(response: unknown) {
  const stub = stub_graph_client(() => {
    if (response instanceof Error) throw response;
    return response;
  });
  const connector = new GraphTeamsConnector(stub.client as unknown as Client);
  return { connector, calls: stub.calls };
}

function get_files_folder(connector: GraphTeamsConnector) {
  return connector.get_channel_files_folder('tenant-1', TEAM, CHANNEL);
}

describe('GraphTeamsConnector.get_channel_files_folder', () => {
  it('returns the drive reference with the web URL when Graph returns the folder', async () => {
    const { connector, calls } = connector_answering({
      id: 'folder-1',
      webUrl: 'https://sharepoint.example.test/folder',
      parentReference: { driveId: 'drive-1' },
    });

    const folder = await get_files_folder(connector);

    expect(calls.map((call) => call.url)).toEqual([FILES_FOLDER]);
    expect(folder).toStrictEqual({
      drive_id: 'drive-1',
      item_id: 'folder-1',
      web_url: 'https://sharepoint.example.test/folder',
    });
  });

  it('omits web_url when Graph returns the folder without one', async () => {
    const { connector } = connector_answering({
      id: 'folder-1',
      parentReference: { driveId: 'drive-1' },
    });

    await expect(get_files_folder(connector)).resolves.toStrictEqual({
      drive_id: 'drive-1',
      item_id: 'folder-1',
    });
  });

  it("resolves 'unavailable' on a 403 without throwing and without retrying", async () => {
    const { connector, calls } = connector_answering(
      graph_error(403, 'ErrorAccessDenied', 'Access denied'),
    );

    await expect(get_files_folder(connector)).resolves.toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('resolves undefined on a 404', async () => {
    const { connector } = connector_answering(graph_error(404, 'ItemNotFound', 'Not found'));

    await expect(get_files_folder(connector)).resolves.toBeUndefined();
  });

  it('rethrows any other status unchanged', async () => {
    const bad = graph_error(400, 'BadRequest', 'Bad request');
    const { connector } = connector_answering(bad);

    await expect(get_files_folder(connector)).rejects.toBe(bad);
  });

  it('resolves undefined when the folder has no drive id', async () => {
    const { connector } = connector_answering({ id: 'folder-1', parentReference: {} });

    await expect(get_files_folder(connector)).resolves.toBeUndefined();
  });

  it('resolves undefined when the folder has no id', async () => {
    const { connector } = connector_answering({ parentReference: { driveId: 'drive-1' } });

    await expect(get_files_folder(connector)).resolves.toBeUndefined();
  });
});
