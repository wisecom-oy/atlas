import { describe, expect, it } from 'vitest';

import {
  contacts_data_key,
  contacts_manifest_key,
  contacts_photo_key,
} from '@/services/shared/storage-keys';

const MAILBOX = '00000000-0000-0000-0000-00000000ABCD';
const MAILBOX_LOWER = '00000000-0000-0000-0000-00000000abcd';
const CHECKSUM = 'a'.repeat(64);

describe('contacts storage keys', () => {
  it('lowercases the mailbox segment for data and photo keys', () => {
    expect(contacts_data_key(MAILBOX, CHECKSUM)).toBe(`contacts/data/${MAILBOX_LOWER}/${CHECKSUM}`);
    expect(contacts_photo_key(MAILBOX, CHECKSUM)).toBe(
      `contacts/photos/${MAILBOX_LOWER}/${CHECKSUM}`,
    );
  });

  it('places the snapshot manifest under the mailbox manifests prefix', () => {
    expect(contacts_manifest_key(MAILBOX, 'ct-snap-1-abc')).toBe(
      `contacts/manifests/${MAILBOX_LOWER}/ct-snap-1-abc.json`,
    );
  });

  it('rejects a content name that would escape its key prefix', () => {
    expect(() => contacts_data_key(MAILBOX, '../escape')).toThrow(/Content name/);
  });
});
