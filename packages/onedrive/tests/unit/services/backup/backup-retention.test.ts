import { describe, it, expect, vi, type Mock } from 'vitest';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { OneDriveBackupService } from '@/services/backup/backup.service';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';

// OneDrive backups lock what they write with a per-object policy carried by the run's own
// context (#551). Bucket default retention was shared by every concurrent run on the tenant, so
// one run's setting replaced another's. The harness stops the run at the first cursor load, which
// receives the context every later write goes through.

const STOP = new Error('stop after the cursor load');

function make_harness(validate_error?: Error): {
  service: OneDriveBackupService;
  validate: Mock;
  put: Mock;
  destroy: Mock;
  run_ctx: () => TenantContext | undefined;
} {
  const validate = validate_error ? vi.fn().mockRejectedValue(validate_error) : vi.fn();
  const put = vi.fn();
  const destroy = vi.fn();
  const context = {
    tenant_id: 't',
    storage: { validate_object_lock_policy: validate, put },
    destroy,
  } as unknown as TenantContext;
  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };
  let seen: TenantContext | undefined;
  const cursors = {
    load: vi.fn(async (ctx: TenantContext) => {
      seen = ctx;
      throw STOP;
    }),
  };

  const service = new OneDriveBackupService(
    factory,
    {} as never,
    {} as never,
    {} as never,
    cursors as never,
  );
  return { service, validate, put, destroy, run_ctx: () => seen };
}

describe('OneDrive backup object lock (#29, #551)', () => {
  it('validates the policy before reading anything', async () => {
    const { service, validate } = make_harness();

    await expect(
      service.backup_onedrive('t', 'owner-1', {
        object_lock_request: { mode: 'COMPLIANCE', retention_days: 30 },
      }),
    ).rejects.toBe(STOP);

    expect(validate).toHaveBeenCalledTimes(1);
    const policy = validate.mock.calls[0]?.[0];
    expect(policy.mode).toBe('COMPLIANCE');
    const days = (Date.parse(policy.retain_until) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('runs on a context whose writes carry the policy', async () => {
    const { service, put, run_ctx } = make_harness();

    await expect(
      service.backup_onedrive('t', 'owner-1', { object_lock_request: { retention_days: 7 } }),
    ).rejects.toBe(STOP);

    const storage = run_ctx()?.storage;
    expect(storage).toBeInstanceOf(ObjectLockingStorage);
    await storage?.put('k', Buffer.from('x'));
    expect(put.mock.calls[0]?.[3]).toMatchObject({ mode: 'GOVERNANCE' });
  });

  it('runs on the tenant context unchanged without a lock request', async () => {
    const { service, validate, run_ctx } = make_harness();

    await expect(service.backup_onedrive('t', 'owner-1', {})).rejects.toBe(STOP);

    expect(validate).not.toHaveBeenCalled();
    expect(run_ctx()?.storage).not.toBeInstanceOf(ObjectLockingStorage);
  });

  it('destroys the context when the bucket cannot lock (issue #436)', async () => {
    const { service, destroy } = make_harness(new Error('bucket has no Object Lock'));

    await expect(
      service.backup_onedrive('t', 'owner-1', { object_lock_request: { retention_days: 30 } }),
    ).rejects.toThrow('bucket has no Object Lock');

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
