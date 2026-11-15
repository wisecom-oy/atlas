import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stub_graph_client, type GraphCall } from '@wisecom/atlas-types/testing/stub-graph-client';
import { fetch_drive_item_permissions } from '@/permissions/graph-permission-fetch';

interface SubRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
}

type SubResponse = { status: number; headers?: Record<string, string>; body?: unknown };

const GRANT = { roles: ['write'], grantedToV2: { user: { id: 'u-1', displayName: 'Jane Roe' } } };

function item_of(request: SubRequest): string {
  return request.url.split('/items/')[1]!.split('/')[0]!;
}

/** A client whose `$batch` answers each item with `answer(item_id, pass)`. */
function batch_client(answer: (item_id: string, pass: number) => SubResponse) {
  const batches: SubRequest[][] = [];
  const stub = stub_graph_client((call: GraphCall) => {
    if (call.url !== '/$batch') return { value: [GRANT] };
    const requests = (call.body as { requests: SubRequest[] }).requests;
    const pass = batches.length;
    batches.push(requests);
    return {
      responses: requests.map((request) => ({ id: request.id, ...answer(item_of(request), pass) })),
    };
  });
  return { client: stub.client, calls: stub.calls, batches };
}

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `item-${i}`);

describe('fetch_drive_item_permissions (#580)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads 45 items in three `$batch` requests of at most 20', async () => {
    const { client, batches } = batch_client(() => ({ status: 200, body: { value: [GRANT] } }));

    const found = await fetch_drive_item_permissions(client, 'drive-1', ids(45));

    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(batches[0]?.[0]).toEqual({
      id: '0',
      method: 'GET',
      url: '/drives/drive-1/items/item-0/permissions',
    });
    expect(found.size).toBe(45);
    expect(found.get('item-7')).toEqual([
      { roles: ['write'], granted_to: { type: 'user', id: 'u-1', display_name: 'Jane Roe' } },
    ]);
  });

  it('resends only the throttled items after backing off', async () => {
    const { client, batches } = batch_client((item_id, pass) =>
      item_id === 'item-1' && pass === 0
        ? { status: 429, headers: { 'Retry-After': '1' }, body: { error: { code: 'tooMany' } } }
        : { status: 200, body: { value: [] } },
    );

    const pending = fetch_drive_item_permissions(client, 'drive-1', ids(3));
    await vi.runAllTimersAsync();
    const found = await pending;

    expect(batches.map((batch) => batch.map(item_of))).toEqual([
      ['item-0', 'item-1', 'item-2'],
      ['item-1'],
    ]);
    expect([...found.keys()].sort()).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('leaves out an item Graph no longer has, so the caller does not read it as unshared', async () => {
    const { client } = batch_client((item_id) =>
      item_id === 'item-1'
        ? { status: 404, body: { error: { code: 'itemNotFound' } } }
        : { status: 200, body: { value: [] } },
    );

    const found = await fetch_drive_item_permissions(client, 'drive-1', ids(2));

    expect(found.has('item-0')).toBe(true);
    expect(found.has('item-1')).toBe(false);
  });

  it('follows a permission list that spans pages', async () => {
    const { client, calls } = batch_client(() => ({
      status: 200,
      body: { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' },
    }));

    const found = await fetch_drive_item_permissions(client, 'drive-1', ['item-0']);

    expect(calls.map((call) => call.url)).toContain('https://graph.microsoft.com/v1.0/next-page');
    expect(found.get('item-0')).toHaveLength(1);
  });

  it('makes no request when there is nothing to read', async () => {
    const { calls } = batch_client(() => ({ status: 200 }));
    const stub = stub_graph_client(() => ({}));
    await fetch_drive_item_permissions(stub.client, 'drive-1', []);
    expect(stub.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
