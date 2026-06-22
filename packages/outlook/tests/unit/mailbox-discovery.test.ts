import { describe, it, expect } from 'vitest';
import {
  extract_exchange_license_status,
  map_users_to_tenant_mailboxes,
} from '@/adapters/graph-mailbox-response-mappers';
import { parse_usage_csv } from '@/adapters/graph-mailbox-discovery.adapter';
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
      { id: undefined, mail: 'no-id@contoso.com', displayName: 'No ID' },
      { id: 'u3', mail: undefined, displayName: 'No Mail' },
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
