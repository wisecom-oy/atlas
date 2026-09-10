import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxDeltaCursor,
  MailboxDeltaCursorRepository,
  Manifest,
} from '@wisecom/atlas-types';
import { create_mailbox_sync_harness, make_delta } from './mailbox-sync.fixtures';

/**
 * Issue #370. Outlook backup wrote a snapshot manifest on every run, including runs where the
 * delta came back empty, because the manifest was where the folder delta links lived. A quiet
 * mailbox therefore grew one manifest object per run forever. Snapshots are immutable once
 * written, so the links moved to a cursor the run overwrites instead.
 */
function make_head(delta_links: Record<string, string>): Manifest {
  return {
    id: 'manifest-head',
    tenant_id: 'test-tenant',
    owner_id: 'john.doe@example.com',
    snapshot_id: 'snap-head',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_objects: 12,
    total_size_bytes: 4096,
    delta_links,
    id_format: 'immutable',
    entries: [],
  } as unknown as Manifest;
}

function saved_cursor(harness: { mock_cursors: MailboxDeltaCursorRepository }): MailboxDeltaCursor {
  return vi.mocked(harness.mock_cursors.save).mock.calls.at(-1)![1];
}

describe('an outlook backup that captured nothing', () => {
  it('writes no snapshot manifest, and still persists the delta link', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(make_head({}));
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: 'john.doe@example.com',
      delta_links: { 'folder-1': 'https://delta/old' },
      updated_at: '2026-08-17T00:00:00.000Z',
    });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([], 'https://delta/new'),
    );

    const result = await harness.service.sync_mailbox('test-tenant', 'john.doe@example.com');

    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(saved_cursor(harness).delta_links['folder-1']).toBe('https://delta/new');
    // The run reports the snapshot the mailbox has, not one it did not write.
    expect(result.snapshot.id).toBe('snap-head');
  });

  it('keeps a link for a folder this run did not visit', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(make_head({}));
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: 'john.doe@example.com',
      delta_links: { 'folder-1': 'https://delta/old', 'folder-2': 'https://delta/other' },
      updated_at: '2026-08-17T00:00:00.000Z',
    });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([], 'https://delta/new'),
    );

    await harness.service.sync_mailbox('test-tenant', 'john.doe@example.com');

    expect(saved_cursor(harness).delta_links['folder-2']).toBe('https://delta/other');
  });

  it('falls back to the head manifest links for a mailbox with no cursor yet', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(
      make_head({ 'folder-1': 'https://delta/from-manifest' }),
    );
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(make_delta([]));

    await harness.service.sync_mailbox('test-tenant', 'john.doe@example.com');

    // Resumed rather than re-enumerated: the link it was given is the one it asked Graph with.
    expect(harness.mock_connector.fetch_delta).toHaveBeenCalledWith(
      'test-tenant',
      'john.doe@example.com',
      'folder-1',
      'https://delta/from-manifest',
      expect.anything(),
      undefined,
    );
  });

  it('writes the first manifest for a mailbox that has none', async () => {
    const harness = create_mailbox_sync_harness();

    await harness.service.sync_mailbox('test-tenant', 'john.doe@example.com');

    expect(harness.mock_manifests.save).toHaveBeenCalledOnce();
  });

  it('writes the cursor only after the manifest is durable', async () => {
    const order: string[] = [];
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.save).mockImplementation(async () => {
      order.push('manifest');
    });
    vi.mocked(harness.mock_cursors.save).mockImplementation(async () => {
      order.push('cursor');
    });

    await harness.service.sync_mailbox('test-tenant', 'john.doe@example.com');

    // A cursor that lands first tells the next run to skip changes no manifest recorded (#339).
    expect(order).toEqual(['manifest', 'cursor']);
  });
});
