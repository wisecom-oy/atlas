/**
 * Issue #918: a bucket Atlas creates gets the state-key rules, and a backend that refuses them or
 * drops their prefixes gets the two base rules instead, never a one-day window over everything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core';
import { apply_default_lifecycle } from '@/adapters/s3-bucket-lifecycle';
import { ATLAS_LIFECYCLE_RULES, BASE_LIFECYCLE_RULES } from '@/adapters/s3-lifecycle-rules';
import { fake_lifecycle_s3, s3_named_error } from './fake-lifecycle-s3';

const BUCKET = 'atlas-tenant-example';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lifecycle rules on a new bucket', () => {
  it('requests the base rules and the state-key rules', async () => {
    const s3 = fake_lifecycle_s3();

    await apply_default_lifecycle(s3.client as never, BUCKET);

    expect(s3.stored()).toEqual(ATLAS_LIFECYCLE_RULES);
  });

  it('falls back to the base rules when the backend refuses the full set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s3 = fake_lifecycle_s3({
      refuse_put: (rules) => (rules.length > 2 ? s3_named_error('MalformedXML') : undefined),
    });

    await apply_default_lifecycle(s3.client as never, BUCKET);

    expect(s3.stored()).toEqual(BASE_LIFECYCLE_RULES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MalformedXML'));
  });

  it('falls back to the base rules when the backend dropped the state-key prefixes', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s3 = fake_lifecycle_s3({ drop_filters: true });

    await apply_default_lifecycle(s3.client as never, BUCKET);

    expect(s3.stored()?.map((rule) => rule.ID)).toEqual(BASE_LIFECYCLE_RULES.map((r) => r.ID));
    expect(
      s3.stored()?.some((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays === 1),
    ).toBe(false);
  });

  it('tries once and warns when the credentials may not configure lifecycle', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s3 = fake_lifecycle_s3({ refuse_put: () => s3_named_error('AccessDenied') });

    await expect(apply_default_lifecycle(s3.client as never, BUCKET)).resolves.toBeUndefined();

    expect(s3.count(PutBucketLifecycleConfigurationCommand)).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('best-effort'));
  });
});
