import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { describe, expect, it, vi } from 'vitest';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { logger } from '@wisecom/atlas-core/utils/logger';

import { fetch_calendar_delta } from '@/adapters/graph-calendar-delta';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const CALENDAR = 'cal-work';
const FULL_PATH = `/users/${MAILBOX}/calendars/${CALENDAR}/events/delta`;
const STORED_LINK = 'https://graph.example.com/delta?token=stored';
const FRESH_LINK = 'https://graph.example.com/delta?token=fresh';
const NEXT_PAGE = 'https://graph.example.com/delta?page=2';

function client_for(route: (call: GraphCall) => unknown) {
  const graph = stub_graph_client(route);
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

describe('fetch_calendar_delta full reads', () => {
  it('follows every page of a full read and keeps the last delta link', async () => {
    const { client, calls } = client_for((call) => {
      if (call.url === NEXT_PAGE) {
        return { value: [{ id: 'e2' }], '@odata.deltaLink': FRESH_LINK };
      }
      return { value: [{ id: 'e1' }], '@odata.nextLink': NEXT_PAGE };
    });

    const result = await fetch_calendar_delta(client, MAILBOX, CALENDAR);

    expect(result.upserted.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.removed_ids).toEqual([]);
    expect(result.delta_link).toBe(FRESH_LINK);
    expect(result.reset).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining(FULL_PATH), NEXT_PAGE]);
  });

  it('asks the first full read for the fields a restore needs', async () => {
    const { client, calls } = client_for(() => ({ value: [], '@odata.deltaLink': FRESH_LINK }));

    await fetch_calendar_delta(client, MAILBOX, CALENDAR);

    const select = new URL(calls[0]!.url, 'https://graph.example.com').searchParams.get('$select');
    expect(select?.split(',')).toEqual(
      expect.arrayContaining([
        'iCalUId',
        'attendees',
        'seriesMasterId',
        'originalStartTimeZone',
        'body',
      ]),
    );
  });

  it('fails when the final page carries no delta link instead of reporting an empty change set', async () => {
    const { client } = client_for(() => ({ value: [{ id: 'e1' }] }));

    await expect(fetch_calendar_delta(client, MAILBOX, CALENDAR)).rejects.toThrow(
      'carried no deltaLink',
    );
  });

  it('stops with an error when a next link repeats instead of looping', async () => {
    const { client } = client_for((call) => ({ value: [], '@odata.nextLink': call.url }));

    await expect(fetch_calendar_delta(client, MAILBOX, CALENDAR)).rejects.toThrow(
      'did not advance',
    );
  });
});

describe('fetch_calendar_delta incremental reads', () => {
  it('reads from a stored link that Graph still accepts, without a reset', async () => {
    const { client, calls } = client_for(() => ({
      value: [{ id: 'e1' }],
      '@odata.deltaLink': FRESH_LINK,
    }));

    const result = await fetch_calendar_delta(client, MAILBOX, CALENDAR, STORED_LINK);

    expect(result.reset).toBe(false);
    expect(result.delta_link).toBe(FRESH_LINK);
    expect(calls.map((c) => c.url)).toEqual([STORED_LINK]);
  });

  it('re-reads the whole calendar and flags the reset when the stored link is invalid', async () => {
    const { client, calls } = client_for((call) => {
      if (call.url === STORED_LINK) {
        throw graph_error(410, 'SyncStateNotFound', 'The sync state was not found.');
      }
      return { value: [{ id: 'e1' }], '@odata.deltaLink': FRESH_LINK };
    });

    const result = await fetch_calendar_delta(client, MAILBOX, CALENDAR, STORED_LINK);

    expect(result.reset).toBe(true);
    expect(result.upserted.map((e) => e.id)).toEqual(['e1']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.startsWith(FULL_PATH)).toBe(true);
  });

  it('propagates a stored-link failure that is not an invalid delta, without re-reading', async () => {
    const { client, calls } = client_for(() => {
      throw graph_error(404, 'ErrorItemNotFound', 'The calendar was not found.');
    });

    await expect(fetch_calendar_delta(client, MAILBOX, CALENDAR, STORED_LINK)).rejects.toThrow(
      'calendar was not found',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('fetch_calendar_delta change classification', () => {
  it('keeps only the last appearance of each event across pages', async () => {
    const { client } = client_for((call) => {
      if (call.url === NEXT_PAGE) {
        return {
          value: [
            { id: 'e1', '@removed': { reason: 'deleted' } },
            { id: 'e2', subject: 'v2' },
          ],
          '@odata.deltaLink': FRESH_LINK,
        };
      }
      return {
        value: [
          { id: 'e1', subject: 'v1' },
          { id: 'e2', '@removed': { reason: 'deleted' } },
        ],
        '@odata.nextLink': NEXT_PAGE,
      };
    });

    const result = await fetch_calendar_delta(client, MAILBOX, CALENDAR);

    expect(result.upserted).toEqual([{ id: 'e2', subject: 'v2' }]);
    expect(result.removed_ids).toEqual(['e1']);
  });

  it('skips events Graph returns without a usable id, and warns how many', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { client } = client_for(() => ({
      value: [
        { subject: 'no id' },
        { id: '', subject: 'empty id' },
        { '@removed': { reason: 'deleted' } },
        { id: 'e1', subject: 'kept' },
      ],
      '@odata.deltaLink': FRESH_LINK,
    }));

    const result = await fetch_calendar_delta(client, MAILBOX, CALENDAR);

    expect(result.upserted).toEqual([{ id: 'e1', subject: 'kept' }]);
    expect(result.removed_ids).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Skipped 3 event(s) that Graph returned without an id');
    warn.mockRestore();
  });
});
