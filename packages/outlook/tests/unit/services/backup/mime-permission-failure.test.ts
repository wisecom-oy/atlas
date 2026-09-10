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

  it('still falls back to JSON for a per-message fault', async () => {
    const payload = await capture_mime_payload(
      make_connector(new Error('ErrorItemNotFound')),
      't',
      'o',
      MESSAGE,
    );

    expect(payload).toBeUndefined();
  });
});
