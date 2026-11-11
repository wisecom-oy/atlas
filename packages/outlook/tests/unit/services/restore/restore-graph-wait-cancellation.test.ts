/**
 * Issue #682. The Outlook restore loop kept a SIGINT listener of its own that only set a flag read
 * between messages, and never ran under the abort signal. Ctrl+C during a message create parked
 * in a Graph Retry-After sat the wait out, and the listener suppressed Node's default exit, so a
 * second Ctrl+C did nothing either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { AttachmentEntry } from '@wisecom/atlas-types';
import {
  make_restore_entry as make_entry,
  make_restore_harness,
  make_restore_manifest as make_manifest,
  STORED_PAYLOAD_CHECKSUM,
} from './restore.service.fixtures';

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

describe('Outlook restore cancelled during a Graph retry wait (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the create wait within a second and reports the messages already restored', async () => {
    const { service, mock_manifests, mock_restore } = make_restore_harness();
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest([
        make_entry('msg-1', 'f1'),
        make_entry('msg-2', 'f1'),
        make_entry('msg-3', 'f1'),
      ]),
    );
    vi.mocked(mock_restore.create_message)
      .mockResolvedValueOnce('new-msg-1')
      .mockImplementation(graph_call_parked_in_retry_wait);
    const sigint_listeners = process.listenerCount('SIGINT');
    const controller = new AbortController();
    let settled = false;

    const run = service
      .restore_snapshot('test-tenant', 'snap-1', { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    // Interruption reaches the service only through its options, never a listener of its own.
    expect(process.listenerCount('SIGINT')).toBe(sigint_listeners);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.restored_count).toBe(1);
    expect(result.error_count).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.restore_folder_name).toBe('Restore-2026-03-08');
    expect(mock_restore.create_message).toHaveBeenCalledTimes(2);
  });

  it('reports the attachments a cancelled upload left out once, not one failure each', async () => {
    const { service, mock_manifests, mock_restore } = make_restore_harness();
    const attachment = (id: string): AttachmentEntry => ({
      attachment_id: id,
      name: `${id}.pdf`,
      content_type: 'application/pdf',
      size_bytes: 10,
      storage_key: `att/${id}`,
      checksum: STORED_PAYLOAD_CHECKSUM,
      is_inline: false,
    });
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest([
        { ...make_entry('msg-1', 'f1'), attachments: [attachment('a-1'), attachment('a-2')] },
        make_entry('msg-2', 'f1'),
      ]),
    );
    vi.mocked(mock_restore.add_attachment).mockImplementation(graph_call_parked_in_retry_wait);
    const controller = new AbortController();

    const run = service.restore_snapshot('test-tenant', 'snap-1', {
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await run;
    expect(result.interrupted).toBe(true);
    // The message exists without its attachments, so the gap is reported, as one line.
    expect(result.restored_count).toBe(1);
    expect(result.error_count).toBe(0);
    expect(result.errors).toEqual(['msg-1: 2 attachment(s) not uploaded: the run was interrupted']);
    expect(mock_restore.add_attachment).toHaveBeenCalledTimes(1);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(1);
  });

  it('resolves an interrupted result when the signal lands before any message is written', async () => {
    const { service, mock_manifests, mock_restore } = make_restore_harness();
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest([make_entry('msg-1', 'f1')]),
    );
    vi.mocked(mock_restore.create_mail_folder).mockImplementation(graph_call_parked_in_retry_wait);
    const controller = new AbortController();

    const run = service.restore_snapshot('test-tenant', 'snap-1', {
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.restored_count).toBe(0);
    expect(mock_restore.create_message).not.toHaveBeenCalled();
  });
});
