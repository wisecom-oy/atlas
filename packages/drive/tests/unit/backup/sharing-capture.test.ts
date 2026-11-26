import { describe, expect, it, vi } from 'vitest';
import type { DrivePermission } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import {
  DriveSharingCapture,
  is_permission_candidate,
  record_file_permission_digest,
  with_captured_permissions,
} from '@/backup/sharing-capture';
import { digest_permissions } from '@/permissions/permission-digest';

const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'user', id: 'jane-id' } };

function item(item_id: string, fields: Partial<DriveDeltaItem> = {}): DriveDeltaItem {
  return {
    item_id,
    drive_id: 'drive-1',
    kind: 'file',
    file_name: `${item_id}.txt`,
    parent_path: '/',
    size_bytes: 1,
    deleted: false,
    ...fields,
  };
}

function connector(permissions: Record<string, DrivePermission[]>) {
  return {
    fetch_item_permissions: vi.fn(async (_drive: string, ids: readonly string[]) => {
      const found = new Map<string, DrivePermission[]>();
      for (const id of ids) if (permissions[id]) found.set(id, permissions[id]!);
      return found;
    }),
  };
}

describe('is_permission_candidate (#580)', () => {
  it('reads items with a shared facet, or that had permissions last run', () => {
    const tracking = { permission_digest_by_item_id: { known: 'digest' } };
    expect(is_permission_candidate(item('a', { sharing_facet: true }), tracking)).toBe(true);
    expect(is_permission_candidate(item('known'), tracking)).toBe(true);
    expect(is_permission_candidate(item('plain'), tracking)).toBe(false);
  });

  it('never reads deleted items or the root', () => {
    const tracking = {};
    const shared = { sharing_facet: true };
    expect(is_permission_candidate(item('d', { ...shared, deleted: true }), tracking)).toBe(false);
    expect(is_permission_candidate(item('r', { ...shared, is_root: true }), tracking)).toBe(false);
  });
});

describe('DriveSharingCapture (#580)', () => {
  it('reads only candidates, in one call per drive', async () => {
    const graph = connector({ a: [GRANT] });
    const capture = new DriveSharingCapture(graph);

    await capture.prefetch('drive-1', [item('a', { sharing_facet: true }), item('b')], {});

    expect(graph.fetch_item_permissions).toHaveBeenCalledTimes(1);
    expect(graph.fetch_item_permissions).toHaveBeenCalledWith('drive-1', ['a']);
  });

  it('makes no Graph call for a run without shared items', async () => {
    const graph = connector({});
    const capture = new DriveSharingCapture(graph);

    await capture.prefetch('drive-1', [item('a'), item('b')], {});
    const seen = await capture.observe(item('a'), {});

    expect(graph.fetch_item_permissions).not.toHaveBeenCalled();
    expect(seen).toEqual({ read: false, failed: false });
    expect(capture.has_failed_read('a')).toBe(false);
  });

  it('reports a change against the digest the cursor recorded', async () => {
    const graph = connector({ a: [GRANT] });
    const capture = new DriveSharingCapture(graph);
    const shared = item('a', { sharing_facet: true });

    const first = await capture.observe(shared, {});
    const again = await capture.observe(shared, {
      permission_digest_by_item_id: { a: digest_permissions([GRANT]) },
    });

    expect(first).toMatchObject({ read: true, changed: true, permissions: [GRANT] });
    expect(again).toMatchObject({ read: true, changed: false });
  });

  it('reads an item that was not prefetched on its own, and a failed read only once', async () => {
    const graph = connector({});
    const capture = new DriveSharingCapture(graph);
    const shared = item('gone', { sharing_facet: true });

    expect(await capture.observe(shared, {})).toEqual({ read: false, failed: true });
    expect(await capture.observe(shared, {})).toEqual({ read: false, failed: true });
    expect(graph.fetch_item_permissions).toHaveBeenCalledTimes(1);
  });

  it('remembers a candidate whose read failed, and only that one (#856)', async () => {
    const graph = connector({ read: [GRANT] });
    const capture = new DriveSharingCapture(graph);
    const items = [
      item('read', { sharing_facet: true }),
      item('refused', { sharing_facet: true }),
      item('plain'),
    ];

    await capture.prefetch('drive-1', items, {});
    for (const each of items) await capture.observe(each, {});

    expect(capture.has_failed_read('read')).toBe(false);
    expect(capture.has_failed_read('refused')).toBe(true);
    expect(capture.has_failed_read('plain')).toBe(false);
  });
});

describe('recording what a file entry holds', () => {
  it('stores the digest when the read found permissions and clears it when it found none', () => {
    const tracking = { permission_digest_by_item_id: { a: 'old', b: 'old' } };
    record_file_permission_digest(tracking, 'a', {
      read: true,
      permissions: [GRANT],
      digest: 'new',
      changed: true,
    });
    record_file_permission_digest(tracking, 'b', {
      read: true,
      permissions: [],
      digest: 'empty',
      changed: true,
    });
    expect(tracking.permission_digest_by_item_id).toEqual({ a: 'new' });
  });

  it('keeps the digest when the read failed (#856)', () => {
    const tracking = { permission_digest_by_item_id: { a: 'old' } };
    record_file_permission_digest(tracking, 'a', { read: false, failed: true });
    expect(tracking.permission_digest_by_item_id).toEqual({ a: 'old' });
  });

  it('attaches permissions only when some were read', () => {
    const base = { file_id: 'a' };
    expect(with_captured_permissions(base, { read: false, failed: true })).toBe(base);
    expect(
      with_captured_permissions(base, { read: true, permissions: [], digest: 'x', changed: true }),
    ).toBe(base);
    expect(
      with_captured_permissions(base, {
        read: true,
        permissions: [GRANT],
        digest: 'x',
        changed: true,
      }),
    ).toEqual({ file_id: 'a', permissions: [GRANT] });
  });
});
