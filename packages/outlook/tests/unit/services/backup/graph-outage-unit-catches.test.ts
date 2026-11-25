import { describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import type { MailboxConnector, ManifestEntry, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import {
  capture_mime_payload,
  capture_page_extended_properties,
} from '@/services/backup/message-payload-store';
import { flush_pending_attachments } from '@/services/backup/attachment-storage-sync';
import { make_message } from './mailbox-sync.fixtures';

/**
 * Issue #881. A per-message catch that recorded an exhausted retry budget as that message's
 * failure let the folder carry on into the same outage: a JSON stand-in per message, metadata lost
 * per page. An outage now leaves the catch, so the folder fails and keeps its delta link. A failure
 * of the message's own is still recorded against it alone.
 */

const OUTAGE = new GraphUnavailableError('Microsoft Graph was unavailable after 12 retries', {
  retries: 12,
  elapsed_ms: 1_411_000,
});
const THROTTLED = new ThrottledError('Microsoft Graph kept throttling the request', 30_000);
const NOT_FOUND = Object.assign(new Error('Not Found'), { statusCode: 404 });

function connector_with(overrides: Partial<MailboxConnector>): MailboxConnector {
  return { ...overrides } as MailboxConnector;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { exists: vi.fn().mockResolvedValue(false), put: vi.fn(), get: vi.fn() },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

describe('capture_mime_payload', () => {
  it.each([
    ['GraphUnavailableError', OUTAGE],
    ['ThrottledError', THROTTLED],
  ])('passes an exhausted budget (%s) up instead of storing a JSON stand-in', async (_, err) => {
    const connector = connector_with({ fetch_mime: vi.fn().mockRejectedValue(err) });

    const capture = capture_mime_payload(connector, 't', 'o', make_message('msg-1', '{}'));

    await expect(capture).rejects.toBe(err);
  });

  it("still records a failure of the message's own as a capture that failed for now", async () => {
    const connector = connector_with({ fetch_mime: vi.fn().mockRejectedValue(NOT_FOUND) });

    const capture = await capture_mime_payload(connector, 't', 'o', make_message('msg-1', '{}'));

    expect(capture).toEqual({ mime: undefined, failure: 'Not Found' });
  });
});

describe('capture_page_extended_properties', () => {
  const page = [make_message('msg-1', '{}'), make_message('msg-2', '{}')];

  it('passes an exhausted budget up instead of losing the page metadata', async () => {
    const connector = connector_with({
      fetch_extended_properties: vi.fn().mockRejectedValue(OUTAGE),
    });

    await expect(capture_page_extended_properties(connector, 't', 'o', page)).rejects.toBe(OUTAGE);
  });

  it('still counts the page as not captured on a failure of its own', async () => {
    const connector = connector_with({
      fetch_extended_properties: vi.fn().mockRejectedValue(NOT_FOUND),
    });

    const properties = await capture_page_extended_properties(connector, 't', 'o', page);

    expect(properties.failed).toBe(2);
  });
});

describe('flush_pending_attachments', () => {
  function flush(fetch_attachments: MailboxConnector['fetch_attachments']) {
    const entries = [{ object_id: 'msg-1' }, { object_id: 'msg-2' }] as ManifestEntry[];
    const message_errors: string[] = [];
    const flushing = flush_pending_attachments(
      make_ctx(),
      connector_with({ fetch_attachments }),
      't',
      'o',
      entries,
      { stored: 0, deduplicated: 0, att_stored: 0 },
      [
        { entry_index: 0, message_id: 'msg-1' },
        { entry_index: 1, message_id: 'msg-2' },
      ],
      message_errors,
      () => false,
    );
    return { flushing, message_errors };
  }

  it('passes an exhausted budget up instead of one error per message', async () => {
    const { flushing, message_errors } = flush(vi.fn().mockRejectedValue(OUTAGE));

    await expect(flushing).rejects.toBe(OUTAGE);
    expect(message_errors).toEqual([]);
  });

  it("still records an attachment failure of the message's own and finishes", async () => {
    const fetch_attachments = vi.fn(async (_t: string, _o: string, message_id: string) => {
      if (message_id === 'msg-1') throw NOT_FOUND;
      return [];
    });
    const { flushing, message_errors } = flush(fetch_attachments);

    await expect(flushing).resolves.toBe(true);
    expect(message_errors).toEqual(['message msg-1: attachments not backed up (Not Found)']);
  });
});
