import 'reflect-metadata';
import { describe, it, expect, vi, type Mock } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  StorageTarget,
  StorageUsage,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  get_storage_usage_token,
  StorageUsageService,
} from '@/services/stats/storage-usage.service';
import {
  fake_inventory,
  MIXED_BUCKET,
  type FakeBucket,
  type FakeInventory,
} from './storage-usage.fixtures';

const TENANT = '00000000-0000-0000-0000-000000000000';

interface Harness {
  readonly service: StorageUsageService;
  readonly inventory: FakeInventory;
  readonly create_readonly: Mock;
}

function harness(bucket: FakeBucket = MIXED_BUCKET, readonly_fails = false): Harness {
  const inventory = fake_inventory(bucket);
  const ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const create_readonly = vi.fn(async () => {
    if (readonly_fails) throw new Error('No backups found');
    return ctx;
  });
  const service = new StorageUsageService(
    () => inventory,
    { create_readonly } as unknown as TenantContextFactory,
    {
      list_all_manifests: async () => [
        {
          owner_id: 'm1',
          created_at: new Date(),
          entries: [{ size_bytes: 100 }, { size_bytes: 50 }],
        },
      ],
    } as unknown as ManifestRepository,
    {
      list_all_manifests: async () => [{ total_size_bytes: 4000 }],
    } as unknown as OneDriveManifestRepository,
    { list_all_manifests: async () => [] } as unknown as SharePointManifestRepository,
  );
  return { service, inventory, create_readonly };
}

/** Everything except the timestamps, which differ between any two runs. */
function comparable(usage: StorageUsage): unknown {
  return { ...usage, started_at: undefined, measured_at: undefined };
}

