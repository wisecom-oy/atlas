import { describe, expect, it } from 'vitest';
import type { ContactsSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { S3ContactsDeltaCursorRepository } from '@/adapters/s3-contacts-delta-cursor-repository.adapter';
import { S3ContactsManifestRepository } from '@/adapters/s3-contacts-manifest-repository.adapter';
import { put_content_if_absent } from '@/services/shared/content-objects';
import {
  contacts_data_key,
  contacts_delta_cursor_key,
  contacts_manifest_key,
  contacts_summary_key,
} from '@/services/shared/storage-keys';

/**
 * Issue #919: a run with `--retention-days` locked every cursor and summary index version it
 * wrote, which the noncurrent-version rule could then not expire. Backup data keeps the lock.
 */

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SNAPSHOT = 'ct-snap-1000-abc';
const RUN_POLICY = { mode: 'GOVERNANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

function retained_run() {
  const harness = in_memory_tenant_context();
  const recorder = record_lock_policies(harness.ctx.storage);
  const ctx: TenantContext = {
    ...harness.ctx,
    storage: new ObjectLockingStorage(recorder.storage, RUN_POLICY),
  };
  return { ctx, recorder };
}

describe('Contacts writes under a retained run', () => {
  it('locks content and the manifest, and leaves the cursor and summary unlocked', async () => {
    const { ctx, recorder } = retained_run();
    const content_key = contacts_data_key(MAILBOX, 'content-name');
    const manifest: ContactsSnapshotManifest = {
      id: 'id-1000',
      tenant_id: 'tenant-1',
      mailbox_id: MAILBOX,
      snapshot_id: SNAPSHOT,
      created_at: new Date(1000).toISOString(),
      total_contacts: 1,
      total_size_bytes: 7,
      folders: [{ folder_id: 'f1', display_name: 'Contacts', path: [] }],
      entries: [
        {
          contact_id: 'c-1',
          folder_id: 'f1',
          storage_key: content_key,
          checksum: 's',
          size_bytes: 7,
        },
      ],
    };

    await put_content_if_absent(ctx, content_key, Buffer.from('contact'));
    await new S3ContactsManifestRepository().save(ctx, manifest);
    await new S3ContactsDeltaCursorRepository().save(ctx, {
      mailbox_id: MAILBOX,
      delta_link_by_folder: {},
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    expect(recorder.locked_keys()).toEqual(
      [content_key, contacts_manifest_key(MAILBOX, SNAPSHOT)].sort(),
    );
    expect(recorder.unlocked_keys()).toEqual(
      [contacts_delta_cursor_key(MAILBOX), contacts_summary_key(MAILBOX)].sort(),
    );
  });
});
