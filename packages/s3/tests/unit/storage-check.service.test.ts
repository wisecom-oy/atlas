import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { StorageCheckService } from '@/services/storage-check.service';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { probe_conditional_writes } from '@/adapters/s3-conditional-write-probe';
import { ConfiguredBucketNameResolver } from '@/adapters/configured-bucket-name-resolver';
import { BUCKET_NAME_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_LIFECYCLE_RULES, STATE_KEY_PREFIXES } from '@/adapters/s3-lifecycle-rules';
import { fake_lifecycle_s3 } from './fake-lifecycle-s3';

// The probe writes objects and has its own tests; here it would only shift the request counts.
vi.mock('@/adapters/s3-conditional-write-probe', () => ({
  probe_conditional_writes: vi.fn(async () => ({ support: 'supported' })),
}));

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

/** The one-day state-key rules a bucket created before issue #918 lacks. */
const STATE_RULES_MISSING = STATE_KEY_PREFIXES.map(({ rule_id }) => ({
  rule_id,
  action: 'NoncurrentVersionExpiration',
}));

/** A service over the given S3 client. */
function service_over(client: unknown): StorageCheckService {
  const container = new Container();
  container.bind(S3_CLIENT_TOKEN).toConstantValue(client);
  container.bind(BucketCache).toConstantValue(new BucketCache());
  container
    .bind(BUCKET_NAME_RESOLVER_TOKEN)
    .toConstantValue(new ConfiguredBucketNameResolver(undefined));
  container.bind(StorageCheckService).toSelf();
  return container.get(StorageCheckService);
}

