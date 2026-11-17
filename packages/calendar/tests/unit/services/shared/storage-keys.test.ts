import { describe, expect, it } from 'vitest';

import {
  calendar_attachment_key,
  calendar_data_key,
  calendar_delta_cursor_key,
  calendar_manifest_key,
  calendar_mailbox_prefixes,
} from '@/services/shared/storage-keys';

const MAILBOX = '00000000-0000-0000-0000-00000000ABCD';
const MAILBOX_LOWER = '00000000-0000-0000-0000-00000000abcd';
const CHECKSUM = 'a'.repeat(64);

describe('calendar storage keys', () => {
  it('lowercases the mailbox segment for data, attachment, cursor and manifest keys', () => {
    expect(calendar_data_key(MAILBOX, CHECKSUM)).toBe(`calendar/data/${MAILBOX_LOWER}/${CHECKSUM}`);
    expect(calendar_attachment_key(MAILBOX, CHECKSUM)).toBe(
      `calendar/attachments/${MAILBOX_LOWER}/${CHECKSUM}`,
    );
    expect(calendar_delta_cursor_key(MAILBOX)).toBe(`calendar/_meta/${MAILBOX_LOWER}/delta.json`);
    expect(calendar_manifest_key(MAILBOX, 'cal-snap-1-abc')).toBe(
      `calendar/manifests/${MAILBOX_LOWER}/cal-snap-1-abc.json`,
    );
  });

  it('erases every location a mailbox occupies and nothing else', () => {
    expect(calendar_mailbox_prefixes(MAILBOX)).toEqual([
      `calendar/data/${MAILBOX_LOWER}/`,
      `calendar/attachments/${MAILBOX_LOWER}/`,
      `calendar/manifests/${MAILBOX_LOWER}/`,
      `calendar/_meta/${MAILBOX_LOWER}/`,
      `_quarantine/calendar/manifests/${MAILBOX_LOWER}/`,
    ]);
  });

  it('rejects a content name that would escape its key prefix', () => {
    expect(() => calendar_data_key(MAILBOX, '../escape')).toThrow(/Content name/);
    expect(() => calendar_attachment_key(MAILBOX, 'a/b')).toThrow(/Content name/);
  });

  it('rejects a snapshot id that would escape the manifest prefix', () => {
    expect(() => calendar_manifest_key(MAILBOX, '..')).toThrow(/Snapshot id/);
    expect(() => calendar_manifest_key(MAILBOX, 'a\\b')).toThrow(/Snapshot id/);
  });

  it('rejects a mailbox id that would escape its key prefix', () => {
    expect(() => calendar_data_key('../other', CHECKSUM)).toThrow(/Mailbox id/);
  });
});
