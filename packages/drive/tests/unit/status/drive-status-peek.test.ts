import { describe, expect, it, vi } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type { FailedItemLedger, FailedItemRecord } from '@wisecom/atlas-types';
import { MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import {
  peek_drive_statuses,
  summarize_drive_statuses,
  type DriveStatusPeekInput,
} from '@/status/drive-status-peek';

const DRIVE = { drive_id: 'drive-1', drive_name: 'Documents' };

function delta_item(item_id: string, kind: 'file' | 'folder', deleted = false): DriveDeltaItem {
  return {
    item_id,
    drive_id: DRIVE.drive_id,
    kind,
    file_name: deleted ? '' : `${item_id}.txt`,
    parent_path: '/drive/root:',
    size_bytes: 1,
    deleted,
  };
}

function failure(item_id: string, drive_id = DRIVE.drive_id): FailedItemRecord {
  return {
    item_id,
    drive_id,
    name: `${item_id}.txt`,
    reason: 'HTTP 503',
    attempts: 1,
    first_failed_at: '2026-01-01T00:00:00.000Z',
    last_failed_at: '2026-01-01T00:00:00.000Z',
  };
}

function input(overrides: Partial<DriveStatusPeekInput> = {}): DriveStatusPeekInput {
  return {
    drives: [DRIVE],
    delta_link_by_drive: { [DRIVE.drive_id]: 'https://graph.example/delta?token=1' },
    previous_kind_by_file_id: {},
    failed_items: {},
    fetch_delta: vi.fn().mockResolvedValue({ items: [] }),
    item_label: 'library',
    ...overrides,
  };
}

describe('peek_drive_statuses', () => {
  it('counts files only, as backup does, so folders and the root are not pending (#630)', async () => {
    const items = [
      delta_item('root', 'folder'),
      delta_item('parent', 'folder'),
      delta_item('a', 'file'),
      delta_item('b', 'file'),
      delta_item('c', 'file'),
    ];
    const rows = await peek_drive_statuses(
      input({ fetch_delta: vi.fn().mockResolvedValue({ items }) }),
    );

    expect(rows[0]).toMatchObject({ pending_changes: 3, is_up_to_date: false });
  });

  it('does not count a deleted folder the cursor knows, which Graph reports as a file', async () => {
    const items = [delta_item('gone-folder', 'file', true), delta_item('gone-file', 'file', true)];
    const rows = await peek_drive_statuses(
      input({
        previous_kind_by_file_id: { 'gone-folder': 'folder', 'gone-file': 'file' },
        fetch_delta: vi.fn().mockResolvedValue({ items }),
      }),
    );

    expect(rows[0]?.pending_changes).toBe(1);
  });

  it('reports a drive with an empty delta but a non-empty ledger as not up to date (#630)', async () => {
    const failed_items: FailedItemLedger = { 'f-1': failure('f-1'), 'f-2': failure('f-2') };
    const rows = await peek_drive_statuses(input({ failed_items }));
    const summary = summarize_drive_statuses(rows, failed_items);

    expect(rows[0]).toMatchObject({ pending_changes: 0, failed_items: 2, is_up_to_date: false });
    expect(summary).toEqual({
      is_up_to_date: false,
      total_pending_changes: 0,
      total_failed_items: 2,
    });
  });

  it('counts ledger entries of a drive that is no longer listed in the total', async () => {
    const failed_items: FailedItemLedger = { 'f-1': failure('f-1', 'removed-drive') };
    const rows = await peek_drive_statuses(input({ failed_items }));

    expect(rows[0]).toMatchObject({ failed_items: 0, is_up_to_date: true });
    expect(summarize_drive_statuses(rows, failed_items).is_up_to_date).toBe(false);
  });

  it('rethrows an AuthError instead of reporting the drive as pending (#630)', async () => {
    const fetch_delta = vi.fn().mockRejectedValue(new AuthError('403 Forbidden'));

    await expect(peek_drive_statuses(input({ fetch_delta }))).rejects.toBeInstanceOf(AuthError);
  });

  it('rethrows a MailboxNotLicensedError', async () => {
    const fetch_delta = vi.fn().mockRejectedValue(new MailboxNotLicensedError('unlicensed'));

    await expect(peek_drive_statuses(input({ fetch_delta }))).rejects.toBeInstanceOf(
      MailboxNotLicensedError,
    );
  });

  it('turns the drive connectors MissingGraphPermissionsError (their 403) into an AuthError', async () => {
    const missing = new MissingGraphPermissionsError('Missing permissions: Sites.Read.All.');
    const fetch_delta = vi.fn().mockRejectedValue(missing);

    const err = await peek_drive_statuses(input({ fetch_delta })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).cause).toBe(missing);
  });

  it('turns an unclassified Graph 401 into an AuthError', async () => {
    const graph_401 = Object.assign(new Error('InvalidAuthenticationToken'), { statusCode: 401 });
    const fetch_delta = vi.fn().mockRejectedValue(graph_401);

    const err = await peek_drive_statuses(input({ fetch_delta })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).cause).toBe(graph_401);
  });

  it('records any other peek failure on the row with its error class', async () => {
    const fetch_delta = vi.fn().mockRejectedValue(new TypeError('socket hang up'));
    const rows = await peek_drive_statuses(input({ fetch_delta }));

    expect(rows[0]).toMatchObject({
      has_backup: true,
      pending_changes: 0,
      is_up_to_date: false,
      peek_error: 'TypeError: socket hang up',
    });
  });

  it('reports a drive with no saved delta link as never backed up, without calling Graph', async () => {
    const fetch_delta = vi.fn();
    const rows = await peek_drive_statuses(input({ delta_link_by_drive: {}, fetch_delta }));

    expect(rows[0]).toMatchObject({ has_backup: false, is_up_to_date: false });
    expect(fetch_delta).not.toHaveBeenCalled();
  });
});