describe('StorageCheckService', () => {
  let buckets: BucketCache;
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let service: StorageCheckService;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    mock_s3.send.mockResolvedValue({});
    buckets = new BucketCache();
    const container = new Container();
    container.bind(S3_CLIENT_TOKEN).toConstantValue(mock_s3);
    container.bind(BucketCache).toConstantValue(buckets);
    container
      .bind(BUCKET_NAME_RESOLVER_TOKEN)
      .toConstantValue(new ConfiguredBucketNameResolver(undefined));
    container.bind(StorageCheckService).toSelf();
    service = container.get(StorageCheckService);
  });

  it('returns readiness details for Object Lock backup', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    const result = await service.check_storage('tenant-1', {
      mode: 'GOVERNANCE',
      retention_days: 30,
    });

    expect(result.bucket).toBe('atlas-tenant-1');
    expect(result.reachable).toBe(true);
    expect(result.versioning_enabled).toBe(true);
    expect(result.object_lock_enabled).toBe(true);
    expect(result.requested_mode).toBe('GOVERNANCE');
    expect(result.requested_retention_days).toBe(30);
    expect(result.resolved_retain_until).toBeDefined();
    expect(result.default_retention).toBeUndefined();
  });

  it('reports a bucket default retention on a lock-capable bucket', async () => {
    const lock_configuration = {
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
      },
    };
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce(lock_configuration)
      .mockResolvedValueOnce(lock_configuration);

    const result = await service.check_storage('tenant-1');

    expect(result.default_retention).toEqual({ mode: 'GOVERNANCE', days: 30 });
  });

  it('does not read a default retention when Object Lock is disabled', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockRejectedValueOnce(new Error('ObjectLockConfigurationNotFoundError'));

    const result = await service.check_storage('tenant-1');

    expect(result.default_retention).toBeUndefined();
    expect(mock_s3.send).toHaveBeenCalledTimes(4);
    expect(mock_s3.send.mock.lastCall?.[0]).toBeInstanceOf(GetBucketLifecycleConfigurationCommand);
  });

  it('names the Atlas action missing from the MinIO lifecycle response', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Rules: [
          {
            ID: 'atlas-housekeeping',
            Status: 'Enabled',
            Expiration: { ExpiredObjectDeleteMarker: true },
          },
          {
            ID: 'atlas-expire-noncurrent-versions',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          },
        ],
      });

    const result = await service.check_storage('tenant-1');

    expect(result.lifecycle).toEqual({
      status: 'checked',
      missing_actions: [
        { rule_id: 'atlas-housekeeping', action: 'AbortIncompleteMultipartUpload' },
        ...STATE_RULES_MISSING,
      ],
    });
    expect(mock_s3.send.mock.lastCall?.[0]).toBeInstanceOf(GetBucketLifecycleConfigurationCommand);
    expect(mock_s3.send.mock.lastCall?.[0]).toHaveProperty('input.Bucket', 'atlas-tenant-1');
  });

  it.each([
    {
      name: 'retains all actions',
      rules: [
        {
          ID: 'atlas-expire-noncurrent-versions',
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 45 },
        },
        {
          ID: 'atlas-housekeeping',
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
      ],
      missing_actions: STATE_RULES_MISSING,
    },
    {
      name: 'retains every Atlas rule, including the state-key rules',
      rules: [...ATLAS_LIFECYCLE_RULES],
      missing_actions: [],
    },
    {
      name: 'stored a state-key rule without its prefix',
      rules: ATLAS_LIFECYCLE_RULES.map((rule) =>
        rule.ID === 'atlas-state-versions-teams' ? { ...rule, Filter: {} } : rule,
      ),
      missing_actions: [{ rule_id: 'atlas-state-versions-teams', action: 'Prefix' }],
    },
    {
      name: 'retains only the abort action and an unrelated expiry rule',
      rules: [
        {
          ID: 'atlas-housekeeping',
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          Expiration: { Days: 10 },
        },
        {
          ID: 'custom-expiry',
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
      missing_actions: [
        { rule_id: 'atlas-housekeeping', action: 'ExpiredObjectDeleteMarker' },
        { rule_id: 'atlas-expire-noncurrent-versions', action: 'NoncurrentVersionExpiration' },
        ...STATE_RULES_MISSING,
      ],
    },
  ])('reports the Atlas actions when the backend $name', async ({ rules, missing_actions }) => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Rules: rules });

    const result = await service.check_storage('tenant-1');

    expect(result.lifecycle).toEqual({ status: 'checked', missing_actions });
  });

  it('reports all Atlas actions missing when the bucket has no lifecycle configuration', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'NoSuchLifecycleConfiguration' }));

    const result = await service.check_storage('tenant-1');

    expect(result.lifecycle).toEqual({
      status: 'checked',
      missing_actions: [
        { rule_id: 'atlas-housekeeping', action: 'AbortIncompleteMultipartUpload' },
        { rule_id: 'atlas-housekeeping', action: 'ExpiredObjectDeleteMarker' },
        { rule_id: 'atlas-expire-noncurrent-versions', action: 'NoncurrentVersionExpiration' },
        ...STATE_RULES_MISSING,
      ],
    });
    expect(result.lifecycle_update).toBeUndefined();
  });

  it('adds the missing rules before checking when asked to apply them (issue #918)', async () => {
    const s3 = fake_lifecycle_s3();

    const result = await service_over(s3.client).check_storage('tenant-1', {
      apply_lifecycle: true,
    });

    expect(result.lifecycle_update).toEqual({
      status: 'applied',
      added_rule_ids: ATLAS_LIFECYCLE_RULES.map((rule) => rule.ID),
    });
    expect(result.lifecycle).toEqual({ status: 'checked', missing_actions: [] });
    expect(s3.stored()).toEqual(ATLAS_LIFECYCLE_RULES);
  });

  it('reports a lifecycle read permission failure without preventing the other checks', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'AccessDenied' }));

    const result = await service.check_storage('tenant-1');

    expect(result.lifecycle).toEqual({
      status: 'not_checked',
      detail: 'access denied (requires s3:GetLifecycleConfiguration)',
    });
    expect(result.conditional_writes).toEqual({ support: 'supported' });
  });

  it('reports what the conditional-write probe found on the tenant bucket (issue #623)', async () => {
    mock_s3.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: 'Enabled' })
      .mockRejectedValueOnce(new Error('ObjectLockConfigurationNotFoundError'));
    const ignored = { support: 'ignored', detail: 'the backend accepted a write' } as const;
    vi.mocked(probe_conditional_writes).mockResolvedValueOnce(ignored);

    const result = await service.check_storage('tenant-1');

    expect(result.conditional_writes).toEqual(ignored);
  });
});
