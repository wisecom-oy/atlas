import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';

import { GraphContactsConnector } from '@/adapters/graph-contacts-connector.adapter';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const FOLDER = 'folder-1';
const DELTA_URL = `/users/${MAILBOX}/contactFolders/${FOLDER}/contacts/delta`;

function connector_with(route: (call: GraphCall) => unknown) {
  const graph = stub_graph_client(route);
  const connector = new GraphContactsConnector(graph.client as unknown as Client);
  return { connector, calls: graph.calls };
}

describe('GraphContactsConnector delta reads', () => {
  it('follows nextLink pages and keeps the final deltaLink', async () => {
    const { connector, calls } = connector_with((call) => {
      if (call.url === DELTA_URL) {
        return { value: [{ id: 'c1' }], '@odata.nextLink': 'https://graph.example.com/page-2' };
      }
      return { value: [{ id: 'c2' }], '@odata.deltaLink': 'https://graph.example.com/delta-end' };
    });

    const result = await connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER);

    expect(result.upserted.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(result.delta_link).toBe('https://graph.example.com/delta-end');
    expect(result.reset).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([DELTA_URL, 'https://graph.example.com/page-2']);
  });

  it('rejects a nextLink that does not advance instead of looping', async () => {
    const { connector } = connector_with(() => ({
      value: [],
      '@odata.nextLink': DELTA_URL,
    }));

    await expect(connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER)).rejects.toThrow(
      'did not advance',
    );
  });

  it('separates @removed entries into removed_ids', async () => {
    const { connector } = connector_with(() => ({
      value: [{ id: 'kept' }, { id: 'gone', '@removed': { reason: 'deleted' } }],
      '@odata.deltaLink': 'https://graph.example.com/delta-end',
    }));

    const result = await connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER);

    expect(result.upserted.map((c) => c.id)).toEqual(['kept']);
    expect(result.removed_ids).toEqual(['gone']);
  });

  it('re-reads the folder in full and reports reset when the stored link is rejected', async () => {
    const stored = 'https://graph.example.com/stale-link';
    const { connector, calls } = connector_with((call) => {
      if (call.url === stored) throw graph_error(410, 'SyncStateNotFound');
      return { value: [{ id: 'c1' }], '@odata.deltaLink': 'https://graph.example.com/fresh' };
    });

    const result = await connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER, stored);

    expect(result.reset).toBe(true);
    expect(result.upserted.map((c) => c.id)).toEqual(['c1']);
    expect(result.delta_link).toBe('https://graph.example.com/fresh');
    expect(calls.map((c) => c.url)).toEqual([stored, DELTA_URL]);
  });

  it('does not treat other errors on a stored link as a reset', async () => {
    const stored = 'https://graph.example.com/stale-link';
    const { connector, calls } = connector_with(() => {
      throw graph_error(400, 'BadRequest');
    });

    await expect(
      connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER, stored),
    ).rejects.toThrow();
    expect(calls.map((c) => c.url)).toEqual([stored]);
  });

  it('maps a 403 on delta to an AuthError naming Contacts.Read', async () => {
    const { connector } = connector_with(() => {
      throw graph_error(403, 'ErrorAccessDenied');
    });

    const error = await connector
      .fetch_contact_delta('tenant-1', MAILBOX, FOLDER)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).toMatch(/Contacts\.Read/);
  });

  it('reports an unlicensed mailbox as MailboxNotLicensedError, not as a missing grant', async () => {
    const { connector } = connector_with(() => {
      throw graph_error(403, 'MailboxNotEnabledForRESTAPI', 'Mailbox not enabled for REST API.');
    });

    await expect(connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER)).rejects.toBeInstanceOf(
      MailboxNotLicensedError,
    );
  });

  it('sends the ImmutableId Prefer header on delta requests', async () => {
    const headers: Record<string, string> = {};
    const client = {
      api: () => ({
        header(name: string, value: string) {
          headers[name] = value;
          return this;
        },
        get: async () => ({ value: [], '@odata.deltaLink': 'https://graph.example.com/d' }),
      }),
    };
    const connector = new GraphContactsConnector(client as unknown as Client);

    await connector.fetch_contact_delta('tenant-1', MAILBOX, FOLDER);

    expect(headers.Prefer).toBe('IdType="ImmutableId"');
  });
});

describe('GraphContactsConnector photos', () => {
  it('returns undefined when the contact has no photo (404)', async () => {
    const { connector } = connector_with(() => {
      throw graph_error(404, 'ErrorItemNotFound');
    });

    await expect(
      connector.fetch_contact_photo('tenant-1', MAILBOX, FOLDER, 'c1'),
    ).resolves.toBeUndefined();
  });

  it('returns the photo bytes when present', async () => {
    const { connector } = connector_with(() => new Response(new Uint8Array([1, 2, 3])));

    const photo = await connector.fetch_contact_photo('tenant-1', MAILBOX, FOLDER, 'c1');

    expect(Array.from(photo ?? [])).toEqual([1, 2, 3]);
  });
});

describe('GraphContactsConnector folder listing for restore', () => {
  it('lists contacts under their immutable ids with the Atlas source tag expanded', async () => {
    const graph = stub_graph_client(() => ({ value: [{ id: 'c1' }] }), { record_headers: true });
    const connector = new GraphContactsConnector(graph.client as unknown as Client);

    const contacts = await connector.list_folder_contacts('tenant-1', MAILBOX, FOLDER);

    expect(contacts).toEqual([{ id: 'c1' }]);
    const call = graph.calls[0];
    expect(call?.headers?.['Prefer']).toBe('IdType="ImmutableId"');
    expect(decodeURIComponent(call?.url ?? '')).toContain(
      "$expand=singleValueExtendedProperties($filter=id eq 'String " +
        "{6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceContactId')",
    );
  });
});
