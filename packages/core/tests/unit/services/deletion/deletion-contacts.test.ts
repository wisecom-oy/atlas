import { describe, expect, it, vi } from 'vitest';
import { DeletionService } from '@/services/deletion/deletion.service';
import type { ManifestRepository, ObjectStorage, TenantContextFactory } from '@wisecom/atlas-types';

describe('mailbox contact erasure', () => {
  it('removes contact and photo objects and the cursor without touching another mailbox', async () => {
    const keys = new Set([
      'contacts/data/john.doe@example.com/contact',
      'contacts/photos/john.doe@example.com/photo',
      '_meta/outlook-cursors/john.doe@example.com.json',
      'contacts/data/jane.roe@example.com/other',
    ]);
    const storage = {
      list: vi.fn(async (prefix: string) => [...keys].filter((key) => key.startsWith(prefix))),
      list_versions: vi.fn(async () => []),
      delete: vi.fn(async (key: string) => {
        keys.delete(key);
      }),
    } as unknown as ObjectStorage;
    const factory = {
      create_storage_only: vi.fn(async () => ({ tenant_id: 'tenant', storage })),
    } as unknown as TenantContextFactory;
    const service = new DeletionService(factory, {} as ManifestRepository);

    const result = await service.delete_mailbox_data('tenant', 'john.doe@example.com');

    expect(result.deleted_objects).toBe(3);
    expect(result.failed_objects).toBe(0);
    expect([...keys]).toEqual(['contacts/data/jane.roe@example.com/other']);
  });
});
