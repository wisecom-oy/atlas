import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type { MailboxDeltaCursor, Manifest, ManifestEntry, SyncResult } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';

/**
 * Issues #614 and #615. A message stored without its MIME (a 503 that outlasted the retries) or
 * without its attachments (a failed storage put) still let the folder's delta link advance. The
 * failing run exited 2, the next exited 0, and delta never presented the unchanged message again,
 * so the gap was permanent. The folder now keeps its previous link until a run captures it all.
 */

const OWNER = 'user@example.com';
const MIME = Buffer.from('Subject: Hi\r\n\r\nbody\r\n');
const PREVIOUS_LINK = 'https://delta/link-0';
const NEXT_LINK = 'https://delta/link-1';

function service_unavailable(): Error {
  return Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
}

/**
 * Keeps the cursor and the head manifest the way storage would, so the second run resumes from
 * what the first saved. Both start from an earlier backup of the folder.
 */
function persist_state_between_runs(harness: MailboxSyncHarness): void {
  let cursor: MailboxDeltaCursor = {
    owner_id: OWNER,
    delta_links: { 'folder-1': PREVIOUS_LINK },
    updated_at: new Date(0).toISOString(),
  };
  let head: Manifest = {
    id: 'manifest-0',
    tenant_id: 't',
    owner_id: OWNER,
    snapshot_id: 'snapshot-0',
    created_at: new Date(0),
    total_objects: 5,
    total_size_bytes: 0,
    delta_links: cursor.delta_links,
    id_format: 'immutable',
    entries: [],
  };
  vi.mocked(harness.mock_cursors.load).mockImplementation(async () => cursor);
  vi.mocked(harness.mock_cursors.save).mockImplementation(async (_ctx, saved) => {
    cursor = saved;
  });
  vi.mocked(harness.mock_manifests.find_latest_readable).mockImplementation(async () =>
    latest_readable(head),
  );
  vi.mocked(harness.mock_manifests.save).mockImplementation(async (_ctx, saved) => {
    head = saved;
  });
}

function saved_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.lastCall![1].delta_links;
}

function entry_for(result: SyncResult, message_id: string): ManifestEntry | undefined {
  return result.manifest.entries.find((entry) => entry.object_id === message_id);
}

function prev_link_of_last_delta(harness: MailboxSyncHarness): string | undefined {
  return vi.mocked(harness.mock_connector.fetch_delta).mock.lastCall![3];
}

describe('a per-message failure withholds the folder delta link', () => {
  let harness: MailboxSyncHarness;

  beforeEach(() => {
    harness = create_mailbox_sync_harness();
    persist_state_between_runs(harness);
  });

  describe('MIME capture failing for now (issue #614)', () => {
    beforeEach(() => {
      vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
        make_delta(
          [make_message('msg-1', '{"id":"msg-1"}'), make_message('msg-2', '{}')],
          NEXT_LINK,
        ),
      );
    });

    it('keeps the JSON payload, names the folder, and captures the MIME on the next run', async () => {
      harness.mock_connector.fetch_mime = vi.fn(async (_t: string, _o: string, id: string) => {
        if (id === 'msg-1') throw service_unavailable();
        return MIME;
      });
      const first = await harness.service.sync_mailbox('t', OWNER);

      expect(first.summary.folder_errors).toEqual([
        expect.stringMatching(/^Inbox: message msg-1: original MIME not captured/),
      ]);
      expect(entry_for(first, 'msg-1')?.payload_format).toBeUndefined();
      expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });

      harness.mock_connector.fetch_mime = vi.fn().mockResolvedValue(MIME);
      const second = await harness.service.sync_mailbox('t', OWNER);

      expect(prev_link_of_last_delta(harness)).toBe(PREVIOUS_LINK);
      expect(second.summary.folder_errors).toEqual([]);
      expect(entry_for(second, 'msg-1')?.payload_format).toBe('mime');
      expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
    });

    it('advances the link when Graph has no MIME for the item', async () => {
      harness.mock_connector.fetch_mime = vi.fn().mockResolvedValue(undefined);

      const result = await harness.service.sync_mailbox('t', OWNER);

      expect(result.summary.folder_errors).toEqual([]);
      expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
    });

    it.each([
      ['a revoked permission', new AuthError('403 from Graph')],
      ['an unlicensed mailbox', new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')],
    ])('still stops the folder on %s', async (_label, failure) => {
      harness.mock_connector.fetch_mime = vi.fn().mockRejectedValue(failure);

      const result = await harness.service.sync_mailbox('t', OWNER);

      expect(result.summary.folder_errors).toEqual([`Inbox: ${failure.message}`]);
      expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });
    });
  });

  describe('attachment store failing (issue #615)', () => {
    beforeEach(() => {
      vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
        make_delta([make_message('msg-1', '{"id":"msg-1"}', true)], NEXT_LINK),
      );
      vi.mocked(harness.mock_connector.fetch_attachments).mockResolvedValue([
        {
          attachment_id: 'att-1',
          name: 'report.pdf',
          content_type: 'application/pdf',
          size_bytes: 4,
          content: Buffer.from('%PDF'),
          is_inline: false,
          content_id: '',
        },
      ]);
    });

    it('keeps the message, names the folder, and stores the attachment on the next run', async () => {
      const put = vi.mocked(harness.mock_context.storage.put);
      put.mockImplementation(async (key: string) => {
        if (key.startsWith('attachments/')) throw service_unavailable();
      });
      const first = await harness.service.sync_mailbox('t', OWNER);

      expect(first.summary.folder_errors).toEqual([
        expect.stringMatching(/^Inbox: message msg-1: attachments not backed up/),
      ]);
      expect(entry_for(first, 'msg-1')?.attachments).toBeUndefined();
      expect(saved_links(harness)).toEqual({ 'folder-1': PREVIOUS_LINK });

      put.mockResolvedValue(undefined);
      const second = await harness.service.sync_mailbox('t', OWNER);

      expect(prev_link_of_last_delta(harness)).toBe(PREVIOUS_LINK);
      expect(second.summary.folder_errors).toEqual([]);
      expect(entry_for(second, 'msg-1')?.attachments).toHaveLength(1);
      expect(saved_links(harness)).toEqual({ 'folder-1': NEXT_LINK });
    });
  });
});
