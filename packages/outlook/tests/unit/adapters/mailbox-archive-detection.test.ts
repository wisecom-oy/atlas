import { describe, it, expect, vi } from 'vitest';
import { Container } from 'inversify';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import {
  GraphMailboxDiscoveryAdapter,
  parse_usage_csv,
} from '@/adapters/graph-mailbox-discovery.adapter';

const LICENSED_PLAN = [{ service: 'exchange', capabilityStatus: 'Enabled', servicePlanId: 'p' }];

/** A Graph client whose `get` returns the queued responses in order. */
function make_client(responses: unknown[]): { api: ReturnType<typeof vi.fn> } {
  const get = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) get.mockRejectedValueOnce(response);
    else get.mockResolvedValueOnce(response);
  }
  get.mockRejectedValue(new Error('no further responses queued'));
  const chain = { header: vi.fn(), get };
  chain.header.mockReturnValue(chain);
  return { api: vi.fn().mockReturnValue(chain) };
}

function discover(client: {
  api: ReturnType<typeof vi.fn>;
}): ReturnType<GraphMailboxDiscoveryAdapter['list_tenant_mailboxes']> {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(client);
  container.bind(GraphMailboxDiscoveryAdapter).toSelf();
  return container
    .get(GraphMailboxDiscoveryAdapter)
    .list_tenant_mailboxes('t1', { licensed_only: true });
}

describe('In-Place Archive detection (issue #46)', () => {
  it('reads the Has Archive column when the report includes it', () => {
    const csv = [
      'User Principal Name,Storage Used (Byte),Item Count,Has Archive',
      'alice@contoso.com,999,10,True',
      'bob@contoso.com,999,10,False',
    ].join('\n');

    const result = parse_usage_csv(csv);
    expect(result.get('alice@contoso.com')?.has_archive).toBe(true);
    expect(result.get('bob@contoso.com')?.has_archive).toBe(false);
  });

  it('leaves archive state unknown when the column is absent', () => {
    // The column is documented on getMailboxUsageDetail but missing from the
    // example schema on the same reference page, so absence must not read as
    // "no archive": that false reassurance is what this issue is about.
    const csv = [
      'User Principal Name,Storage Used (Byte),Item Count',
      'alice@contoso.com,999,10',
    ].join('\n');

    const row = parse_usage_csv(csv).get('alice@contoso.com');
    expect(row).toBeDefined();
    expect(row?.has_archive).toBeUndefined();
  });

  it('leaves archive state unknown for a blank or unrecognised value', () => {
    const csv = [
      'User Principal Name,Storage Used (Byte),Item Count,Has Archive',
      'alice@contoso.com,999,10,',
      'bob@contoso.com,999,10,Maybe',
    ].join('\n');

    const result = parse_usage_csv(csv);
    expect(result.get('alice@contoso.com')?.has_archive).toBeUndefined();
    expect(result.get('bob@contoso.com')?.has_archive).toBeUndefined();
  });

  it('carries archive state from the usage report onto the mailbox', async () => {
    const client = make_client([
      {
        value: [
          { id: 'u1', mail: 'a@t.com', displayName: 'A', assignedPlans: LICENSED_PLAN },
          { id: 'u2', mail: 'b@t.com', displayName: 'B', assignedPlans: LICENSED_PLAN },
        ],
      },
      [
        'User Principal Name,Storage Used (Byte),Item Count,Has Archive',
        'a@t.com,1024,10,True',
        'b@t.com,2048,20,False',
      ].join('\n'),
    ]);

    const result = await discover(client);

    expect(result.find((m) => m.mail === 'a@t.com')?.has_in_place_archive).toBe(true);
    expect(result.find((m) => m.mail === 'b@t.com')?.has_in_place_archive).toBe(false);
  });

  it('leaves archive state unset when the usage report is unavailable', async () => {
    // Reports.Read.All is optional, and discovery already tolerates its
    // absence. An unreadable report means unknown coverage, not clear coverage.
    const client = make_client([
      { value: [{ id: 'u1', mail: 'a@t.com', displayName: 'A', assignedPlans: LICENSED_PLAN }] },
      new Error('no Reports.Read.All'),
    ]);

    const result = await discover(client);

    expect(result).toHaveLength(1);
    expect(result[0]?.has_in_place_archive).toBeUndefined();
  });
});
