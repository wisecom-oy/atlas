import { describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import { GraphContactConnector } from '@/adapters/graph-contact-connector.adapter';

function fixture() {
  const graph = {
    api: vi.fn(),
    header: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    responseType: vi.fn(),
  };
  graph.api.mockReturnValue(graph);
  graph.header.mockReturnValue(graph);
  graph.responseType.mockReturnValue(graph);
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph);
  container.bind(GraphContactConnector).toSelf();
  return { graph, connector: container.get(GraphContactConnector) };
}

describe('Graph contacts', () => {
  it('pages contacts with immutable IDs and commits the final delta URL, without $top', async () => {
    const { graph, connector } = fixture();
    graph.get.mockResolvedValueOnce({
      value: [{ id: 'c1', displayName: 'John Doe' }],
      '@odata.nextLink': 'https://graph.example/page-2',
    });
    graph.get.mockResolvedValueOnce({
      value: [{ id: 'c2', '@removed': { reason: 'deleted' } }],
      '@odata.deltaLink': 'https://graph.example/final',
    });
    const pages: string[][] = [];
    const result = await connector.fetch_contact_delta(
      'tenant',
      'john.doe@example.com',
      'folder',
      undefined,
      async (changes) => {
        pages.push(changes.map((item) => item.contact_id));
        return true;
      },
    );
    expect(pages).toEqual([['c1'], ['c2']]);
    expect(result.delta_link).toBe('https://graph.example/final');
    expect(graph.api.mock.calls.map(([path]) => path)).toEqual([
      expect.stringContaining(
        '/users/john.doe%40example.com/contactFolders/folder/contacts/delta?$select=',
      ),
      'https://graph.example/page-2',
    ]);
    expect(graph.api.mock.calls[0]?.[0]).not.toContain('$top');
    expect(graph.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
  });

  it('enumerates the default folder and nested custom folders without flattening their parents', async () => {
    const { graph, connector } = fixture();
    graph.get
      .mockResolvedValueOnce({ id: 'root', displayName: 'Contacts' })
      .mockResolvedValueOnce({ value: [{ id: 'custom', displayName: 'Example Folder' }] })
      .mockResolvedValueOnce({ value: [{ id: 'nested', displayName: 'Nested' }] })
      .mockResolvedValueOnce({ value: [] });
    const folders = await connector.list_contact_folders('tenant', 'owner');
    expect(folders).toEqual([
      { folder_id: 'root', display_name: 'Contacts', is_default: true },
      {
        folder_id: 'custom',
        display_name: 'Example Folder',
        is_default: false,
        parent_folder_id: 'root',
      },
      {
        folder_id: 'nested',
        display_name: 'Nested',
        is_default: false,
        parent_folder_id: 'custom',
      },
    ]);
    expect(graph.api).toHaveBeenCalledWith('/users/owner/contactFolders/custom/childFolders');
  });

  it('does not advance a cursor when interrupted mid-page', async () => {
    const { graph, connector } = fixture();
    graph.get.mockResolvedValue({ value: [{ id: 'c1' }], '@odata.deltaLink': 'final' });
    const result = await connector.fetch_contact_delta(
      'tenant',
      'owner',
      'folder',
      'old',
      async () => false,
    );
    expect(result.delta_link).toBeUndefined();
  });

  it('restarts an expired cursor before delivering pages, but rejects a mid-round reset', async () => {
    const { graph, connector } = fixture();
    graph.get.mockRejectedValueOnce(new Error('syncStateNotFound')).mockResolvedValueOnce({
      value: [{ id: 'c1', displayName: 'John Doe' }],
      '@odata.deltaLink': 'new-link',
    });
    const changes: string[] = [];
    const result = await connector.fetch_contact_delta(
      'tenant',
      'owner',
      'folder',
      'old-link',
      async (items) => {
        changes.push(...items.map((item) => item.contact_id));
        return true;
      },
    );
    expect(result).toEqual({ delta_link: 'new-link', reset: true });
    expect(changes).toEqual(['c1']);

    graph.get
      .mockReset()
      .mockResolvedValueOnce({ value: [{ id: 'c2' }], '@odata.nextLink': 'page-2' })
      .mockRejectedValueOnce(new Error('resyncRequired'));
    await expect(
      connector.fetch_contact_delta('tenant', 'owner', 'folder', 'old-link', async () => true),
    ).rejects.toThrow('resyncRequired');
  });

  it('returns the contact photo bytes without treating the binary as JSON', async () => {
    const { graph, connector } = fixture();
    graph.get.mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
    expect(await connector.fetch_contact_photo('tenant', 'owner', 'c1')).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('stops instead of fetching the same contact page forever', async () => {
    const { graph, connector } = fixture();
    graph.get.mockResolvedValue({ value: [], '@odata.nextLink': '/same-page' });
    await expect(connector.list_contacts('tenant', 'owner', 'folder')).rejects.toThrow(
      'repeated a next link',
    );
    expect(graph.get).toHaveBeenCalledTimes(2);
  });

  it('names contact permissions for denied contact reads and writes', async () => {
    const { graph, connector } = fixture();
    graph.get.mockRejectedValueOnce({ statusCode: 403 });
    await expect(connector.fetch_contact('tenant', 'owner', 'c1')).rejects.toThrow('Contacts.Read');
    graph.post.mockRejectedValueOnce({ statusCode: 403 });
    await expect(connector.create_contact('tenant', 'owner', 'folder', {})).rejects.toThrow(
      'Contacts.ReadWrite',
    );
  });

  it('treats a missing photo as absence, but propagates other failures', async () => {
    const { graph, connector } = fixture();
    graph.get.mockRejectedValueOnce({ statusCode: 404 });
    expect(await connector.fetch_contact_photo('tenant', 'owner', 'c1')).toBeUndefined();
    graph.get.mockRejectedValueOnce(new Error('storage service unavailable'));
    await expect(connector.fetch_contact_photo('tenant', 'owner', 'c1')).rejects.toThrow(
      'unavailable',
    );
  });
});