describe('StorageUsageService', () => {
  it('reports exact categories, and the workload breakdown sums to the totals', async () => {
    const { service } = harness();

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.complete).toBe(true);
    expect(usage.continuation_token).toBeUndefined();
    expect(usage.totals).toEqual({
      current: { objects: 8, bytes: 300 + 1000 + 400 + 90 + 5000 + 2000 + 3000 + 11 },
      noncurrent: { objects: 2, bytes: 350 + 700 },
      delete_markers: 1,
      staging: { objects: 1, bytes: 2000 },
      incomplete_uploads: { objects: 1, bytes: 6000 },
    });
    expect(usage.stored_bytes).toBe(11801 + 1050 + 6000);
    expect(Object.keys(usage.by_workload)).toEqual([
      'outlook',
      'onedrive',
      'sharepoint',
      'meta',
      'other',
    ]);
    const workloads = Object.values(usage.by_workload);
    expect(workloads.reduce((sum, t) => sum + (t?.current.bytes ?? 0), 0)).toBe(
      usage.totals.current.bytes,
    );
    expect(workloads.reduce((sum, t) => sum + (t?.noncurrent.objects ?? 0), 0)).toBe(2);
    expect(usage.by_owner).toBeUndefined();
  });

  it('adds logical bytes from every manifest on a complete measurement', async () => {
    const { service } = harness();

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.logical_bytes_by_workload).toEqual({
      outlook: 150,
      onedrive: 4000,
      sharepoint: 0,
    });
    expect(usage.logical_bytes_referenced).toBe(4150);
  });

  it('still reports physical usage when the manifests cannot be read', async () => {
    const { service } = harness(MIXED_BUCKET, true);

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.complete).toBe(true);
    expect(usage.logical_bytes_referenced).toBeUndefined();
    expect(usage.totals.current.objects).toBe(8);
  });

  it('resumes one-request slices to exactly the one-shot result, never exceeding a slice', async () => {
    const one_shot = await harness().service.measure_storage_usage(TENANT, { breakdown: 'owner' });
    const { service, inventory } = harness();

    let usage: StorageUsage | undefined;
    let slices = 0;
    do {
      const before = inventory.requests();
      usage = await service.measure_storage_usage(TENANT, {
        breakdown: 'owner',
        max_list_requests: 1,
        continuation_token: usage?.continuation_token,
      });
      slices++;
      // Upload listing and part sizing included: every slice is held to its allowance.
      expect(inventory.requests() - before).toBe(1);
    } while (!usage.complete && slices < 50);

    expect(slices).toBeGreaterThan(5);
    expect(comparable(usage)).toEqual(comparable(one_shot));
  });

  it('sizes an upload across part pages and drops one that disappeared before sizing', async () => {
    const { service } = harness();

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.totals.incomplete_uploads).toEqual({ objects: 1, bytes: 6000 });
    expect(usage.incomplete_uploads_visible).toBe(true);
  });

  it('counts uploads but reports them not visible when their parts may not be listed', async () => {
    const { service } = harness({ ...MIXED_BUCKET, deny_parts: true });

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.complete).toBe(true);
    expect(usage.incomplete_uploads_visible).toBe(false);
    expect(usage.totals.incomplete_uploads).toEqual({ objects: 2, bytes: 0 });
    expect(usage.totals.current.objects).toBe(8);
  });

  it.each([1, 3, 7, 12])(
    'rethrows a failure on request %i with a token that resumes without double counting',
    async (failing_request) => {
      const one_shot = await harness().service.measure_storage_usage(TENANT, {
        breakdown: 'owner',
      });
      const { service, inventory } = harness();
      let token: string | undefined;
      let failures = 0;
      let usage: StorageUsage | undefined;
      // Fail exactly once, at the chosen request, then let the run continue from the token.
      const original = inventory.requests;
      const arm = (): void => {
        if (original() === failing_request - 1) inventory.fail_next();
      };
      while (!usage) {
        arm();
        try {
          usage = await service.measure_storage_usage(TENANT, {
            breakdown: 'owner',
            max_list_requests: 1,
            continuation_token: token,
          });
          if (!usage.complete) {
            token = usage.continuation_token;
            usage = undefined;
          }
        } catch (err) {
          failures++;
          expect(err).toMatchObject({ name: 'SlowDown' });
          token = get_storage_usage_token(err);
          expect(token).toEqual(expect.any(String));
          expect(Object.keys(err as object)).not.toContain('continuation_token');
        }
      }

      expect(failures).toBe(1);
      expect(usage.totals).toEqual(one_shot.totals);
      expect(usage.by_owner).toEqual(one_shot.by_owner);
    },
  );

  it('stops the other prefix listings once one fails, rather than listing on for a lost run', async () => {
    // One entry per page, so each prefix takes several requests and would keep a worker busy.
    const { service, inventory } = harness({ ...MIXED_BUCKET, page_size: 1 });
    // The root listing has seven entries, so seven requests finish discovery and queue prefixes.
    const discovered = await service.measure_storage_usage(TENANT, { max_list_requests: 7 });
    const before = inventory.requests();
    inventory.fail_next();

    // The service settles only after every worker has: the count afterwards is final.
    const failure = await service
      .measure_storage_usage(TENANT, { continuation_token: discovered.continuation_token })
      .catch((err: unknown) => err);

    expect(get_storage_usage_token(failure)).toEqual(expect.any(String));
    // The four workers start one page each; none starts another after the failure.
    expect(inventory.requests() - before).toBeLessThanOrEqual(4);
  });

  it('stops before any request when already aborted, and resumes from the token', async () => {
    const { service, inventory } = harness();

    const stopped = await service.measure_storage_usage(TENANT, {
      abort_signal: AbortSignal.abort(),
    });
    expect(stopped).toMatchObject({ complete: false, list_requests: 0 });
    expect(inventory.requests()).toBe(0);
    expect(stopped.logical_bytes_referenced).toBeUndefined();

    const resumed = await service.measure_storage_usage(TENANT, {
      continuation_token: stopped.continuation_token,
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.totals.current.objects).toBe(8);
  });

  it('falls back to live objects when versions are refused, and says so', async () => {
    const { service } = harness({ ...MIXED_BUCKET, deny_versions: true });

    const usage = await service.measure_storage_usage(TENANT);

    expect(usage.versions_visible).toBe(false);
    expect(usage.totals.noncurrent.objects).toBe(0);
    expect(usage.totals.delete_markers).toBe(0);
    expect(usage.totals.current.objects).toBe(8);
  });

  it('measures a replication target through its own inventory and reports its id', async () => {
    const inventory = fake_inventory({
      objects: [{ key: 'data/m1/a', size: 5, is_latest: true, is_delete_marker: false }],
    });
    const target = {
      target_id: 'offsite',
      open_inventory: vi.fn(() => inventory),
      create_context: vi.fn(async () => ({ destroy: vi.fn() })),
    } as unknown as StorageTarget;
    const { service } = harness();

    const usage = await service.measure_storage_usage(TENANT, { target });

    expect(usage.target).toBe('offsite');
    expect(usage.totals.current.bytes).toBe(5);
    expect(target.open_inventory).toHaveBeenCalledWith(TENANT);
  });

  it.each<[string, string, 'workload' | 'owner', RegExp]>([
    ['another tenant', '11111111-0000-0000-0000-000000000000', 'workload', /different tenant/],
    ['another breakdown', TENANT, 'owner', /different breakdown/],
  ])('refuses a token issued for %s', async (_label, tenant, breakdown, message) => {
    const { service } = harness();
    const { continuation_token } = await service.measure_storage_usage(TENANT, {
      max_list_requests: 1,
    });

    const resume = service.measure_storage_usage(tenant, { continuation_token, breakdown });

    await expect(resume).rejects.toThrow(message);
    await expect(resume).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ['garbage', 'not-a-token'],
    [
      'a tampered count',
      Buffer.from(
        JSON.stringify({
          version: 1,
          tenant_id: TENANT,
          target_id: 'primary',
          breakdown: 'workload',
          requests: -1,
        }),
      ).toString('base64url'),
    ],
  ])('refuses %s as a token', async (_label, token) => {
    const { service } = harness();

    await expect(
      service.measure_storage_usage(TENANT, { continuation_token: token }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    [{ breakdown: 'site' as never }, /breakdown/],
    [{ max_list_requests: 0 }, /maxListRequests/],
    [{ max_list_requests: 1.5 }, /maxListRequests/],
    [{ continuation_token: '' }, /continuationToken/],
  ])('rejects invalid options %o', async (request, message) => {
    const { service, inventory } = harness();

    await expect(service.measure_storage_usage(TENANT, request)).rejects.toThrow(message);
    expect(inventory.requests()).toBe(0);
  });
});
