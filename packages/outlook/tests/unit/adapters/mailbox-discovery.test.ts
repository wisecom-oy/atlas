import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'inversify';
import {
  extract_exchange_license_status,
  map_users_to_tenant_mailboxes,
  parse_mailbox_purpose,
} from '@/adapters/graph-mailbox-response-mappers';
import {
  GraphMailboxDiscoveryAdapter,
  parse_usage_csv,
} from '@/adapters/graph-mailbox-discovery.adapter';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type { GraphAssignedPlan, GraphUserRecord } from '@/adapters/graph-mailbox-response-mappers';

describe('extract_exchange_license_status', () => {
  it('returns has_license=false when no plans', () => {
    expect(extract_exchange_license_status(undefined)).toEqual({ has_license: false });
    expect(extract_exchange_license_status([])).toEqual({ has_license: false });
  });

  it('detects enabled Exchange plan', () => {
    const plans: GraphAssignedPlan[] = [
      { service: 'exchange', capabilityStatus: 'Enabled', servicePlanId: 'abc' },
    ];
    expect(extract_exchange_license_status(plans)).toEqual({
      has_license: true,
      status: 'Enabled',
    });
  });

  it('detects suspended Exchange plan as not licensed', () => {
    const plans: GraphAssignedPlan[] = [
      { service: 'exchange', capabilityStatus: 'Suspended', servicePlanId: 'abc' },
    ];
    const result = extract_exchange_license_status(plans);
    expect(result.has_license).toBe(false);
    expect(result.status).toBe('Suspended');
  });

  it('case-insensitive service matching', () => {
    const plans: GraphAssignedPlan[] = [
      { service: 'Exchange', capabilityStatus: 'Enabled', servicePlanId: 'abc' },
    ];
    expect(extract_exchange_license_status(plans).has_license).toBe(true);
  });

  it('ignores non-exchange plans', () => {
    const plans: GraphAssignedPlan[] = [
      { service: 'SharePoint', capabilityStatus: 'Enabled', servicePlanId: 'abc' },
    ];
    expect(extract_exchange_license_status(plans)).toEqual({ has_license: false });
  });
});

describe('parse_mailbox_purpose', () => {
  it('passes through known purposes', () => {
    expect(parse_mailbox_purpose('shared')).toBe('shared');
    expect(parse_mailbox_purpose('user')).toBe('user');
    expect(parse_mailbox_purpose('room')).toBe('room');
  });

  it('maps unknown strings to others', () => {
    expect(parse_mailbox_purpose('unknownFutureValue')).toBe('others');
  });

  it('returns undefined for empty or non-string values', () => {
    expect(parse_mailbox_purpose(undefined)).toBeUndefined();
    expect(parse_mailbox_purpose('')).toBeUndefined();
    expect(parse_mailbox_purpose(42)).toBeUndefined();
  });
});

describe('map_users_to_tenant_mailboxes', () => {
  it('maps users with license info', () => {
    const users: GraphUserRecord[] = [
      {
        id: 'u1',
        mail: 'alice@contoso.com',
        displayName: 'Alice',
        assignedPlans: [{ service: 'exchange', capabilityStatus: 'Enabled', servicePlanId: 'abc' }],
      },
      {
        id: 'u2',
        mail: 'bob@contoso.com',
        displayName: 'Bob',
        assignedPlans: [],
      },
    ];

    const result = map_users_to_tenant_mailboxes(users);
    expect(result).toHaveLength(2);
    expect(result[0]!.has_exchange_license).toBe(true);
    expect(result[0]!.mail).toBe('alice@contoso.com');
    expect(result[1]!.has_exchange_license).toBe(false);
  });

  it('filters out users without id or mail', () => {
    const users: GraphUserRecord[] = [
      { mail: 'no-id@contoso.com', displayName: 'No ID' },
      { id: 'u3', displayName: 'No Mail' },
      { id: 'u4', mail: 'valid@contoso.com', displayName: 'Valid' },
    ];
    const result = map_users_to_tenant_mailboxes(users);
    expect(result).toHaveLength(1);
    expect(result[0]!.mail).toBe('valid@contoso.com');
  });
});

