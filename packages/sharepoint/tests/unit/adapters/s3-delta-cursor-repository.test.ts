import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaCursor, TenantContext } from '@wisecom/atlas-types';
import { S3SharePointDeltaCursorRepository } from '@/adapters/s3-sharepoint-delta-cursor-repository.adapter';

const SITE = 'site-1';
const CURSOR_KEY = 'sharepoint/_meta/site-1/delta.json';

function make_cursor(overrides: Partial<SharePointDeltaCursor> = {}): SharePointDeltaCursor {
  return {
    site_id: SITE,
    delta_link_by_drive: { 'drive-1': 'https://graph.microsoft.com/v1.0/delta?token=abc' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...overrides,
  } as SharePointDeltaCursor;
}

/** Storage stub holding plaintext JSON, matching the identity cipher below. */
function make_ctx(objects: Record<string, unknown> = {}, get_error: Record<string, Error> = {}) {
  const put = vi.fn(async (key: string, data: Buffer) => {
    objects[key] = JSON.parse(data.toString('utf-8'));
  });
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn(async (key: string) => key in objects),
      get: vi.fn(async (key: string) => {
        const failure = get_error[key];
        if (failure) throw failure;
        const value = objects[key];
        return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
      }),
      put,
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
  return { ctx, put, objects };
}

describe('S3SharePointDeltaCursorRepository', () => {
  const repo = new S3SharePointDeltaCursorRepository();

  it('saves the cursor under the site-scoped meta prefix', async () => {
    const { ctx, objects } = make_ctx();

    await repo.save(ctx, make_cursor());

    expect(Object.keys(objects)).toEqual([CURSOR_KEY]);
  });

  it('lower-cases the site segment so one site keeps one cursor', async () => {
    const { ctx, objects } = make_ctx();

    await repo.save(ctx, make_cursor({ site_id: 'Site-1' }));

    // Two spellings writing two cursors would re-enumerate the whole library
    // on the next run (issue #38).
    expect(Object.keys(objects)).toEqual([CURSOR_KEY]);
  });

  it('round-trips the delta links it saved', async () => {
    const { ctx } = make_ctx();

    await repo.save(ctx, make_cursor());
    const loaded = await repo.load(ctx, SITE);

    expect(loaded?.delta_link_by_drive).toEqual({
      'drive-1': 'https://graph.microsoft.com/v1.0/delta?token=abc',
    });
  });

  it('reports no cursor for a site that has never been backed up', async () => {
    const { ctx } = make_ctx();

    await expect(repo.load(ctx, SITE)).resolves.toBeUndefined();
    // Absence is decided by exists(), so no GET is spent on a first run.
    expect(ctx.storage.get).not.toHaveBeenCalled();
  });

  it('reads an undecryptable cursor as absent rather than throwing', async () => {
    const { ctx } = make_ctx(
      { [CURSOR_KEY]: make_cursor() },
      {
        [CURSOR_KEY]: new Error('unable to authenticate data'),
      },
    );

    // A full re-enumeration is recoverable; a crash on every run is not.
    await expect(repo.load(ctx, SITE)).resolves.toBeUndefined();
  });

  it('reads an unparseable cursor as absent rather than throwing', async () => {
    const { ctx } = make_ctx({ [CURSOR_KEY]: 'not-json' });

    await expect(repo.load(ctx, SITE)).resolves.toBeUndefined();
  });

  it('encrypts the cursor before it is stored', async () => {
    const encrypt = vi.fn((data: Buffer) => data);
    const { ctx } = make_ctx();
    (ctx as unknown as { encrypt: typeof encrypt }).encrypt = encrypt;

    await repo.save(ctx, make_cursor());

    // The cursor carries Graph delta tokens, which are bearer-equivalent.
    expect(encrypt).toHaveBeenCalledTimes(1);
  });
});
