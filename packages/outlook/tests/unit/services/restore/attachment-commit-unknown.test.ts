/**
 * Issue #891. An attachment whose final upload chunk ended ambiguously may be on the restored
 * message, so it is reported as an unknown outcome, and still named when Ctrl+C stopped the run
 * while that chunk was in flight.
 */
import { describe, expect, it, vi } from 'vitest';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { UploadCommitUnknownError, type RestoreConnector } from '@wisecom/atlas-types';
import { restore_parsed_attachments } from '@/services/restore/restore-attachment-writer';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';

const UNKNOWN = new UploadCommitUnknownError(
  { range: 'bytes 0-3670015/3670016', item: 'attachment' },
  'HTTP 504',
);

/** Three parsed attachments named a.pdf, b.pdf and c.pdf. */
const ATTACHMENTS = ['a.pdf', 'b.pdf', 'c.pdf'].map((name): MimeAttachment => ({
  name,
  content_type: 'application/pdf',
  content: Buffer.from(name),
  is_inline: false,
}));

/** A connector whose `add_attachment` runs `add` for each attachment in turn. */
function connector_adding(add: (name: string) => Promise<void>): RestoreConnector {
  return {
    add_attachment: vi.fn((_t: string, _o: string, _m: string, att: { name: string }) =>
      add(att.name),
    ),
  } as unknown as RestoreConnector;
}

describe('restore_parsed_attachments with an attachment whose final chunk ended ambiguously', () => {
  it('reports the outcome as unknown and goes on with the next attachment', async () => {
    const connector = connector_adding((name) =>
      name === 'b.pdf' ? Promise.reject(UNKNOWN) : Promise.resolve(),
    );

    const result = await restore_parsed_attachments(connector, 't', 'u', 'msg-1', ATTACHMENTS);

    expect(result.restored).toBe(2);
    expect(result.errors).toEqual([`b.pdf: ${UNKNOWN.message}`]);
    expect(UNKNOWN.message).toMatch(/^outcome unknown, the attachment may exist/);
  });

  it('names the attachment when Ctrl+C was pressed while its final chunk was in flight', async () => {
    const controller = new AbortController();
    const connector = connector_adding((name) => {
      if (name !== 'b.pdf') return Promise.resolve();
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return Promise.reject(UNKNOWN);
    });

    const result = await run_with_abort_signal(controller.signal, () =>
      restore_parsed_attachments(connector, 't', 'u', 'msg-1', ATTACHMENTS),
    );

    expect(result.restored).toBe(1);
    expect(result.errors).toEqual([
      `b.pdf: ${UNKNOWN.message}`,
      '1 attachment(s) not uploaded: the run was interrupted',
    ]);
  });

  it('keeps one interrupted line for an attachment the cancellation stopped cleanly', async () => {
    const controller = new AbortController();
    const connector = connector_adding((name) => {
      if (name !== 'b.pdf') return Promise.resolve();
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return Promise.reject(new Error('Run interrupted by Ctrl+C'));
    });

    const result = await run_with_abort_signal(controller.signal, () =>
      restore_parsed_attachments(connector, 't', 'u', 'msg-1', ATTACHMENTS),
    );

    expect(result.errors).toEqual(['2 attachment(s) not uploaded: the run was interrupted']);
  });
});
