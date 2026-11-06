/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import { camelize } from '@wisecom/atlas-types/public/case-convert';
import {
  CALENDAR_BACKUP_USE_CASE_TOKEN,
  CALENDAR_CATALOG_USE_CASE_TOKEN,
  CALENDAR_DELETION_USE_CASE_TOKEN,
  CALENDAR_RESTORE_USE_CASE_TOKEN,
  CALENDAR_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { create_calendar_api } from '@/calendar-api.factory';

const TENANT_ID = 'tenant-1';
const OBJECT_ID = 'object-id-1';
const EMAIL = 'user@example.com';

const backup = { backup_calendar: vi.fn() };
const restore = { restore_calendar: vi.fn() };
const catalog = { list_calendar_snapshots: vi.fn() };
const verification = { verify_calendar_snapshot: vi.fn() };
const deletion = { delete_mailbox_data: vi.fn(), delete_snapshot: vi.fn() };
const identity = { resolve_user: vi.fn() };

const by_token = new Map<symbol, unknown>([
  [CALENDAR_BACKUP_USE_CASE_TOKEN, backup],
  [CALENDAR_RESTORE_USE_CASE_TOKEN, restore],
  [CALENDAR_CATALOG_USE_CASE_TOKEN, catalog],
  [CALENDAR_VERIFICATION_USE_CASE_TOKEN, verification],
  [CALENDAR_DELETION_USE_CASE_TOKEN, deletion],
  [USER_IDENTITY_RESOLVER_TOKEN, identity],
]);
const container = { get: (token: symbol) => by_token.get(token) } as unknown as Container;

describe('create_calendar_api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identity.resolve_user.mockResolvedValue({ object_id: OBJECT_ID });
  });

  it('backup resolves an email to its Entra object id and forwards options', async () => {
    const backup_result = { snapshot_id: 'cal-snap-1', events_changed: 2 };
    backup.backup_calendar.mockResolvedValue(backup_result);

    const result = await create_calendar_api(TENANT_ID, container).backup(EMAIL, {
      forceFull: true,
    });

    expect(identity.resolve_user).toHaveBeenCalledWith(TENANT_ID, EMAIL);
    expect(backup.backup_calendar).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, { force_full: true });
    expect(result).toEqual(camelize(backup_result));
  });

  it('passes object ids through without an identity lookup', async () => {
    backup.backup_calendar.mockResolvedValue({});

    await create_calendar_api(TENANT_ID, container).backup(OBJECT_ID);

    expect(identity.resolve_user).not.toHaveBeenCalled();
    expect(backup.backup_calendar).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, undefined);
  });

  it('restore resolves the target mailbox and forwards the snapshot id', async () => {
    restore.restore_calendar.mockResolvedValue({});

    await create_calendar_api(TENANT_ID, container).restore(OBJECT_ID, {
      snapshotId: 'cal-snap-1',
      targetMailboxId: EMAIL,
    });

    expect(restore.restore_calendar).toHaveBeenCalledWith(
      TENANT_ID,
      OBJECT_ID,
      expect.objectContaining({ snapshot_id: 'cal-snap-1', target_mailbox_id: OBJECT_ID }),
    );
  });

  it('verify, listSnapshots, deleteMailboxData and deleteSnapshot bind tenant and object id', async () => {
    verification.verify_calendar_snapshot.mockResolvedValue({});
    catalog.list_calendar_snapshots.mockResolvedValue([]);
    deletion.delete_mailbox_data.mockResolvedValue({});
    deletion.delete_snapshot.mockResolvedValue({});
    const calendar = create_calendar_api(TENANT_ID, container);

    await calendar.verify(OBJECT_ID, 'cal-snap-1');
    await calendar.listSnapshots(OBJECT_ID);
    await calendar.deleteMailboxData(OBJECT_ID);
    await calendar.deleteSnapshot(OBJECT_ID, 'cal-snap-1');

    expect(verification.verify_calendar_snapshot).toHaveBeenCalledWith(
      TENANT_ID,
      OBJECT_ID,
      'cal-snap-1',
      undefined,
    );
    expect(catalog.list_calendar_snapshots).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
    expect(deletion.delete_mailbox_data).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID);
    expect(deletion.delete_snapshot).toHaveBeenCalledWith(TENANT_ID, OBJECT_ID, 'cal-snap-1');
  });
});
