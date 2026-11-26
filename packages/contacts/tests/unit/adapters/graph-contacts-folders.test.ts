import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';

import { list_contact_folders } from '@/adapters/graph-contacts-folders';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const BASE = `/users/${MAILBOX}/contactFolders`;
const children_url = (id: string): string => `${BASE}/${id}/childFolders?$count=true`;

function client_for(route: (call: GraphCall) => unknown) {
  const graph = stub_graph_client(route);
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

/** Routes the root folder, one child with two pages, and an empty grandchild listing. */
function two_page_tree(drop_next_link: boolean) {
  return (call: GraphCall): unknown => {
    if (call.url === `${BASE}/contacts`) return { id: 'root', displayName: 'Contacts' };
    if (call.url === children_url('root')) {
      return {
        value: [{ id: 'f-1', displayName: 'One' }],
        '@odata.count': 2,
        ...(drop_next_link ? {} : { '@odata.nextLink': 'https://graph.example.com/page-2' }),
      };
    }
    if (call.url === 'https://graph.example.com/page-2') {
      return { value: [{ id: 'f-2', displayName: 'Two' }], '@odata.count': 2 };
    }
    return { value: [], '@odata.count': 0 };
  };
}

describe('list_contact_folders', () => {
  it('lists every child folder across pages, asking Graph to count each level', async () => {
    const { client, calls } = client_for(two_page_tree(false));

    const folders = await list_contact_folders(client, MAILBOX);

    expect(folders.map((folder) => folder.id)).toEqual(['root', 'f-1', 'f-2']);
    expect(calls.map((call) => call.url)).toContain(children_url('root'));
  });

  it('refuses a child listing that ends after its first page with fewer folders than counted', async () => {
    const { client } = client_for(two_page_tree(true));

    const listing = list_contact_folders(client, MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(ListingIncompleteError);
    await expect(listing).rejects.toMatchObject({
      listing: 'contact folders',
      listed_count: 1,
      reported_count: 2,
    });
  });
});
