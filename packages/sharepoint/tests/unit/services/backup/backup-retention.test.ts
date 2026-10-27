import { describe, it, expect, vi, type Mock } from 'vitest';
import { SharePointBackupService } from '@/services/backup/backup.service';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';

// Issue #29: SharePoint backups must honour object lock via bucket default
// retention. The service applies it before scanning; list_document_libraries
// returning [] aborts the run right after, keeping the harness minimal.

function make_harness(retention_error?: Error): {
  service: SharePointBackupService;
  apply_default_retention: Mock;
  destroy: Mock;
} {
  const apply_default_retention = retention_error
    ? vi.fn().mockRejectedValue(retention_error)
    : vi.fn();
  const destroy = vi.fn();
  const context = {
    tenant_id: 't',
    storage: { apply_default_retention },
    destroy,
  } as unknown as TenantContext;
  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };
  const connector = { list_document_libraries: vi.fn().mockResolvedValue([]) };

  const service = new SharePointBackupService(
    factory,
    connector as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, apply_default_retention, destroy };
}

describe('SharePoint backup object lock (issue #29)', () => {
  it('applies bucket default retention before scanning', async () => {
    const { service, apply_default_retention } = make_harness();

    await service
      .backup_site('t', 'site-1', {
        object_lock_request: { mode: 'COMPLIANCE', retention_days: 90 },
      })
      .catch(() => undefined); // no libraries -> run aborts after retention is applied

    expect(apply_default_retention).toHaveBeenCalledWith('COMPLIANCE', 90);
  });

  it('leaves the bucket untouched without a lock request', async () => {
    const { service, apply_default_retention } = make_harness();

    await service.backup_site('t', 'site-1', {}).catch(() => undefined);

    expect(apply_default_retention).not.toHaveBeenCalled();
  });

  it('destroys the context when applying default retention fails (issue #436)', async () => {
    const { service, destroy } = make_harness(new Error('bucket has no Object Lock'));

    await expect(
      service.backup_site('t', 'site-1', { object_lock_request: { retention_days: 90 } }),
    ).rejects.toThrow('bucket has no Object Lock');

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
