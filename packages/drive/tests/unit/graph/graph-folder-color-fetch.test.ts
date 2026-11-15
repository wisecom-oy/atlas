import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { fetch_drive_folder_colors, parse_folder_color } from '@/graph/graph-folder-color-fetch';

interface SubRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
}

type SubResponse = { status: number; headers?: Record<string, string>; body?: unknown };

function item_of(request: SubRequest): string {
  return request.url.split('/items/')[1]!.split('/')[0]!;
}

/** A client whose `$batch` answers each folder with `answer(item_id, pass)`. */
function batch_client(answer: (item_id: string, pass: number) => SubResponse) {
  const batches: SubRequest[][] = [];
  const stub = stub_graph_client((call: GraphCall) => {
    const requests = (call.body as { requests: SubRequest[] }).requests;
    const pass = batches.length;
    batches.push(requests);
    return {
      responses: requests.map((request) => ({ id: request.id, ...answer(item_of(request), pass) })),
    };
  });
  return { client: stub.client, calls: stub.calls, batches };
}

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `folder-${i}`);

describe('fetch_drive_folder_colors (#581)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads 45 folders in three `$batch` requests of at most 20, selecting only the colour columns', async () => {
    const { client, calls, batches } = batch_client(() => ({
      status: 200,
      body: { '@odata.etag': '"1"', _ColorHex: '6' },
    }));

    const found = await fetch_drive_folder_colors(client, 'drive-1', ids(45));

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'post /$batch',
      'post /$batch',
      'post /$batch',
    ]);
    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(batches[0]?.[0]).toEqual({
      id: '0',
      method: 'GET',
      url: '/drives/drive-1/items/folder-0/listItem/fields?$select=_ColorHex,_ColorTag,_Emoji',
    });
    expect(found.size).toBe(45);
    expect(found.get('folder-7')).toEqual({ color_hex: '6' });
  });

  it('reads a folder Graph answers with only an etag as having no colour', async () => {
    const { client } = batch_client(() => ({ status: 200, body: { '@odata.etag': '"1"' } }));

    const found = await fetch_drive_folder_colors(client, 'drive-1', ['folder-0']);

    expect(found.get('folder-0')).toEqual({});
  });

  it('leaves out a folder Graph refused, so the caller does not read it as uncoloured', async () => {
    const { client } = batch_client((item_id) =>
      item_id === 'folder-1'
        ? { status: 404, body: { error: { code: 'itemNotFound' } } }
        : { status: 200, body: {} },
    );

    const found = await fetch_drive_folder_colors(client, 'drive-1', ids(2));

    expect(found.has('folder-0')).toBe(true);
    expect(found.has('folder-1')).toBe(false);
  });

  it('logs one line, with no ids, when Graph refuses every folder of a drive', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { client } = batch_client(() => ({
      status: 403,
      body: { error: { code: 'accessDenied', message: 'Access denied' } },
    }));

    const found = await fetch_drive_folder_colors(client, 'drive-1', ids(45));

    expect(found.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('Folder colour capture skipped 45 item(s)');
    expect(line).not.toContain('drive-1');
    expect(line).not.toContain('folder-');
    warn.mockRestore();
  });

  it('resends only the throttled folders after backing off', async () => {
    const { client, batches } = batch_client((item_id, pass) =>
      item_id === 'folder-1' && pass === 0
        ? { status: 429, headers: { 'Retry-After': '1' }, body: { error: { code: 'tooMany' } } }
        : { status: 200, body: { _ColorHex: '2' } },
    );

    const pending = fetch_drive_folder_colors(client, 'drive-1', ids(3));
    await vi.runAllTimersAsync();
    const found = await pending;

    expect(batches.map((batch) => batch.map(item_of))).toEqual([
      ['folder-0', 'folder-1', 'folder-2'],
      ['folder-1'],
    ]);
    expect(found.get('folder-1')).toEqual({ color_hex: '2' });
  });

  it('makes no request when there is nothing to read', async () => {
    const { calls } = batch_client(() => ({ status: 200 }));

    await fetch_drive_folder_colors(stub_graph_client(() => ({})).client, 'drive-1', []);

    expect(calls).toHaveLength(0);
  });
});

describe('parse_folder_color (#581)', () => {
  it('keeps only the non-empty colour columns under their Atlas names', () => {
    expect(
      parse_folder_color({
        '@odata.etag': '"3"',
        _ColorHex: '12',
        _ColorTag: '  ',
        _Emoji: '',
        Title: 'ignored',
      }),
    ).toEqual({ color_hex: '12' });
    expect(parse_folder_color({ _ColorHex: 4, _ColorTag: 'Red', _Emoji: 'star' })).toEqual({
      color_hex: '4',
      color_tag: 'Red',
      emoji: 'star',
    });
    expect(parse_folder_color({ _ColorHex: null, _ColorTag: { nested: true } })).toEqual({});
  });
});
