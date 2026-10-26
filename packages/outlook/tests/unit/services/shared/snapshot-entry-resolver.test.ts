import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { resolve_snapshot_entries } from '@/services/shared/snapshot-entry-resolver';

/**
 * Issue #432. An Outlook manifest holds only that run's delta, so `restore -s` and `save -s` must
 * read the snapshot's whole chain, as `verify -s` does.
 */

function entry(object_id: string, extra: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id,
    storage_key: `data/${object_id}`,
    checksum: 'c',
    size_bytes: 1,
    folder_id: 'f1',
    ...extra,
  };
}

function manifest(
  snapshot_id: string,
  day: number,
  entries: ManifestEntry[],
  owner_id = 'john.doe@example.com',
): Manifest {
  return {
    id: snapshot_id,
    tenant_id: 't',
    owner_id,
    snapshot_id,
    created_at: new Date(Date.UTC(2026, 0, day)),
    total_objects: entries.length,
    total_size_bytes: entries.length,
    delta_links: {},
    entries,
  };
}

const SNAP_1 = manifest('snap-1', 1, [
  entry('A'),
  entry('B', { subject: 'old' }),
  entry('R', { recoverable_items: true }),
  entry('S', { folder_id: 'f2' }),
]);
const SNAP_2 = manifest('snap-2', 2, [entry('C'), entry('B', { subject: 'new' })]);
const SNAP_3 = manifest('snap-3', 3, [entry('D')]);
const OTHER = manifest('other', 1, [entry('X')], 'jane.doe@example.com');

async function resolve(snapshot_id: string, filter = {}): Promise<ManifestEntry[]> {
  const all = [SNAP_1, SNAP_2, SNAP_3, OTHER];
  const repo = {
    find_by_snapshot: vi.fn(async (_c: TenantContext, id: string) =>
      all.find((m) => m.snapshot_id === id),
    ),
    list_all_manifests: vi.fn(async () => all),
  } as unknown as ManifestRepository;
  const connector = {
    list_mail_folders: vi.fn(async () => [
      { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' },
      { folder_id: 'f2', display_name: 'Sent', folder_path: 'Sent' },
    ]),
  } as unknown as MailboxConnector;
  const ctx = {} as TenantContext;
  const result = await resolve_snapshot_entries(ctx, repo, connector, 't', snapshot_id, filter);
  return result.entries;
}

describe('resolve_snapshot_entries', () => {
  it('includes older messages of the same mailbox and excludes newer and foreign ones', async () => {
    const ids = (await resolve('snap-2')).map((e) => e.object_id).sort();

    expect(ids).toEqual(['A', 'B', 'C', 'S']);
  });

  it('takes the newest version of a message present in several manifests', async () => {
    const b = (await resolve('snap-2')).find((e) => e.object_id === 'B');

    expect(b?.subject).toBe('new');
  });

  it('resolves a message index against the target manifest, as list -s shows it', async () => {
    const [picked] = await resolve('snap-2', { message_ref: '2' });

    expect(picked?.object_id).toBe('B');
    expect(picked?.subject).toBe('new');
  });

  it('resolves an object_id carried over from an earlier snapshot', async () => {
    const [picked] = await resolve('snap-3', { message_ref: 'A' });

    expect(picked?.object_id).toBe('A');
  });

  it('applies the Recoverable Items policy to the merged set', async () => {
    const ids = (await resolve('snap-2', { include_recoverable_items: true })).map(
      (e) => e.object_id,
    );

    expect(ids).toContain('R');
  });

  it('applies the folder filter to the merged set', async () => {
    const ids = (await resolve('snap-2', { folder_name: 'Sent' })).map((e) => e.object_id);

    expect(ids).toEqual(['S']);
  });
});
