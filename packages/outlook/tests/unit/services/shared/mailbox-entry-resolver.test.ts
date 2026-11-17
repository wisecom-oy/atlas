import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxConnector,
  MailFolder,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { resolve_mailbox_entries } from '@/services/shared/mailbox-entry-resolver';

function entry(object_id: string, folder_id: string): ManifestEntry {
  return { object_id, storage_key: `data/${object_id}`, checksum: 'c', size_bytes: 1, folder_id };
}

function manifest(day: number, entries: ManifestEntry[], folders?: MailFolder[]): Manifest {
  return {
    id: `snap-${day}`,
    tenant_id: 't',
    owner_id: 'john.doe@example.com',
    snapshot_id: `snap-${day}`,
    created_at: new Date(Date.UTC(2026, 0, day)),
    total_objects: entries.length,
    total_size_bytes: entries.length,
    delta_links: {},
    entries,
    ...(folders ? { folders } : {}),
  };
}

const GONE: MailFolder = {
  folder_id: 'f-gone',
  display_name: 'Example Folder',
  folder_path: 'Example Folder',
  total_item_count: 1,
};
const DAY_1 = manifest(1, [entry('A', 'f1'), entry('G', 'f-gone')], [GONE]);
const DAY_2 = manifest(2, [entry('B', 'f1')]);

async function resolve(filter = {}) {
  const repo = {
    list_by_owner: vi.fn(async () => [DAY_1, DAY_2]),
  } as unknown as ManifestRepository;
  const connector = {
    list_mail_folders: vi.fn(async () => [
      { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' },
    ]),
  } as unknown as MailboxConnector;
  return resolve_mailbox_entries(
    {} as TenantContext,
    repo,
    connector,
    't',
    'john.doe@example.com',
    filter,
  );
}

describe('resolve_mailbox_entries', () => {
  it('merges every snapshot of the mailbox, newest first', async () => {
    const result = await resolve();

    expect(result.manifests.map((m) => m.snapshot_id)).toEqual(['snap-2', 'snap-1']);
    expect(result.entries.map((e) => e.object_id).sort()).toEqual(['A', 'B', 'G']);
  });

  it('keeps only the snapshots in the date range', async () => {
    const result = await resolve({ start_date: new Date(Date.UTC(2026, 0, 2)) });

    expect(result.entries.map((e) => e.object_id)).toEqual(['B']);
  });

  it('selects a folder no longer in the mailbox by the path a snapshot recorded (issue #690)', async () => {
    const result = await resolve({ folder_name: 'Example Folder' });

    expect(result.entries.map((e) => e.object_id)).toEqual(['G']);
  });
});
