import { describe, it, expect, vi } from 'vitest';
import { restore_one_entry } from '@/services/restore/restore-execution-orchestrator';
import type { ManifestEntry, RestoreConnector } from '@wisecom/atlas-types';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { sha } from './mime-entry.fixtures';
import {
  HTML_BODY_PART,
  INVITE_ICS_PART,
  PLAIN_BODY_PART,
  build_icalendar,
  build_mixed_meeting_mime,
  calendar_part,
} from '../shared/meeting-message-mime.fixtures';

const STORAGE_KEY = 'data/user/meeting-response-blob';

/** The "Accepted:" response of issue #817: three body alternatives and an `invite.ics` file. */
const MEETING_RESPONSE_MIME = build_mixed_meeting_mime(
  [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')],
  [INVITE_ICS_PART],
);

/** A MIME manifest entry for the stored bytes. */
function build_mime_entry(mime: Buffer): ManifestEntry {
  return {
    object_id: 'msg-meeting',
    storage_key: STORAGE_KEY,
    checksum: sha(mime),
    size_bytes: mime.length,
    subject: 'Accepted: Example subject',
    folder_id: 'f1',
    payload_format: 'mime',
    received_at: '2025-03-03T08:00:00.000Z',
  };
}

const MEETING_RESPONSE_ENTRY = build_mime_entry(MEETING_RESPONSE_MIME);

const PR_MESSAGE_CLASS = 'String 0x001A';

/** Restores the stored MIME and returns the message class the create payload sets, if any. */
async function restore_and_read_message_class(mime: Buffer): Promise<string | undefined> {
  const { ctx } = stub_tenant_context({ [STORAGE_KEY]: mime });
  const restore_connector = make_restore_connector();

  await restore_one_entry(
    ctx,
    restore_connector,
    'tenant-1',
    'john.doe@example.com',
    'target-folder',
    build_mime_entry(mime),
  );

  const payload = vi.mocked(restore_connector.create_message).mock.calls[0]![3];
  const properties = payload['singleValueExtendedProperties'] as { id: string; value: string }[];
  return properties.find((property) => property.id === PR_MESSAGE_CLASS)?.value;
}

function make_restore_connector(): RestoreConnector {
  return {
    create_mail_folder: vi.fn(),
    find_child_mail_folder: vi.fn().mockResolvedValue(undefined),
    find_well_known_folder_role: vi.fn().mockResolvedValue(undefined),
    create_message: vi.fn().mockResolvedValue('new-msg-id'),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
    list_folder_messages: vi.fn(),
  };
}

describe('restore of a meeting response captured as MIME', () => {
  it('uploads invite.ics alone, as the source message held it', async () => {
    const { ctx } = stub_tenant_context({ [STORAGE_KEY]: MEETING_RESPONSE_MIME });
    const restore_connector = make_restore_connector();

    const outcome = await restore_one_entry(
      ctx,
      restore_connector,
      'tenant-1',
      'john.doe@example.com',
      'target-folder',
      MEETING_RESPONSE_ENTRY,
    );

    const uploaded = vi
      .mocked(restore_connector.add_attachment)
      .mock.calls.map(([, , , attachment]) => `${attachment.name} (${attachment.content_type})`);
    expect(uploaded).toEqual(['invite.ics (application/ics)']);
    expect(outcome.report.attachments_expected).toEqual({ file: 1, inline: 0 });
    expect(outcome.report.attachments_uploaded).toEqual({ file: 1, inline: 0 });
  });

  it('creates the message with its HTML body, not the calendar data', async () => {
    const { ctx } = stub_tenant_context({ [STORAGE_KEY]: MEETING_RESPONSE_MIME });
    const restore_connector = make_restore_connector();

    await restore_one_entry(
      ctx,
      restore_connector,
      'tenant-1',
      'john.doe@example.com',
      'target-folder',
      MEETING_RESPONSE_ENTRY,
    );

    const payload = vi.mocked(restore_connector.create_message).mock.calls[0]![3];
    expect(payload['body']).toEqual({
      contentType: 'html',
      content: expect.stringContaining('<p>Jane Roe has accepted this invitation.</p>'),
    });
  });

  // Graph creates the three response classes. It answers 500 ErrorItemSavePropertyError to the
  // request and cancellation classes, so those restore as ordinary mail.
  it.each([
    ['ACCEPTED', 'IPM.Schedule.Meeting.Resp.Pos'],
    ['DECLINED', 'IPM.Schedule.Meeting.Resp.Neg'],
    ['TENTATIVE', 'IPM.Schedule.Meeting.Resp.Tent'],
  ])('creates a PARTSTAT=%s reply with the message class %s', async (partstat, message_class) => {
    const icalendar = build_icalendar('REPLY', {
      attendee_lines: [`ATTENDEE;PARTSTAT=${partstat}:mailto:jane.roe@partner.example`],
    });
    const mime = build_mixed_meeting_mime(
      [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY', [], icalendar)],
      [INVITE_ICS_PART],
    );

    expect(await restore_and_read_message_class(mime)).toBe(message_class);
  });

  it.each(['REQUEST', 'CANCEL'])('sets no message class on a METHOD:%s message', async (method) => {
    const mime = build_mixed_meeting_mime(
      [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part(method)],
      [],
    );

    expect(await restore_and_read_message_class(mime)).toBeUndefined();
  });

  it('sets no message class on ordinary mail', async () => {
    const mime = build_mixed_meeting_mime([PLAIN_BODY_PART, HTML_BODY_PART], [INVITE_ICS_PART]);

    expect(await restore_and_read_message_class(mime)).toBeUndefined();
  });
});
