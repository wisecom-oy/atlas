import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { OutlookQuarantineService } from '@/services/quarantine/quarantine.service';

const KEY = 'manifests/00000000-0000-0000-0000-00000000abcd/snap-1.json';

function rig(read_manifest_at: ManifestRepository['read_manifest_at']) {
  const harness = in_memory_tenant_context();
  harness.set_raw(KEY, Buffer.from('damaged'));
  const factory = { create: async () => harness.ctx } as unknown as TenantContextFactory;
  const manifests = { read_manifest_at } as unknown as ManifestRepository;
  return { harness, service: new OutlookQuarantineService(factory, manifests) };
}

describe('OutlookQuarantineService (issue #631)', () => {
  it('moves a manifest its repository cannot read', async () => {
    const { harness, service } = rig(async () => {
      throw new UnreadableObjectsError('The Outlook manifest does not decrypt or parse', [KEY]);
    });

    const result = await service.quarantine_unreadable_object('tenant-1', KEY);

    expect(result.quarantine_key).toBe(`_quarantine/${KEY}`);
    expect(harness.raw(KEY)).toBeUndefined();
  });

  it('refuses a key outside the Outlook manifest layout without reading it', async () => {
    const read = vi.fn();
    const { service } = rig(read);

    await expect(
      service.quarantine_unreadable_object(
        'tenant-1',
        '_meta/outlook-manifests/owners/x/latest.json',
      ),
    ).rejects.toThrow(/Only Outlook manifests can be quarantined/);
    expect(read).not.toHaveBeenCalled();
  });
});
