/**
 * Issue #918: a one-day noncurrent window under the keys Atlas rewrites every run or every few
 * minutes, and 30 days everywhere else. A prefix that is one character too wide could expire the
 * old versions of `_meta/dek.enc`, the recovery path after a key re-wrap.
 */
import { describe, expect, it } from 'vitest';
import type { LifecycleRule } from '@aws-sdk/client-s3';
import {
  owner_lease_key,
  TENANT_LEASE_KEY,
} from '@wisecom/atlas-core/services/lease/owner-lease-key';
import { latest_pointer_key, snapshot_pointer_key } from '@/adapters/outlook-manifest-pointers';
import { outlook_summary_key } from '@/adapters/outlook-snapshot-summary-layout';
import {
  ATLAS_LIFECYCLE_RULES,
  BASE_LIFECYCLE_RULES,
  find_misscoped_state_rules,
  merge_atlas_rules,
  STATE_KEY_PREFIXES,
} from '@/adapters/s3-lifecycle-rules';

/** True when some enabled Atlas rule with a one-day window matches the key by prefix. */
function has_one_day_window(key: string): boolean {
  return ATLAS_LIFECYCLE_RULES.some(
    (rule) =>
      rule.NoncurrentVersionExpiration?.NoncurrentDays === 1 &&
      key.startsWith(rule.Filter?.Prefix ?? ''),
  );
}

