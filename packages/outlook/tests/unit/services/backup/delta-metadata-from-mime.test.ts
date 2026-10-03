import { describe, it, expect } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { graph_message_to_mail_message } from '@/adapters/graph-delta-message-mapper';
import { store_single_message } from '@/services/backup/message-payload-store';

// An already backed-up message: its content is stored, so the run deduplicates it.
const ctx = { storage: { exists: async () => true } } as unknown as TenantContext;

function mime_with(date_header: string): Buffer {
  return Buffer.from(
    'Subject: =?UTF-8?Q?Quarterly_review?=\r\n' +
      'From: "Ada Example" <ada@example.com>\r\n' +
      `Date: ${date_header}\r\n\r\n` +
      'body\r\n',
  );
}

describe('manifest metadata for an updated delta item (issue #459)', () => {
  it('takes subject, sender and date from the MIME when the delta item has only id and changes', async () => {
    const message = graph_message_to_mail_message({ id: 'msg-1', isRead: true });

    const { manifest_entry } = await store_single_message(
      ctx,
      message,
      'owner-1',
      undefined,
      mime_with('Tue, 10 Mar 2026 14:30:22 +0000'),
    );

    expect(manifest_entry.subject).toBe('Quarterly review');
    expect(manifest_entry.from).toEqual({ name: 'Ada Example', address: 'ada@example.com' });
    expect(manifest_entry.received_at).toBe('2026-03-10T14:30:22.000Z');
  });

  it('records no receive time when neither the delta item nor the MIME has a valid one', async () => {
    const message = graph_message_to_mail_message({ id: 'msg-1' });

    const mime = await store_single_message(ctx, message, 'o', undefined, mime_with('not a date'));
    const json = await store_single_message(ctx, message, 'o');

    expect(message).not.toHaveProperty('received_at');
    expect(mime.manifest_entry).not.toHaveProperty('received_at');
    expect(json.manifest_entry).not.toHaveProperty('received_at');
  });

  it('keeps the metadata the delta item reports over the MIME headers', async () => {
    const message = graph_message_to_mail_message({
      id: 'msg-1',
      subject: 'Graph subject',
      receivedDateTime: '2026-03-11T08:00:00Z',
      from: { emailAddress: { address: 'graph@example.com' } },
    });

    const { manifest_entry } = await store_single_message(
      ctx,
      message,
      'o',
      undefined,
      mime_with('Tue, 10 Mar 2026 14:30:22 +0000'),
    );

    expect(manifest_entry.subject).toBe('Graph subject');
    expect(manifest_entry.from).toEqual({ address: 'graph@example.com' });
    expect(manifest_entry.received_at).toBe('2026-03-11T08:00:00.000Z');
  });

  it('keeps an empty subject Graph reports rather than reading the MIME header', async () => {
    const message = graph_message_to_mail_message({ id: 'msg-1', subject: '' });

    const { manifest_entry } = await store_single_message(
      ctx,
      message,
      'o',
      undefined,
      mime_with('Tue, 10 Mar 2026 14:30:22 +0000'),
    );

    expect(manifest_entry.subject).toBe('');
  });
});
