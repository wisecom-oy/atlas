import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveDeltaCursorRepository,
  OneDriveManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveStatusService } from '@/services/status/onedrive-status.service';

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const DELTA_LINK = 'https://graph.microsoft.com/v1.0/delta?token=abc';

function make_mocks() {
  const ctx = { storage: {}, destroy: vi.fn() } as unknown as TenantContext;

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  };

  const connector: OneDriveConnector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'OneDrive' }]),
    fetch_delta: vi.fn().mockResolvedValue({ items: [], delta_link: 'next-link' }),
  } as unknown as OneDriveConnector;

  const manifests: OneDriveManifestRepository = {
    find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveManifestRepository;

  const cursors: OneDriveDeltaCursorRepository = {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(),
  } as unknown as OneDriveDeltaCursorRepository;

  return { ctx, tenant_factory, connector, manifests, cursors };
}

/** A saved cursor holding a delta link for each named drive. */
const cursor_for = (...drive_ids: string[]) => ({
  owner_id: OWNER_ID,
  delta_link_by_drive: Object.fromEntries(drive_ids.map((id) => [id, DELTA_LINK])),
});

describe('OneDriveStatusService', () => {
  let service: OneDriveStatusService;
  let mocks: ReturnType<typeof make_mocks>;

  beforeEach(() => {
    mocks = make_mocks();
    service = new OneDriveStatusService(
      mocks.tenant_factory,
      mocks.connector,
      mocks.manifests,
      mocks.cursors,
    );
  });

  const check = (owner = OWNER_ID) => service.check_onedrive_status(TENANT_ID, owner);

  it('reports no previous backup and no pending changes for an unbacked owner', async () => {
    const result = await check();

    expect(result.last_backup_at).toBeUndefined();
    expect(result.last_snapshot_id).toBeUndefined();
    expect(result.total_pending_changes).toBe(0);
    expect(result.drives[0]).toMatchObject({ has_backup: false, is_up_to_date: false });
    // No saved delta link, so nothing to peek at: Graph is not called.
    expect(mocks.connector.fetch_delta).not.toHaveBeenCalled();
  });

  it('is not up to date when a drive has never been backed up, even with zero pending', async () => {
    const result = await check();

    // Zero pending changes on a drive that was never captured means "unknown",
    // not "current". Reporting it as current would hide a missing drive.
    expect(result.total_pending_changes).toBe(0);
    expect(result.is_up_to_date).toBe(false);
  });

  it('reports the previous backup from the newest manifest', async () => {
    vi.mocked(mocks.manifests.find_latest_by_owner).mockResolvedValue({
      snapshot_id: 'snap-7',
      created_at: new Date('2026-03-02T00:00:00Z'),
    } as never);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1') as never);

    const result = await check();

    expect(result.last_snapshot_id).toBe('snap-7');
    expect(result.last_backup_at?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(result.is_up_to_date).toBe(true);
  });

  it('sums pending changes across every drive', async () => {
    vi.mocked(mocks.connector.list_drives).mockResolvedValue([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
      { drive_id: 'drive-2', drive_name: 'Second' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1', 'drive-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockResolvedValueOnce({ items: [{}, {}], delta_link: 'a' } as never)
      .mockResolvedValueOnce({ items: [{}, {}, {}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.total_drives).toBe(2);
    expect(result.total_pending_changes).toBe(5);
    expect(result.drives.map((d) => d.pending_changes)).toEqual([2, 3]);
  });

  it('is not up to date when any single drive has pending changes', async () => {
    vi.mocked(mocks.connector.list_drives).mockResolvedValue([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
      { drive_id: 'drive-2', drive_name: 'Second' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1', 'drive-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockResolvedValueOnce({ items: [], delta_link: 'a' } as never)
      .mockResolvedValueOnce({ items: [{}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.is_up_to_date).toBe(false);
    expect(result.drives.map((d) => d.is_up_to_date)).toEqual([true, false]);
  });

  it('never writes the saved cursor while peeking', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1') as never);
    vi.mocked(mocks.connector.fetch_delta).mockResolvedValue({
      items: [{}, {}],
      delta_link: 'advanced-link',
    } as never);

    await check();

    // Consuming the delta link here would make the next real backup skip the
    // very changes status just reported as pending.
    expect(mocks.cursors.save).not.toHaveBeenCalled();
  });

  it('reads the tenant context read-only and destroys it', async () => {
    await check();

    expect(mocks.tenant_factory.create_readonly).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.tenant_factory.create).not.toHaveBeenCalled();
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the context when the connector throws', async () => {
    vi.mocked(mocks.connector.list_drives).mockRejectedValue(new Error('graph unavailable'));

    await expect(check()).rejects.toThrow('graph unavailable');
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a drive whose peek failed as backed up but not up to date', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1') as never);
    vi.mocked(mocks.connector.fetch_delta).mockRejectedValue(new Error('throttled'));

    const result = await check();

    // A failed peek is unknown, not clean: the drive has a cursor so it has a
    // backup, but pending changes could not be counted.
    expect(result.drives[0]).toMatchObject({
      has_backup: true,
      pending_changes: 0,
      is_up_to_date: false,
    });
  });

  it('currently rolls a failed peek up as up to date, which is wrong', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1') as never);
    vi.mocked(mocks.connector.fetch_delta).mockRejectedValue(new Error('throttled'));

    const result = await check();

    // Pins today's behaviour, it is not an endorsement. The roll-up is
    // `total_pending === 0 && every(has_backup)`, which ignores each drive's
    // own `is_up_to_date`, so a throttled peek counts as clean. Expected to
    // flip to false when that is fixed; see the follow-up issue.
    expect(result.drives[0]?.is_up_to_date).toBe(false);
    expect(result.is_up_to_date).toBe(true);
  });

  it('does not fail the whole check when one drive of several fails to peek', async () => {
    vi.mocked(mocks.connector.list_drives).mockResolvedValue([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
      { drive_id: 'drive-2', drive_name: 'Second' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('drive-1', 'drive-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ items: [{}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.drives).toHaveLength(2);
    expect(result.total_pending_changes).toBe(1);
  });

  it('normalises the owner id before reading storage or Graph', async () => {
    const result = await check(OWNER_ID.toUpperCase());

    // The cursor and manifest prefixes are case-sensitive in S3 (issue #38).
    expect(result.owner_id).toBe(OWNER_ID);
    expect(mocks.cursors.load).toHaveBeenCalledWith(expect.anything(), OWNER_ID);
    expect(mocks.connector.list_drives).toHaveBeenCalledWith(TENANT_ID, OWNER_ID);
  });

  it('reports an owner with no drives as having nothing pending', async () => {
    vi.mocked(mocks.connector.list_drives).mockResolvedValue([]);

    const result = await check();

    expect(result.total_drives).toBe(0);
    expect(result.drives).toEqual([]);
    // `every` on an empty list is true, so this is up to date by definition.
    expect(result.is_up_to_date).toBe(true);
  });
});
