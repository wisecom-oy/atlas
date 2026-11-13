import 'reflect-metadata';

import type {
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  CalendarSnapshotSummary,
} from '@wisecom/atlas-types';
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

describe('CalendarCatalogService summary listing (#727)', () => {
  const row: CalendarSnapshotSummary = {
    snapshot_id: 'cal-snap-1000-abc',
    created_at: new Date(1000),
    manifest_key: `calendar/manifests/${LOWER_MAILBOX}/cal-snap-1000-abc.json`,
    entry_count: 1,
    total_size_bytes: 10,
    mailbox_id: LOWER_MAILBOX,
    total_events: 1,
  };

  it('lists the summaries under the lowercased mailbox id', async () => {
    const looked_up: string[] = [];
    const { ctx } = stub_tenant_context();
    const manifests: CalendarManifestRepository = {
      ...memory_calendar_manifests(),
      list_snapshot_summaries: async (_ctx, mailbox) => {
        looked_up.push(mailbox);
        return { summaries: [row], unreadable_keys: [] };
      },
    };
    const catalog = new CalendarCatalogService(tenant_factory_for(ctx), manifests);

    const listed = await catalog.list_calendar_snapshot_summaries('tenant-1', MIXED_CASE_MAILBOX);

    expect(looked_up).toEqual([LOWER_MAILBOX]);
    expect(listed).toEqual([row]);
  });

  it('raises the rowless manifests it could not read, with the summaries as partial result', async () => {
    const { ctx } = stub_tenant_context();
    const damaged = `calendar/manifests/${LOWER_MAILBOX}/cal-snap-2000-abc.json`;
    const manifests: CalendarManifestRepository = {
      ...memory_calendar_manifests(),
      list_snapshot_summaries: async () => ({ summaries: [row], unreadable_keys: [damaged] }),
    };
    const catalog = new CalendarCatalogService(tenant_factory_for(ctx), manifests);

    await expect(
      catalog.list_calendar_snapshot_summaries('tenant-1', LOWER_MAILBOX),
    ).rejects.toMatchObject({ unreadable_keys: [damaged], partial_result: [row] });
  });
});
