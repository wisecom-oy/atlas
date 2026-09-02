import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Manifest, ManifestRepository } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

function legacy_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'old-manifest',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'old-snap',
    created_at: new Date(),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: { 'folder-1': 'https://prev-delta' },
    entries: [],
    ...overrides,
  };
}

describe('MailboxSyncService - delta link continuity', () => {
  let harness: MailboxSyncHarness;
  let mock_manifests: ManifestRepository;

  beforeEach(() => {
    harness = create_mailbox_sync_harness();
    mock_manifests = harness.mock_manifests;
  });

  it('stores manifest with per-folder delta links', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue({
      messages: [],
      removed_ids: [],
      delta_link: 'https://new-delta',
      delta_reset: false,
    });

    await harness.service.sync_mailbox('t', 'user@test.com');

    expect(mock_manifests.save).toHaveBeenCalledOnce();
    const saved_manifest = vi.mocked(mock_manifests.save).mock.calls[0]![1];
    expect(saved_manifest.delta_links).toEqual({ 'folder-1': 'https://new-delta' });
    expect(saved_manifest.id_format).toBe('immutable');
  });

  it('passes previous delta link for incremental sync', async () => {
    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue(
      legacy_manifest({ id_format: 'immutable' }),
    );

    await harness.service.sync_mailbox('t', 'user@test.com');

    expect(harness.mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'folder-1',
      'https://prev-delta',
      expect.any(Function),
      undefined,
    );
  });

  it('restarts full when the previous manifest predates immutable IDs (issue #48)', async () => {
    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue(legacy_manifest());

    await harness.service.sync_mailbox('t', 'user@test.com');

    // Legacy mutable-ID delta link must NOT be resumed — no prev link passed.
    expect(harness.mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'folder-1',
      undefined,
      expect.any(Function),
      undefined,
    );
  });
});
