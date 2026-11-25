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
import { logger } from '@wisecom/atlas-core';
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
    });
    expect(s3.stored()).toEqual(ATLAS_LIFECYCLE_RULES);
  });

  it('adds the state rules to a bucket an earlier release created and keeps operator rules', async () => {
    const s3 = fake_lifecycle_s3({
      rules: [operator_rule, ...BASE_LIFECYCLE_RULES],
      transition_default_minimum_object_size: 'varies_by_storage_class',
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update).toEqual({ status: 'applied', added_rule_ids: STATE_RULE_IDS });
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

  it('counts the rules as applied when only the read-back fails, and warns', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s3 = fake_lifecycle_s3({
      refuse_get: { error: s3_named_error('NotImplemented'), from_call: 2 },
    });

    const update = await add_missing_atlas_rules(s3.client as never, BUCKET);

    expect(update.status).toBe('applied');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read them back'));
  });
});