describe('parse_usage_csv', () => {
  it('parses storage and item count from CSV', () => {
    const csv = [
      'Report Refresh Date,User Principal Name,Display Name,Is Deleted,Deleted Date,Created Date,Last Activity Date,Item Count,Storage Used (Byte),Report Period',
      '2026-03-18,alice@contoso.com,Alice,False,,2019-01-01,2026-03-17,4200,1073741824,7',
      '2026-03-18,bob@contoso.com,Bob,False,,2020-06-01,2026-03-16,150,52428800,7',
    ].join('\n');

    const result = parse_usage_csv(csv);
    expect(result.size).toBe(2);

    const alice = result.get('alice@contoso.com');
    expect(alice?.storage_bytes).toBe(1073741824);
    expect(alice?.item_count).toBe(4200);

    const bob = result.get('bob@contoso.com');
    expect(bob?.storage_bytes).toBe(52428800);
    expect(bob?.item_count).toBe(150);
  });

  it('returns empty map for empty CSV', () => {
    expect(parse_usage_csv('')).toEqual(new Map());
    expect(parse_usage_csv('header only')).toEqual(new Map());
  });

  it('returns empty map when required columns are missing', () => {
    const csv = 'Name,Email\nalice,alice@contoso.com';
    expect(parse_usage_csv(csv).size).toBe(0);
  });

  it('lowercases UPN keys for case-insensitive matching', () => {
    const csv = [
      'User Principal Name,Storage Used (Byte),Item Count',
      'Alice@Contoso.COM,999,10',
    ].join('\n');

    const result = parse_usage_csv(csv);
    expect(result.get('alice@contoso.com')).toBeDefined();
  });

  it('parses rows with quoted comma fields without shifting columns', () => {
    const csv = [
      'Report Refresh Date,User Principal Name,Display Name,Item Count,Storage Used (Byte),Report Period',
      '2026-03-18,alice@contoso.com,"Alice, Finance",4200,1073741824,7',
    ].join('\n');

    const result = parse_usage_csv(csv);
    const alice = result.get('alice@contoso.com');
    expect(alice?.storage_bytes).toBe(1073741824);
    expect(alice?.item_count).toBe(4200);
  });

  it('parses escaped quotes inside quoted fields', () => {
    const csv = [
      'User Principal Name,Display Name,Item Count,Storage Used (Byte)',
      'bob@contoso.com,"Bob ""The Builder""",150,52428800',
    ].join('\n');

    const result = parse_usage_csv(csv);
    const bob = result.get('bob@contoso.com');
    expect(bob?.storage_bytes).toBe(52428800);
    expect(bob?.item_count).toBe(150);
  });
});

describe('GraphMailboxDiscoveryAdapter pagination (issue #33)', () => {
  it('resumes a failed /users page from its nextLink instead of restarting from page 1', async () => {
    const get = vi.fn();
    const chain = { header: vi.fn(), get };
    chain.header.mockReturnValue(chain);
    const api = vi.fn().mockReturnValue(chain);

    const licensed_plan = [
      { service: 'exchange', capabilityStatus: 'Enabled', servicePlanId: 'p' },
    ];
    get
      .mockResolvedValueOnce({
        value: [{ id: 'u1', mail: 'a@t.com', displayName: 'A', assignedPlans: licensed_plan }],
        '@odata.nextLink': 'https://graph/users?$skiptoken=page2',
      })
      .mockRejectedValueOnce(Object.assign(new Error('throttled'), { statusCode: 429 }))
      .mockResolvedValueOnce({
        value: [{ id: 'u2', mail: 'b@t.com', displayName: 'B', assignedPlans: licensed_plan }],
      })
      // usage report CSV fetch -- unavailable in this test
      .mockRejectedValue(new Error('no Reports.Read.All'));

    const container = new Container();
    container.bind(GRAPH_CLIENT_TOKEN).toConstantValue({ api });
    container.bind(GraphMailboxDiscoveryAdapter).toSelf();
    const adapter = container.get(GraphMailboxDiscoveryAdapter);

    vi.useFakeTimers();
    try {
      const promise = adapter.list_tenant_mailboxes('t1', { licensed_only: true });
      await vi.advanceTimersByTimeAsync(5_000); // skip the retry backoff
      const result = await promise;

      expect(result.map((m) => m.user_id)).toEqual(['u1', 'u2']);
      const user_urls = api.mock.calls
        .map((c) => c[0] as string)
        .filter((u) => u.includes('users'));
      // Page 1 fetched exactly once: the 429 retried only page 2.
      expect(user_urls.filter((u) => !u.includes('skiptoken')).length).toBe(1);
      expect(user_urls.filter((u) => u.includes('skiptoken')).length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
