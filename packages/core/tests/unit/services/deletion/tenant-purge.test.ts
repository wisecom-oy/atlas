import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import type { DeletionService } from '@/services/deletion/deletion.service';
import { deletion_service_rig } from './deletion.service.fixtures';

describe('DeletionService.purge_tenant', () => {
  let mock_context: TenantContext;
  let mock_factory: TenantContextFactory;
  let service: DeletionService;

  beforeEach(() => {
    ({ service, mock_context, mock_factory } = deletion_service_rig());
  });

  it('sweeps every workload in the bucket, not a list of known prefixes', async () => {
    const list_fn = vi.mocked(mock_context.storage.list);
    list_fn
      .mockResolvedValueOnce([
        'manifests/u/snap-1.json',
        'data/u/aaa',
        'attachments/u/ccc',
        'onedrive/data/u/blob',
        'sharepoint/data/site/blob',
        'identity-registry.json',
      ])
      .mockResolvedValueOnce(['_meta/dek.enc']);

    const result = await service.purge_tenant('t');

    // Five workload objects from the sweep, plus the DEK from the second pass.
    expect(result.deleted_objects).toBe(6);
    expect(result.deleted_manifests).toBe(1);
    expect(mock_context.storage.delete).toHaveBeenCalledWith('onedrive/data/u/blob');
    expect(mock_context.storage.delete).toHaveBeenCalledWith('sharepoint/data/site/blob');
    expect(mock_context.storage.delete).toHaveBeenCalledWith('identity-registry.json');
  });

  it('holds the DEK back until the data it protects is gone', async () => {
    vi.mocked(mock_context.storage.list).mockResolvedValueOnce(['onedrive/data/u/locked']);
    vi.mocked(mock_context.storage.delete).mockRejectedValueOnce(
      new ObjectLockRetainedError('data/u/blob'),
    );

    const result = await service.purge_tenant('t');

    expect(result.retained_objects).toBe(1);
    expect(mock_context.storage.delete).not.toHaveBeenCalledWith('_meta/dek.enc');
    expect(mock_context.storage.list).not.toHaveBeenCalledWith('_meta/');
  });

  it('deletes the DEK last, once the sweep came back clean', async () => {
    await service.purge_tenant('t');

    const scopes = vi.mocked(mock_context.storage.list).mock.calls.map(([scope]) => scope);
    expect(scopes).toEqual(['', '_meta/dek.enc']);
  });

  it('erases the DEK-encrypted neighbours in _meta before the DEK itself', async () => {
    // Replica markers and replication records share _meta/ with the key that
    // decrypts them, and sort after it. Holding back the whole prefix would
    // let a retained record outlive its key.
    vi.mocked(mock_context.storage.list)
      .mockResolvedValueOnce([
        '_meta/dek.enc',
        '_meta/replica.marker',
        '_meta/replication/u/snap/target.json',
      ])
      .mockResolvedValueOnce(['_meta/dek.enc']);

    await service.purge_tenant('t');

    const order = vi.mocked(mock_context.storage.delete).mock.calls.map(([key]) => key);
    expect(order).toEqual([
      '_meta/replica.marker',
      '_meta/replication/u/snap/target.json',
      '_meta/dek.enc',
    ]);
  });

  it('leaves the DEK out of the bucket-wide sweep', async () => {
    vi.mocked(mock_context.storage.list)
      .mockResolvedValueOnce(['data/u/aaa', '_meta/dek.enc'])
      .mockResolvedValueOnce(['_meta/dek.enc']);

    const result = await service.purge_tenant('t');

    // One from the sweep, one from the DEK pass -- never twice from the sweep.
    expect(result.deleted_objects).toBe(2);
    expect(mock_context.storage.delete).toHaveBeenCalledTimes(2);
  });

  it('handles empty tenant bucket', async () => {
    const result = await service.purge_tenant('t');

    expect(result.deleted_objects).toBe(0);
    expect(result.deleted_manifests).toBe(0);
    expect(result.retained_objects).toBe(0);
    expect(result.retained_manifests).toBe(0);
  });

  it('uses create_storage_only instead of create', async () => {
    await service.purge_tenant('t');

    expect(mock_factory.create_storage_only).toHaveBeenCalledWith('t');
    expect(mock_factory.create).not.toHaveBeenCalled();
  });
});
