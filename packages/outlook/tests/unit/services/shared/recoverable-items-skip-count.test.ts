import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { resolve_snapshot_entries } from '@/services/shared/snapshot-entry-resolver';

/**
 * Issue #701. The Recoverable Items skip count covered the whole snapshot, though the operator
 * named one message or one folder.
 */

function entry(object_id: string, extra: Partial<ManifestEntry> = {}): ManifestEntry {
  return { object_id, storage_key: `data/${object_id}`, checksum: 'c', size_bytes: 1, ...extra };
}

const SNAPSHOT: Manifest = {
  id: 'snap-1',
  tenant_id: 't',
  owner_id: 'john.doe@example.com',
  snapshot_id: 'snap-1',
  created_at: new Date(Date.UTC(2026, 0, 1)),
  total_objects: 4,
  total_size_bytes: 4,
  delta_links: {},
  entries: [
    entry('R1', { folder_id: 'ri-del', recoverable_items: true }),
    entry('N1', { folder_id: 'f1' }),
    entry('R2', { folder_id: 'ri-del', recoverable_items: true }),
    entry('R3', { folder_id: 'ri-pur', recoverable_items: true }),
  ],
};

async function resolve(filter: Record<string, unknown>): Promise<string[]> {
  const repo = {
    find_by_snapshot: vi.fn(async () => SNAPSHOT),
    list_by_owner: vi.fn(async () => [SNAPSHOT]),
  } as unknown as ManifestRepository;
  const connector = {
    list_mail_folders: vi.fn(async () => [
      { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' },
      {
        folder_id: 'ri-del',
        display_name: 'Deletions',
        folder_path: 'Recoverable Items/Deletions',
      },
      { folder_id: 'ri-pur', display_name: 'Purges', folder_path: 'Recoverable Items/Purges' },
    ]),
  } as unknown as MailboxConnector;
  const ctx = {} as TenantContext;
  const result = await resolve_snapshot_entries(ctx, repo, connector, 't', 'snap-1', filter);
  return result.entries.map((e) => e.object_id);
}

describe('Recoverable Items skip count (#701)', () => {
  let info: MockInstance<typeof logger.info>;

  beforeEach(() => {
    info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => info.mockRestore());

  function skip_lines(): string[] {
    return info.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith('Skipping'));
  }

  it('logs nothing when the named message is not a Recoverable Items one', async () => {
    expect(await resolve({ message_ref: '2' })).toEqual(['N1']);
    expect(skip_lines()).toEqual([]);
  });

  it('counts only the named message when it is a Recoverable Items one', async () => {
    expect(await resolve({ message_ref: '1' })).toEqual([]);
    expect(skip_lines()).toEqual([expect.stringMatching(/^Skipping 1 Recoverable Items/)]);
  });

  it('names the same message by index with and without the flag', async () => {
    expect(await resolve({ message_ref: '3', include_recoverable_items: true })).toEqual(['R2']);
    expect(await resolve({ message_ref: '2', include_recoverable_items: true })).toEqual(['N1']);
  });

  it('logs nothing when the selected folder holds no Recoverable Items entry', async () => {
    expect(await resolve({ folder_name: 'Inbox' })).toEqual(['N1']);
    expect(skip_lines()).toEqual([]);
  });

  it('counts only the entries of the selected Recoverable Items folder', async () => {
    expect(await resolve({ folder_name: 'Recoverable Items/Deletions' })).toEqual([]);
    expect(skip_lines()).toEqual([expect.stringMatching(/^Skipping 2 Recoverable Items/)]);
  });

  it('counts every Recoverable Items entry when nothing is selected', async () => {
    expect(await resolve({})).toEqual(['N1']);
    expect(skip_lines()).toEqual([expect.stringMatching(/^Skipping 3 Recoverable Items/)]);
  });
});
