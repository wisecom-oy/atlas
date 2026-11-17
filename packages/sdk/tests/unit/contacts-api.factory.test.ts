/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import { camelize } from '@wisecom/atlas-types/public/case-convert';
import {
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_CATALOG_USE_CASE_TOKEN,
  CONTACTS_DELETION_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  CONTACTS_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { create_contacts_api } from '@/contacts-api.factory';

const TENANT_ID = 'tenant-1';
const OBJECT_ID = 'object-id-1';
const EMAIL = 'user@example.com';

const backup = { backup_contacts: vi.fn() };
const restore = { restore_contacts: vi.fn() };
const catalog = { list_contacts_snapshots: vi.fn(), list_contacts_snapshot_summaries: vi.fn() };
const verification = { verify_contacts_snapshot: vi.fn() };
const deletion = { delete_mailbox_data: vi.fn(), delete_snapshot: vi.fn() };
const identity = { resolve_user: vi.fn() };

const by_token = new Map<symbol, unknown>([
  [CONTACTS_BACKUP_USE_CASE_TOKEN, backup],
  [CONTACTS_RESTORE_USE_CASE_TOKEN, restore],
  [CONTACTS_CATALOG_USE_CASE_TOKEN, catalog],
  [CONTACTS_VERIFICATION_USE_CASE_TOKEN, verification],
  [CONTACTS_DELETION_USE_CASE_TOKEN, deletion],
  [USER_IDENTITY_RESOLVER_TOKEN, identity],
]);
const container = { get: (token: symbol) => by_token.get(token) } as unknown as Container;

describe('create_contacts_api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identity.resolve_user.mockResolvedValue({ object_id: OBJECT_ID });
  });

  it('backup resolves an email to its Entra object id and forwards options', async () => {
    const backup_result = { snapshot_id: 'ct-snap-1', contacts_written: 2 };
    backup.backup_contacts.mockResolvedValue(backup_result);

    const result = await create_contacts_api(TENANT_ID, container).backup(EMAIL, {
      forceFull: true,
    });

    expect(identity.resolve_user).toHaveBeenCalledWith(TENANT_ID, EMAIL);
    expect(backup.backup_contacts).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, { force_full: true });
    expect(result).toEqual(camelize(backup_result));
  });

  it('passes object ids through without an identity lookup', async () => {
    backup.backup_contacts.mockResolvedValue({});

    await create_contacts_api(TENANT_ID, container).backup(OBJECT_ID);

    expect(identity.resolve_user).not.toHaveBeenCalled();
    expect(backup.backup_contacts).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, undefined);
  });

  it('restore resolves the target mailbox and forwards the snapshot id', async () => {
    restore.restore_contacts.mockResolvedValue({});

    await create_contacts_api(TENANT_ID, container).restore(OBJECT_ID, {
      snapshotId: 'ct-snap-1',
      targetMailboxId: EMAIL,
    });

    expect(restore.restore_contacts).toHaveBeenCalledWith(
      TENANT_ID,
      OBJECT_ID,
      expect.objectContaining({ snapshot_id: 'ct-snap-1', target_mailbox_id: OBJECT_ID }),
    );
  });

  it('verify, listSnapshots, deleteMailboxData and deleteSnapshot bind tenant and object id', async () => {
    verification.verify_contacts_snapshot.mockResolvedValue({});
    catalog.list_contacts_snapshots.mockResolvedValue([]);
    deletion.delete_mailbox_data.mockResolvedValue({});
    deletion.delete_snapshot.mockResolvedValue({});
    const contacts = create_contacts_api(TENANT_ID, container);

    await contacts.verify(OBJECT_ID, 'ct-snap-1');
    await contacts.listSnapshots(OBJECT_ID);
    await contacts.deleteMailboxData(OBJECT_ID);
    await contacts.deleteSnapshot(OBJECT_ID, 'ct-snap-1');

    expect(verification.verify_contacts_snapshot).toHaveBeenCalledWith(
      TENANT_ID,
      OBJECT_ID,
      'ct-snap-1',
      undefined,
    );
    expect(catalog.list_contacts_snapshots).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
    expect(deletion.delete_mailbox_data).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
    expect(deletion.delete_snapshot).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, 'ct-snap-1');
  });

  it('listSnapshotSummaries reads the summary index for the resolved mailbox and camelizes it', async () => {
    catalog.list_contacts_snapshot_summaries.mockResolvedValue([
      { snapshot_id: 'ct-snap-1', total_contacts: 3, mailbox_id: OBJECT_ID },
    ]);
    const contacts = create_contacts_api(TENANT_ID, container);

    const summaries = await contacts.listSnapshotSummaries(OBJECT_ID);

    expect(catalog.list_contacts_snapshot_summaries).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
    expect(summaries).toEqual([
      { snapshotId: 'ct-snap-1', totalContacts: 3, mailboxId: OBJECT_ID },
    ]);
  });
});
