import 'reflect-metadata';

import type { ContactsManifestRepository, ContactsSnapshotSummary } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { describe, expect, it } from 'vitest';

import { ContactsCatalogService } from '@/services/catalog/catalog.service';

const MIXED_CASE_MAILBOX = '00000000-0000-0000-0000-00000000ABCD';
const LOWER_MAILBOX = '00000000-0000-0000-0000-00000000abcd';

const row: ContactsSnapshotSummary = {
  snapshot_id: 'ct-snap-1000-abc',
  created_at: new Date(1000),
  manifest_key: `contacts/manifests/${LOWER_MAILBOX}/ct-snap-1000-abc.json`,
  entry_count: 1,
  total_size_bytes: 10,
  mailbox_id: LOWER_MAILBOX,
  total_contacts: 1,
};

describe('ContactsCatalogService summary listing (#727)', () => {
  it('lists the summaries under the lowercased mailbox id', async () => {
    const looked_up: string[] = [];
    const { ctx } = stub_tenant_context();
    const manifests: ContactsManifestRepository = {
      ...memory_manifests(),
      list_snapshot_summaries: async (_ctx, mailbox) => {
        looked_up.push(mailbox);
        return { summaries: [row], unreadable_keys: [] };
      },
    };
    const catalog = new ContactsCatalogService(tenant_factory_for(ctx), manifests);

    const listed = await catalog.list_contacts_snapshot_summaries('tenant-1', MIXED_CASE_MAILBOX);

    expect(looked_up).toEqual([LOWER_MAILBOX]);
    expect(listed).toEqual([row]);
  });

  it('raises the rowless manifests it could not read, with the summaries as partial result', async () => {
    const { ctx } = stub_tenant_context();
    const damaged = `contacts/manifests/${LOWER_MAILBOX}/ct-snap-2000-abc.json`;
    const manifests: ContactsManifestRepository = {
      ...memory_manifests(),
      list_snapshot_summaries: async () => ({ summaries: [row], unreadable_keys: [damaged] }),
    };
    const catalog = new ContactsCatalogService(tenant_factory_for(ctx), manifests);

    const listing = catalog.list_contacts_snapshot_summaries('tenant-1', LOWER_MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(listing).rejects.toMatchObject({
      unreadable_keys: [damaged],
      partial_result: [row],
    });
  });
});
