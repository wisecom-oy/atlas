import 'reflect-metadata';

import type { CalendarManifestRepository, CalendarSnapshotManifest } from '@wisecom/atlas-types';
import { memory_calendar_manifests } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { describe, expect, it } from 'vitest';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

import { CalendarCatalogService } from '@/services/catalog/catalog.service';

const MIXED_CASE_MAILBOX = '00000000-0000-0000-0000-00000000ABCD';
const LOWER_MAILBOX = '00000000-0000-0000-0000-00000000abcd';

/** Catalog service whose manifest listing is replaced by `list`. */
function catalog_over(
  list: (mailbox: string) => Promise<CalendarSnapshotManifest[]>,
): CalendarCatalogService {
  const { ctx } = stub_tenant_context();
  const manifests: CalendarManifestRepository = {
    ...memory_calendar_manifests(),
    list_readable_snapshots_by_mailbox: async (_ctx, mailbox) =>
      readable_manifests(await list(mailbox)),
  };
  return new CalendarCatalogService(tenant_factory_for(ctx), manifests);
}

describe('CalendarCatalogService', () => {
  it('lists snapshots under the lowercased mailbox id', async () => {
    const looked_up: string[] = [];
    const catalog = catalog_over(async (mailbox) => {
      looked_up.push(mailbox);
      return [];
    });

    await catalog.list_calendar_snapshots('tenant-1', MIXED_CASE_MAILBOX);

    expect(looked_up).toEqual([LOWER_MAILBOX]);
  });

  it('surfaces a manifest repository failure instead of returning an empty catalog', async () => {
    const catalog = catalog_over(async () => {
      throw new Error('manifest store unavailable');
    });

    await expect(catalog.list_calendar_snapshots('tenant-1', LOWER_MAILBOX)).rejects.toThrow(
      'manifest store unavailable',
    );
  });
});
