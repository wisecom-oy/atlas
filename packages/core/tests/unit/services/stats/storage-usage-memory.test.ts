import 'reflect-metadata';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  StorageInventory,
  StorageListedObject,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { StorageUsageService } from '@/services/stats/storage-usage.service';

const PAGES_PER_PREFIX = 250;
const OBJECTS_PER_PAGE = 1000;
const PREFIXES = ['data/', 'attachments/', 'onedrive/', 'sharepoint/'];

/**
 * A bucket of a million objects that exists only one page at a time: each page is built on
 * request and dropped after, so anything still holding objects after the run was kept by the
 * measurement itself.
 */
function synthetic_inventory(): StorageInventory {
  return {
    async list_object_page({ prefix, delimiter, cursor }) {
      if (delimiter) {
        return { mode: 'versions', objects: [], common_prefixes: PREFIXES, requests: 1 };
      }
      const page = Number(cursor?.key_marker ?? 0);
      const objects: StorageListedObject[] = Array.from({ length: OBJECTS_PER_PAGE }, (_, i) => ({
        key: `${prefix}owner-${page % 50}/${'f'.repeat(64)}${page}-${i}`,
        size: 1000,
        is_latest: true,
        is_delete_marker: false,
      }));
      const next = page + 1 < PAGES_PER_PREFIX ? { key_marker: String(page + 1) } : undefined;
      return {
        mode: 'versions',
        objects,
        common_prefixes: [],
        requests: 1,
        ...(next ? { next } : {}),
      };
    },
    async list_incomplete_upload_page() {
      return { visible: true, uploads: [], requests: 1 };
    },
  };
}

/** Exposes V8's collector at runtime, so retained memory is measured rather than garbage. */
function collect_garbage(): void {
  setFlagsFromString('--expose_gc');
  (runInNewContext('gc') as () => void)();
}

describe('StorageUsageService memory', () => {
  it('keeps memory flat across a million listed objects', { timeout: 60_000 }, async () => {
    const service = new StorageUsageService(
      synthetic_inventory,
      {
        create_readonly: async () => Promise.reject(new Error('no key')),
      } as unknown as TenantContextFactory,
      {} as ManifestRepository,
      {} as OneDriveManifestRepository,
      {} as SharePointManifestRepository,
    );
    collect_garbage();
    const before = process.memoryUsage().heapUsed;

    const usage = await service.measure_storage_usage('tenant', { breakdown: 'owner' });

    collect_garbage();
    const retained = process.memoryUsage().heapUsed - before;
    expect(usage.totals.current.objects).toBe(
      PREFIXES.length * PAGES_PER_PREFIX * OBJECTS_PER_PAGE,
    );
    // A million retained keys is well over 100 MB; the counts and 200 owner rows are kilobytes.
    expect(retained).toBeLessThan(16 * 1024 * 1024);
  });
});
