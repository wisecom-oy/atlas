import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type { CatalogService } from '@/services/catalog/catalog.service';
import type { ManifestRepository } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { build_catalog_harness, make_manifest } from './catalog-service.fixtures';

const OWNER = '00000000-0000-0000-0000-00000000abcd';
const DAMAGED = `manifests/${OWNER}/snap-damaged.json`;

describe('Outlook catalog with a damaged manifest (issue #631)', () => {
  let service: CatalogService;
  let mock_manifests: ManifestRepository;

  beforeEach(() => {
    ({ service, mock_manifests } = build_catalog_harness());
  });

  it('fails the snapshot listing with the key named, carrying the readable snapshots', async () => {
    const readable = make_manifest({ owner_id: OWNER, snapshot_id: 'snap-ok' });
    vi.mocked(mock_manifests.list_readable_by_owner).mockResolvedValue({
      manifests: [readable],
      unreadable_keys: [DAMAGED],
    });

    const error = await service.list_snapshots('t', OWNER).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnreadableObjectsError);
    expect((error as UnreadableObjectsError).code).toBe('ATLAS_CONTENT_UNREADABLE');
    expect((error as UnreadableObjectsError).unreadable_keys).toEqual([DAMAGED]);
    expect((error as UnreadableObjectsError).partial_result).toEqual([readable]);
  });

  it('fails the mailbox listing with the key named, carrying the readable summaries', async () => {
    vi.mocked(mock_manifests.list_all_readable).mockResolvedValue({
      manifests: [make_manifest({ owner_id: OWNER, snapshot_id: 'snap-ok' })],
      unreadable_keys: [DAMAGED],
    });

    const error = (await service
      .list_mailboxes('t')
      .catch((err: unknown) => err)) as UnreadableObjectsError<{ owner_id: string }[]>;

    expect(error.unreadable_keys).toEqual([DAMAGED]);
    expect(error.partial_result?.map((summary) => summary.owner_id)).toEqual([OWNER]);
  });

  it('refuses to read a message from a chain that may need the damaged manifest', async () => {
    // An Outlook snapshot id carries no time, so a damaged manifest cannot be placed in the
    // chain: it may hold the very messages, or the removals, that the target depends on.
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest({ owner_id: OWNER, snapshot_id: 'snap-ok' }),
    );
    vi.mocked(mock_manifests.list_by_owner).mockRejectedValue(
      new UnreadableObjectsError('1 Outlook manifest(s) of this mailbox could not be read', [
        DAMAGED,
      ]),
    );

    const read = service.read_message('t', 'snap-ok', 'AAMkAG-carried-message');

    await expect(read).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(read).rejects.toMatchObject({ unreadable_keys: [DAMAGED] });
    await expect(read).rejects.toThrow(/Snapshot snap-ok cannot be resolved/);
  });

  it('reads a message by index from the target alone, so older damage does not block it (#625)', async () => {
    // The target's own entries head its merged chain, so an index never needs older manifests.
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest({ owner_id: OWNER, snapshot_id: 'snap-ok' }),
    );
    vi.mocked(mock_manifests.list_by_owner).mockRejectedValue(
      new UnreadableObjectsError('1 Outlook manifest(s) of this mailbox could not be read', [
        DAMAGED,
      ]),
    );

    await expect(service.read_message('t', 'snap-ok', '1')).resolves.toBeUndefined();
    expect(mock_manifests.list_snapshot_summaries).not.toHaveBeenCalled();
  });
});
