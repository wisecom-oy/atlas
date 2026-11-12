/**
 * Issue #623: two backups of one mailbox overwrote each other's delta cursor and `latest.json`
 * pointer with no error. The backup now runs under the mailbox's lease.
 */
import { describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';

const MAILBOX = 'user@test.com';
const LEASE = { workload: 'outlook', owner_id: MAILBOX, operation: 'backup' } as const;

describe('Outlook backup under the mailbox lease (issue #623)', () => {
  it('takes the lease before it reads the head manifest and the cursor, and releases it', async () => {
    const h = create_mailbox_sync_harness();
    const events_at_read: string[][] = [];
    const record_events = async (): Promise<undefined> => {
      events_at_read.push([...h.leases.events]);
      return undefined;
    };
    vi.mocked(h.mock_cursors.load).mockImplementation(record_events);

    await h.service.sync_mailbox('t', 'User@Test.com');

    expect(h.leases.requests).toEqual([LEASE]);
    expect(events_at_read).toEqual([['acquire']]);
    // One check before the manifest and one before the cursor, then the release.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
    expect(h.mock_manifests.save).toHaveBeenCalledTimes(1);
    expect(h.mock_cursors.save).toHaveBeenCalledTimes(1);
  });

  it('fails before reading the cursor and writes nothing while another run holds the mailbox', async () => {
    const h = create_mailbox_sync_harness();
    h.leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(h.service.sync_mailbox('t', MAILBOX)).rejects.toBeInstanceOf(OwnerBusyError);

    expect(h.mock_manifests.find_latest_readable).not.toHaveBeenCalled();
    expect(h.mock_cursors.load).not.toHaveBeenCalled();
    expect(h.mock_connector.fetch_delta).not.toHaveBeenCalled();
    expect(h.mock_context.storage.put).not.toHaveBeenCalled();
    expect(h.mock_manifests.save).not.toHaveBeenCalled();
    expect(h.mock_cursors.save).not.toHaveBeenCalled();
    expect(h.mock_context.destroy).toHaveBeenCalledTimes(1);
  });

  it('writes neither manifest nor cursor once the lease is lost mid-run', async () => {
    const h = create_mailbox_sync_harness();
    h.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another operation replaced it'));

    await expect(h.service.sync_mailbox('t', MAILBOX)).rejects.toBeInstanceOf(OwnerLeaseLostError);

    // The folder was read, so the run got as far as its first commit point.
    expect(h.mock_connector.fetch_delta).toHaveBeenCalledTimes(1);
    expect(h.mock_manifests.save).not.toHaveBeenCalled();
    expect(h.mock_cursors.save).not.toHaveBeenCalled();
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const h = create_mailbox_sync_harness();
    vi.mocked(h.mock_connector.list_mail_folders).mockRejectedValue(new Error('graph unavailable'));

    await expect(h.service.sync_mailbox('t', MAILBOX)).rejects.toThrow('graph unavailable');

    expect(h.leases.events).toEqual(['acquire', 'release']);
  });

  it('releases the lease when the run is cancelled inside a Graph call', async () => {
    const h = create_mailbox_sync_harness();
    const abort = new AbortController();
    vi.mocked(h.mock_connector.list_mail_folders).mockImplementation(async () => {
      abort.abort();
      throw abort.signal.reason;
    });

    const result = await h.service.sync_mailbox('t', MAILBOX, { abort_signal: abort.signal });

    expect(result.interrupted).toBe(true);
    expect(h.mock_cursors.save).not.toHaveBeenCalled();
    expect(h.leases.events).toEqual(['acquire', 'release']);
  });
});
