import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxDeltaCursor,
  MailboxDeltaCursorRepository,
  Manifest,
} from '@wisecom/atlas-types';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';

/**
 * Issues #703 and #704. A cursor that outlived its snapshot, through `delete -s` of the newest
 * snapshot or `delete -m`, was resumed anyway: the next backup stored only the changes since the
 * cursor and the rest of each folder was in no snapshot. The cursor now names the head it was
 * saved with, and its links are resumed only while that snapshot is still the head.
 */
const OWNER = 'john.doe@example.com';

function make_head(snapshot_id: string): Manifest {
  return {
    id: `manifest-${snapshot_id}`,
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_objects: 12,
    total_size_bytes: 4096,
    delta_links: { 'folder-1': 'https://delta/from-manifest' },
    id_format: 'immutable',
    entries: [],
  } as unknown as Manifest;
}

function cursor_for(snapshot_id: string | undefined): MailboxDeltaCursor {
  return {
    owner_id: OWNER,
    delta_links: { 'folder-1': 'https://delta/from-cursor' },
    updated_at: '2026-08-17T00:00:00.000Z',
    ...(snapshot_id !== undefined ? { snapshot_id } : {}),
  };
}

type Harness = ReturnType<typeof create_mailbox_sync_harness>;

function arrange(head: Manifest | undefined, cursor: MailboxDeltaCursor | undefined): Harness {
  const harness = create_mailbox_sync_harness();
  vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(latest_readable(head));
  vi.mocked(harness.mock_cursors.load).mockResolvedValue(cursor);
  vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
    make_delta([make_message('m1', 'body')], 'https://delta/new'),
  );
  return harness;
}

/** The delta link the run handed Graph for folder-1; undefined means a full enumeration. */
function link_requested(harness: Harness): string | undefined {
  return vi.mocked(harness.mock_connector.fetch_delta).mock.calls[0]?.[3];
}

function saved_cursor(harness: { mock_cursors: MailboxDeltaCursorRepository }): MailboxDeltaCursor {
  return vi.mocked(harness.mock_cursors.save).mock.calls.at(-1)![1];
}

describe('an outlook backup whose cursor outlived its snapshot', () => {
  it('reads in full when the cursor names a snapshot that is no longer the head (#704)', async () => {
    const harness = arrange(make_head('snap-1'), cursor_for('snap-2-deleted'));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(link_requested(harness)).toBeUndefined();
  });

  it('reads in full when a cursor exists but no manifest does (#703)', async () => {
    const harness = arrange(undefined, cursor_for('snap-2-deleted'));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(link_requested(harness)).toBeUndefined();
  });

  it('reads in full for a pre-binding cursor when no manifest exists (#703)', async () => {
    const harness = arrange(undefined, cursor_for(undefined));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(link_requested(harness)).toBeUndefined();
  });

  it('resumes the cursor while it names the head', async () => {
    const harness = arrange(make_head('snap-1'), cursor_for('snap-1'));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(link_requested(harness)).toBe('https://delta/from-cursor');
  });

  it('resumes a pre-binding cursor while a head exists', async () => {
    const harness = arrange(make_head('snap-1'), cursor_for(undefined));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(link_requested(harness)).toBe('https://delta/from-cursor');
  });
});

describe('the saved cursor', () => {
  it('names the snapshot the run wrote', async () => {
    const harness = arrange(make_head('snap-1'), cursor_for('snap-1'));

    await harness.service.sync_mailbox('test-tenant', OWNER);

    const written = vi.mocked(harness.mock_manifests.save).mock.calls[0]![1];
    expect(saved_cursor(harness).snapshot_id).toBe(written.snapshot_id);
    expect(written.snapshot_id).not.toBe('snap-1');
  });

  it('names the unchanged head after a run that captured nothing', async () => {
    const harness = arrange(make_head('snap-1'), cursor_for('snap-1'));
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([], 'https://delta/new'),
    );

    await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(saved_cursor(harness).snapshot_id).toBe('snap-1');
  });
});