describe('Atlas lifecycle rules (issue #918)', () => {
  it('scopes the one-day window to exactly these prefixes', () => {
    expect(STATE_KEY_PREFIXES.map(({ prefix }) => prefix)).toEqual([
      '_meta/outlook-leases/',
      '_meta/outlook-cursors/',
      '_meta/outlook-manifests/owners/',
      '_meta/tenant-lease.json',
      'onedrive/_meta/',
      'sharepoint/_meta/',
      'contacts/_meta/',
      'calendar/_meta/',
      'teams/_meta/',
    ]);
  });

  it('keeps the two base rules and adds one enabled one-day rule per prefix', () => {
    expect(BASE_LIFECYCLE_RULES).toEqual([
      {
        ID: 'atlas-housekeeping',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        Expiration: { ExpiredObjectDeleteMarker: true },
      },
      {
        ID: 'atlas-expire-noncurrent-versions',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      },
    ]);
    expect(ATLAS_LIFECYCLE_RULES.slice(2)).toEqual(
      STATE_KEY_PREFIXES.map(({ rule_id, prefix }) => ({
        ID: rule_id,
        Status: 'Enabled',
        Filter: { Prefix: prefix },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      })),
    );
    const ids = ATLAS_LIFECYCLE_RULES.map((rule) => rule.ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['Outlook owner lease', owner_lease_key('outlook', 'owner-1')],
    ['OneDrive owner lease', owner_lease_key('onedrive', 'owner-1')],
    ['SharePoint owner lease', owner_lease_key('sharepoint', 'site-1')],
    ['Teams owner lease', owner_lease_key('teams', 'team-1')],
    ['Contacts owner lease', owner_lease_key('contacts', 'owner-1')],
    ['Calendar owner lease', owner_lease_key('calendar', 'owner-1')],
    ['tenant lease', TENANT_LEASE_KEY],
    ['Outlook delta cursor', '_meta/outlook-cursors/owner-1.json'],
    ['Outlook latest pointer', latest_pointer_key('owner-1')],
    ['Outlook snapshot summary', outlook_summary_key('owner-1')],
    ['OneDrive delta cursor', 'onedrive/_meta/owner-1/delta.json'],
    ['SharePoint snapshot summary', 'sharepoint/_meta/site-1/snapshots.json'],
    ['Contacts delta cursor', 'contacts/_meta/owner-1/delta.json'],
    ['Calendar snapshot summary', 'calendar/_meta/owner-1/snapshots.json'],
    ['Teams channel cursor', 'teams/_meta/team-1/channels/channel-1.json'],
    ['Teams checkpoint head', 'teams/_meta/team-1/checkpoints/channel-1/head.json'],
  ])('gives the %s a one-day window', (_name, key) => {
    expect(has_one_day_window(key)).toBe(true);
  });

  it.each([
    ['wrapped data key', '_meta/dek.enc'],
    ['Outlook snapshot pointer', snapshot_pointer_key('snapshot-1')],
    ['identity registry', 'identity-registry.json'],
    ['Outlook message', 'data/owner-1/content-1'],
    ['Outlook manifest', 'manifests/owner-1/snapshot-1.json'],
    ['OneDrive file', 'onedrive/data/owner-1/content-1'],
    ['OneDrive manifest', 'onedrive/manifests/owner-1/snapshot-1.json'],
    ['OneDrive version index', 'onedrive/index/owner-1/runs/snapshot-1.json'],
    ['Teams channel shard', 'teams/shards/team-1/channel-1/content-1.json'],
    ['quarantined cursor', '_quarantine/_meta/outlook-cursors/owner-1.json'],
    ['Atlas 6 replication record', '_meta/replication/owner-1/snapshot-1/status.json'],
  ])('keeps the 30-day window for the %s', (_name, key) => {
    expect(has_one_day_window(key)).toBe(false);
  });
});

describe('merging Atlas rules into an existing configuration', () => {
  const operator_rule: LifecycleRule = {
    ID: 'tenant-exports',
    Status: 'Enabled',
    Filter: { Prefix: 'exports/' },
    Expiration: { Days: 90 },
  };

  it('adds every Atlas rule to a bucket without lifecycle rules', () => {
    const merged = merge_atlas_rules([]);

    expect(merged.rules).toEqual(ATLAS_LIFECYCLE_RULES);
    expect(merged.added_rule_ids).toEqual(ATLAS_LIFECYCLE_RULES.map((rule) => rule.ID));
  });

  it('keeps operator rules and edited or disabled Atlas rules as they are, in their order', () => {
    const edited_housekeeping: LifecycleRule = {
      ID: 'atlas-housekeeping',
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
    };
    const disabled_noncurrent: LifecycleRule = {
      ID: 'atlas-expire-noncurrent-versions',
      Status: 'Disabled',
      Filter: { Prefix: '' },
      NoncurrentVersionExpiration: { NoncurrentDays: 90 },
    };
    const existing = [operator_rule, edited_housekeeping, disabled_noncurrent];

    const merged = merge_atlas_rules(existing);

    expect(merged.rules.slice(0, 3)).toEqual(existing);
    expect(merged.rules.slice(3)).toEqual(ATLAS_LIFECYCLE_RULES.slice(2));
    expect(merged.added_rule_ids).toEqual(STATE_KEY_PREFIXES.map(({ rule_id }) => rule_id));
  });

  it('adds nothing when every Atlas rule ID is present', () => {
    const merged = merge_atlas_rules([operator_rule, ...ATLAS_LIFECYCLE_RULES]);

    expect(merged.added_rule_ids).toEqual([]);
    expect(merged.rules).toEqual([operator_rule, ...ATLAS_LIFECYCLE_RULES]);
  });
});

describe('finding state rules a backend stored without their prefix', () => {
  it('names a state rule whose filter was dropped or widened', () => {
    const stored = ATLAS_LIFECYCLE_RULES.map((rule) =>
      rule.ID === 'atlas-state-versions-teams' ? { ...rule, Filter: {} } : rule,
    );

    expect(find_misscoped_state_rules(stored)).toEqual(['atlas-state-versions-teams']);
  });

  it('reads the prefix of an And filter and of the legacy top-level field', () => {
    const stored: LifecycleRule[] = [
      {
        ID: 'atlas-state-versions-onedrive',
        Status: 'Enabled',
        Filter: { And: { Prefix: 'onedrive/_meta/', Tags: [{ Key: 'k', Value: 'v' }] } },
      },
      { ID: 'atlas-state-versions-teams', Status: 'Enabled', Prefix: 'teams/_meta/' },
    ];

    expect(find_misscoped_state_rules(stored)).toEqual([]);
  });

  it('ignores state rules the bucket does not have', () => {
    expect(find_misscoped_state_rules(BASE_LIFECYCLE_RULES)).toEqual([]);
  });
});
