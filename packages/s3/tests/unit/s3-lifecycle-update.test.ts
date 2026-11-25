/**
 * Issue #918: existing buckets receive the state-key rules through `storage-check
 * --apply-lifecycle`. The S3 put replaces the whole configuration, so every rule already on the
 * bucket must survive it, and a backend that drops a rule's prefix must not be left with a one-day
 * window over the whole bucket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteBucketLifecycleCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { add_missing_atlas_rules } from '@/adapters/s3-lifecycle-update';
import {
  ATLAS_LIFECYCLE_RULES,
  BASE_LIFECYCLE_RULES,
  STATE_KEY_PREFIXES,
} from '@/adapters/s3-lifecycle-rules';
import { fake_lifecycle_s3, s3_named_error } from './fake-lifecycle-s3';

const BUCKET = 'atlas-tenant-example';
const STATE_RULE_IDS = STATE_KEY_PREFIXES.map(({ rule_id }) => rule_id);

const operator_rule: LifecycleRule = {
  ID: 'tenant-exports',
  Status: 'Enabled',
  Filter: { Prefix: 'exports/' },
  Expiration: { Days: 90 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adding the Atlas lifecycle rules to an existing bucket', () => {
  it('adds every Atlas rule to a bucket that has none', async () => {
    const s3 = fake_lifecycle_s3();

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'applied',
      added_rule_ids: ATLAS_LIFECYCLE_RULES.map((rule) => rule.ID),
      replaced_rule_ids: [],
    });
    expect(s3.stored()).toEqual(ATLAS_LIFECYCLE_RULES);
  });

  it('adds the state rules to a bucket an earlier release created and keeps operator rules', async () => {
    const s3 = fake_lifecycle_s3({
      rules: [operator_rule, ...BASE_LIFECYCLE_RULES],
      transition_default_minimum_object_size: 'varies_by_storage_class',
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'applied',
      added_rule_ids: STATE_RULE_IDS,
      replaced_rule_ids: [],
    });
    expect(s3.stored()).toEqual([operator_rule, ...ATLAS_LIFECYCLE_RULES]);
    expect(s3.stored_transition_size()).toBe('varies_by_storage_class');
  });

  it('writes nothing when every Atlas rule is already there', async () => {
    const s3 = fake_lifecycle_s3({ rules: [...ATLAS_LIFECYCLE_RULES] });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({ status: 'unchanged' });
    expect(s3.count(PutBucketLifecycleConfigurationCommand)).toBe(0);
  });

  it('writes nothing when the current configuration cannot be read', async () => {
    const s3 = fake_lifecycle_s3({
      rules: [operator_rule],
      refuse_get: { error: s3_named_error('AccessDenied'), from_call: 1 },
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'failed',
      detail: 'access denied (requires s3:GetLifecycleConfiguration)',
    });
    expect(s3.count(PutBucketLifecycleConfigurationCommand)).toBe(0);
    expect(s3.stored()).toEqual([operator_rule]);
  });

  it('reports a refused put and leaves the configuration as it was', async () => {
    const s3 = fake_lifecycle_s3({
      rules: [operator_rule],
      refuse_put: () => s3_named_error('AccessDenied'),
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'failed',
      detail: 'access denied (requires s3:PutLifecycleConfiguration)',
    });
    expect(s3.stored()).toEqual([operator_rule]);
  });

  it('restores the previous rules when the backend dropped the prefixes it was sent', async () => {
    const s3 = fake_lifecycle_s3({ rules: [operator_rule], drop_filters: true });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update.status).toBe('failed');
    expect(update).toHaveProperty(
      'detail',
      expect.stringMatching(/without its prefix; the previous rules were restored$/),
    );
    // The restore went through the same filter-dropping backend; the operator's rule is back.
    expect(s3.stored()?.map((rule) => rule.ID)).toEqual(['tenant-exports']);
  });

  it('removes the configuration again when the bucket had none before', async () => {
    const s3 = fake_lifecycle_s3({ drop_filters: true });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update.status).toBe('failed');
    expect(s3.count(DeleteBucketLifecycleCommand)).toBe(1);
    expect(s3.stored()).toBeUndefined();
  });

  it('restores the previous rules when the read-back that confirms the prefixes fails', async () => {
    const s3 = fake_lifecycle_s3({
      rules: [operator_rule],
      refuse_get: { error: s3_named_error('InternalError'), from_call: 2 },
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'failed',
      detail:
        'could not read the rules back to confirm their prefixes (could not read the bucket ' +
        'lifecycle configuration); the previous rules were restored',
    });
    expect(s3.stored()).toEqual([operator_rule]);
  });
});

describe('resetting broken state-key rules on an existing bucket (trace review on #934)', () => {
  const teams_rule = ATLAS_LIFECYCLE_RULES.find((rule) => rule.ID === 'atlas-state-versions-teams');

  it.each([
    { name: 'disabled', broken: { ...teams_rule, Status: 'Disabled' } },
    { name: 'stored without its prefix', broken: { ...teams_rule, Filter: {} } },
    { name: 'filtering on another prefix', broken: { ...teams_rule, Filter: { Prefix: '' } } },
    {
      name: 'without its expiry',
      broken: { ...teams_rule, NoncurrentVersionExpiration: undefined },
    },
  ])('resets a state rule that is $name, in place', async ({ broken }) => {
    const rules = ATLAS_LIFECYCLE_RULES.map((rule) => (rule === teams_rule ? broken : rule));
    const s3 = fake_lifecycle_s3({ rules: [operator_rule, ...rules] as LifecycleRule[] });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({
      status: 'applied',
      added_rule_ids: [],
      replaced_rule_ids: ['atlas-state-versions-teams'],
    });
    expect(s3.stored()).toEqual([operator_rule, ...ATLAS_LIFECYCLE_RULES]);
  });

  it('keeps a state rule an operator edited to a window that still works', async () => {
    const rules = ATLAS_LIFECYCLE_RULES.map((rule) =>
      rule === teams_rule ? { ...rule, NoncurrentVersionExpiration: { NoncurrentDays: 3 } } : rule,
    );
    const s3 = fake_lifecycle_s3({ rules });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({ status: 'unchanged' });
    expect(s3.count(PutBucketLifecycleConfigurationCommand)).toBe(0);
  });

  it('never resets a base rule an operator disabled', async () => {
    const disabled_noncurrent = { ...BASE_LIFECYCLE_RULES[1], Status: 'Disabled' as const };
    const s3 = fake_lifecycle_s3({
      rules: [BASE_LIFECYCLE_RULES[0], disabled_noncurrent, ...ATLAS_LIFECYCLE_RULES.slice(2)],
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({ status: 'unchanged' });
    expect(s3.count(PutBucketLifecycleConfigurationCommand)).toBe(0);
  });
});
