import { describe, expect, it, vi } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type { MailboxConnector, MailMessage } from '@wisecom/atlas-types';
import { capture_mime_payload } from '@/services/backup/message-payload-store';

/**
 * Issue #372. The MIME fallback exists for per-message faults, but the catch was unconditional,
 * so a revoked permission degraded every message in the run to the JSON payload, warn-logged
 * once per message, and still exited 0. The original MIME was lost for the whole run and nothing
 * surfaced it. The connector already raises these as typed errors; this catch ate them.
 */

const MESSAGE = { message_id: 'AAMkAG...', subject: 'Example subject' } as unknown as MailMessage;

function make_connector(failure: Error): MailboxConnector {
  return {
    fetch_mime: vi.fn().mockRejectedValue(failure),
  } as unknown as MailboxConnector;
}

describe('MIME capture failures', () => {
  it('stops the run on a revoked permission', async () => {
    await expect(
      capture_mime_payload(make_connector(new AuthError('403 from Graph')), 't', 'o', MESSAGE),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('stops the run on an unlicensed mailbox', async () => {
    await expect(
      capture_mime_payload(
        make_connector(new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')),
        't',
        'o',
        MESSAGE,
      ),
    ).rejects.toBeInstanceOf(MailboxNotLicensedError);
  });

  it('reports a failure that a later run may not hit, with no MIME (issue #614)', async () => {
    const capture = await capture_mime_payload(
      make_connector(Object.assign(new Error('Service Unavailable'), { statusCode: 503 })),
      't',
      'o',
      MESSAGE,
    );

    expect(capture).toEqual({ mime: undefined, failure: 'Service Unavailable' });
  });

  it('names the HTTP status when the Graph error carries no message', async () => {
    // A `$value` request reads its body as binary, so the SDK's error has an empty message.
    const capture = await capture_mime_payload(
      make_connector(Object.assign(new Error(''), { statusCode: 503 })),
      't',
      'o',
      MESSAGE,
    );

    expect(capture.failure).toBe('HTTP 503');
  });

  it('reports no failure when Graph has no MIME for the item', async () => {
    const connector = {
      fetch_mime: vi.fn().mockResolvedValue(undefined),
    } as unknown as MailboxConnector;

    const capture = await capture_mime_payload(connector, 't', 'o', MESSAGE);

    expect(capture).toEqual({ mime: undefined });
  });
});
