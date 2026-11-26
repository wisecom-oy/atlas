import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';

import { list_contact_folders } from '@/adapters/graph-contacts-folders';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const BASE = `/users/${MAILBOX}/contactFolders`;
const ROOT_PAGE_2 = 'https://graph.example.com/root-children-page-2';
const children_url = (id: string): string => `${BASE}/${id}/childFolders?$count=true`;

type Listings = Readonly<Record<string, readonly { id: string; displayName: string }[]>>;

/** Serves the root folder and each folder's children from `listings`, counting what is served. */
function tree_client(listings: Listings, counts: Readonly<Record<string, number>> = {}) {
  const graph = stub_graph_client((call: GraphCall) => {
    if (call.url === `${BASE}/contacts`) return { id: 'root', displayName: 'Contacts' };
    const parent = Object.keys(listings).find((id) => call.url === children_url(id));
    const value = parent ? listings[parent]! : [];
    return { value, '@odata.count': counts[parent ?? ''] ?? value.length };
  });
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

/** How often the walk listed one folder's children. */
function listings_of(calls: readonly GraphCall[], id: string): number {
  return calls.filter((call) => call.url === children_url(id)).length;
}

describe('list_contact_folders with a folder Graph lists twice (#964)', () => {
  it('returns a folder repeated across pages once and walks its subtree once', async () => {
    const graph = stub_graph_client((call: GraphCall) => {
      if (call.url === `${BASE}/contacts`) return { id: 'root', displayName: 'Contacts' };
      if (call.url === children_url('root')) {
        return {
          value: [{ id: 'f-1', displayName: 'One' }],
          '@odata.count': 2,
          '@odata.nextLink': ROOT_PAGE_2,
        };
      }
      if (call.url === ROOT_PAGE_2) {
        return { value: [{ id: 'f-1', displayName: 'One' }], '@odata.count': 2 };
      }
      if (call.url === children_url('f-1')) {
        return { value: [{ id: 'f-1a', displayName: 'Nested' }], '@odata.count': 1 };
      }
      return { value: [], '@odata.count': 0 };
    });

    const folders = await list_contact_folders(graph.client as unknown as Client, MAILBOX);

    expect(folders.map((folder) => folder.id)).toEqual(['root', 'f-1', 'f-1a']);
    expect(listings_of(graph.calls, 'f-1')).toBe(1);
    expect(listings_of(graph.calls, 'f-1a')).toBe(1);
  });

  it('walks a folder listed under two parents once, at the path it was first listed under', async () => {
    const { client, calls } = tree_client({
      root: [
        { id: 'parent-a', displayName: 'A' },
        { id: 'parent-b', displayName: 'B' },
      ],
      'parent-a': [{ id: 'shared', displayName: 'Shared' }],
      'parent-b': [{ id: 'shared', displayName: 'Shared' }],
      shared: [{ id: 'leaf', displayName: 'Leaf' }],
    });

    const folders = await list_contact_folders(client, MAILBOX);

    expect(folders.map((folder) => folder.id)).toEqual([
      'root',
      'parent-a',
      'shared',
      'leaf',
      'parent-b',
    ]);
    expect(folders.find((folder) => folder.id === 'shared')?.path).toEqual(['A', 'Shared']);
    expect(listings_of(calls, 'shared')).toBe(1);
    expect(listings_of(calls, 'leaf')).toBe(1);
  });

  it('does not list the default folder again when Graph returns it as a child', async () => {
    const { client, calls } = tree_client({
      root: [
        { id: 'root', displayName: 'Contacts' },
        { id: 'f-1', displayName: 'One' },
      ],
    });

    const folders = await list_contact_folders(client, MAILBOX);

    expect(folders.map((folder) => folder.id)).toEqual(['root', 'f-1']);
    expect(listings_of(calls, 'root')).toBe(1);
  });

  it('counts the repeat toward @odata.count, so a short listing still fails', async () => {
    const { client } = tree_client(
      {
        root: [
          { id: 'f-1', displayName: 'One' },
          { id: 'f-1', displayName: 'One' },
        ],
      },
      { root: 3 },
    );

    const listing = list_contact_folders(client, MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(ListingIncompleteError);
    await expect(listing).rejects.toMatchObject({ listed_count: 2, reported_count: 3 });
  });

  it('accepts a listing whose repeat makes up its @odata.count', async () => {
    const { client } = tree_client(
      {
        root: [
          { id: 'f-1', displayName: 'One' },
          { id: 'f-1', displayName: 'One' },
        ],
      },
      { root: 2 },
    );

    const folders = await list_contact_folders(client, MAILBOX);

    expect(folders.map((folder) => folder.id)).toEqual(['root', 'f-1']);
  });
});
