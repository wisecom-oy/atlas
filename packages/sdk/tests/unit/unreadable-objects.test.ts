/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import {
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_CATALOG_USE_CASE_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
  CONTACTS_QUARANTINE_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  CONTACTS_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@/index';
import { create_contacts_api } from '@/contacts-api.factory';

const OBJECT_ID = '00000000-0000-0000-0000-00000000abcd';
const KEY = `contacts/manifests/${OBJECT_ID}/ct-snap-2-abc.json`;

const catalog = { list_contacts_snapshots: vi.fn() };
const quarantine = { quarantine_unreadable_object: vi.fn() };
const by_token = new Map<symbol, unknown>([
  [CONTACTS_BACKUP_USE_CASE_TOKEN, {}],
  [CONTACTS_RESTORE_USE_CASE_TOKEN, {}],
  [CONTACTS_CATALOG_USE_CASE_TOKEN, catalog],
  [CONTACTS_VERIFICATION_USE_CASE_TOKEN, {}],
  [CONTACTS_DELETION_USE_CASE_TOKEN, {}],
  [CONTACTS_QUARANTINE_USE_CASE_TOKEN, quarantine],
  [USER_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
]);
const container = { get: (token: symbol) => by_token.get(token) } as unknown as Container;

describe('SDK reporting of unreadable stored objects (issue #631)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a listing with the typed error, its keys, and the readable rows in camelCase', async () => {
    catalog.list_contacts_snapshots.mockRejectedValue(
      new UnreadableObjectsError('1 stored object(s) could not be read and are not listed', [KEY], {
        partial_result: [{ snapshot_id: 'ct-snap-1-abc', total_contacts: 3 }],
      }),
    );

    const error = (await create_contacts_api('tenant-1', container)
      .listSnapshots(OBJECT_ID)
      .catch((err: unknown) => err)) as UnreadableObjectsError;

    expect(error).toBeInstanceOf(UnreadableObjectsError);
    expect(error.code).toBe('ATLAS_CONTENT_UNREADABLE');
    expect(error.unreadable_keys).toEqual([KEY]);
    expect(error.partial_result).toEqual([{ snapshotId: 'ct-snap-1-abc', totalContacts: 3 }]);
  });

  it('quarantines a key and returns the result in camelCase', async () => {
    quarantine.quarantine_unreadable_object.mockResolvedValue({
      storage_key: KEY,
      quarantine_key: `_quarantine/${KEY}`,
      kind: 'manifest',
      reason: 'The contacts manifest does not decrypt or parse',
    });

    const result = await create_contacts_api('tenant-1', container).quarantine(KEY);

    expect(quarantine.quarantine_unreadable_object).toHaveBeenCalledWith('tenant-1', KEY);
    expect(result).toEqual({
      storageKey: KEY,
      quarantineKey: `_quarantine/${KEY}`,
      kind: 'manifest',
      reason: 'The contacts manifest does not decrypt or parse',
    });
  });
});
