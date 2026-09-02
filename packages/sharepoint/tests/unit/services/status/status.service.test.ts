import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaCursorRepository,
  SharePointManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { SharePointStatusService } from '@/services/status/status.service';

const TENANT_ID = 'tenant-1';
const SITE_ID =
  'contoso.sharepoint.com,00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002';
const DELTA_LINK = 'https://graph.microsoft.com/v1.0/delta?token=abc';

function make_mocks() {
  const ctx = { storage: {}, destroy: vi.fn() } as unknown as TenantContext;

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  };

  const connector: SharePointSiteConnector = {
    list_document_libraries: vi
      .fn()
      .mockResolvedValue([{ drive_id: 'library-1', drive_name: 'Documents' }]),
    fetch_delta: vi.fn().mockResolvedValue({ items: [], delta_link: 'next-link' }),
  } as unknown as SharePointSiteConnector;

  const manifests: SharePointManifestRepository = {
    find_latest_by_site: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharePointManifestRepository;

  const cursors: SharePointDeltaCursorRepository = {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(),
  } as unknown as SharePointDeltaCursorRepository;

  return { ctx, tenant_factory, connector, manifests, cursors };
}

/** A saved cursor holding a delta link for each named drive. */
const cursor_for = (...library_ids: string[]) => ({
  site_id: SITE_ID,
  delta_link_by_drive: Object.fromEntries(library_ids.map((id) => [id, DELTA_LINK])),
});

describe('SharePointStatusService', () => {
  let service: SharePointStatusService;
  let mocks: ReturnType<typeof make_mocks>;

  beforeEach(() => {
    mocks = make_mocks();
    service = new SharePointStatusService(
      mocks.tenant_factory,
      mocks.connector,
      mocks.manifests,
      mocks.cursors,
    );
  });

  const check = (site = SITE_ID) => service.check_sharepoint_status(TENANT_ID, site);

  it('reports no previous backup and no pending changes for an unbacked site', async () => {
    const result = await check();

    expect(result.last_backup_at).toBeUndefined();
    expect(result.last_snapshot_id).toBeUndefined();
    expect(result.total_pending_changes).toBe(0);
    expect(result.libraries[0]).toMatchObject({ has_backup: false, is_up_to_date: false });
    // No saved delta link, so nothing to peek at: Graph is not called.
    expect(mocks.connector.fetch_delta).not.toHaveBeenCalled();
  });

  it('is not up to date when a library has never been backed up, even with zero pending', async () => {
    const result = await check();

    // Zero pending changes on a library that was never captured means "unknown",
    // not "current". Reporting it as current would hide a missing library.
    expect(result.total_pending_changes).toBe(0);
    expect(result.is_up_to_date).toBe(false);
  });

  it('reports the previous backup from the newest manifest', async () => {
    vi.mocked(mocks.manifests.find_latest_by_site).mockResolvedValue({
      snapshot_id: 'snap-7',
      created_at: new Date('2026-03-02T00:00:00Z'),
    } as never);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1') as never);

    const result = await check();

    expect(result.last_snapshot_id).toBe('snap-7');
    expect(result.last_backup_at?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(result.is_up_to_date).toBe(true);
  });

  it('sums pending changes across every library', async () => {
    vi.mocked(mocks.connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'library-1', drive_name: 'Documents' },
      { drive_id: 'library-2', drive_name: 'Shared Documents' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1', 'library-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockResolvedValueOnce({ items: [{}, {}], delta_link: 'a' } as never)
      .mockResolvedValueOnce({ items: [{}, {}, {}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.total_libraries).toBe(2);
    expect(result.total_pending_changes).toBe(5);
    expect(result.libraries.map((d) => d.pending_changes)).toEqual([2, 3]);
  });

  it('is not up to date when any single library has pending changes', async () => {
    vi.mocked(mocks.connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'library-1', drive_name: 'Documents' },
      { drive_id: 'library-2', drive_name: 'Shared Documents' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1', 'library-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockResolvedValueOnce({ items: [], delta_link: 'a' } as never)
      .mockResolvedValueOnce({ items: [{}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.is_up_to_date).toBe(false);
    expect(result.libraries.map((d) => d.is_up_to_date)).toEqual([true, false]);
  });

  it('never writes the saved cursor while peeking', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1') as never);
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
    vi.mocked(mocks.connector.list_document_libraries).mockRejectedValue(
      new Error('graph unavailable'),
    );

    await expect(check()).rejects.toThrow('graph unavailable');
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a library whose peek failed as backed up but not up to date', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1') as never);
    vi.mocked(mocks.connector.fetch_delta).mockRejectedValue(new Error('throttled'));

    const result = await check();

    // A failed peek is unknown, not clean: the library has a cursor so it has a
    // backup, but pending changes could not be counted.
    expect(result.libraries[0]).toMatchObject({
      has_backup: true,
      pending_changes: 0,
      is_up_to_date: false,
    });
  });

  it('does not report the site as up to date when a peek failed (issue #298)', async () => {
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1') as never);
    vi.mocked(mocks.connector.fetch_delta).mockRejectedValue(new Error('throttled'));

    const result = await check();

    // The roll-up reads each library's own flag. A throttled peek reports zero pending and
    // `has_backup: true`, so the old `total_pending === 0 && every(has_backup)` called it clean.
    expect(result.libraries[0]?.is_up_to_date).toBe(false);
    expect(result.is_up_to_date).toBe(false);
  });

  it('does not report the site as up to date when one library of several failed', async () => {
    vi.mocked(mocks.connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'library-1', drive_name: 'Documents' },
      { drive_id: 'library-2', drive_name: 'Shared Documents' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1', 'library-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ items: [], delta_link: 'b' } as never);

    const result = await check();

    // The clean second library must not mask the first: total pending is still zero here.
    expect(result.total_pending_changes).toBe(0);
    expect(result.is_up_to_date).toBe(false);
  });

  it('does not fail the whole check when one library of several fails to peek', async () => {
    vi.mocked(mocks.connector.list_document_libraries).mockResolvedValue([
      { drive_id: 'library-1', drive_name: 'Documents' },
      { drive_id: 'library-2', drive_name: 'Shared Documents' },
    ]);
    vi.mocked(mocks.cursors.load).mockResolvedValue(cursor_for('library-1', 'library-2') as never);
    vi.mocked(mocks.connector.fetch_delta)
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ items: [{}], delta_link: 'b' } as never);

    const result = await check();

    expect(result.libraries).toHaveLength(2);
    expect(result.total_pending_changes).toBe(1);
  });

  it('normalises the site id before reading storage or Graph', async () => {
    const result = await check(SITE_ID.toUpperCase());

    // The cursor and manifest prefixes are case-sensitive in S3 (issue #38).
    expect(result.site_id).toBe(SITE_ID);
    expect(mocks.cursors.load).toHaveBeenCalledWith(expect.anything(), SITE_ID);
    expect(mocks.connector.list_document_libraries).toHaveBeenCalledWith(TENANT_ID, SITE_ID);
  });

  it('reports a site with no libraries as having nothing pending', async () => {
    vi.mocked(mocks.connector.list_document_libraries).mockResolvedValue([]);

    const result = await check();

    expect(result.total_libraries).toBe(0);
    expect(result.libraries).toEqual([]);
    // `every` on an empty list is true, so this is up to date by definition.
    expect(result.is_up_to_date).toBe(true);
  });
});
