import { describe, expect, it, vi } from 'vitest';
import type { SharePointFileVersionIndex, SharePointFileVersionRecord } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import { S3SharePointFileVersionIndexRepository } from '@/adapters/s3-sharepoint-file-version-index-repository.adapter';

const SITE = 'site-1';

function make_version(
  overrides: Partial<SharePointFileVersionRecord> = {},
): SharePointFileVersionRecord {
  return {
    snapshot_id: 'snap-1',
    backup_at: '2026-01-01T00:00:00.000Z',
    drive_id: 'drive-1',
    file_name: 'report.xlsx',
    parent_path: '/Documents',
    size_bytes: 10,
    change_type: 'updated',
    ...overrides,
  } as SharePointFileVersionRecord;
}

/** Storage stub whose objects are plaintext JSON, matching the identity cipher below. */
function make_ctx(objects: Record<string, unknown>, get_error?: Record<string, Error>) {
  const put = vi.fn(async (key: string, data: Buffer) => {
    objects[key] = JSON.parse(data.toString('utf-8'));
  });
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      list: vi.fn(async (prefix: string) =>
        Object.keys(objects).filter((key) => key.startsWith(prefix)),
      ),
      get: vi.fn(async (key: string) => {
        const failure = get_error?.[key];
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

describe('S3SharePointFileVersionIndexRepository', () => {
  const repo = new S3SharePointFileVersionIndexRepository();

  it('writes one index object per run and nothing for an empty run', async () => {
    const { ctx, put, objects } = make_ctx({});
    const indexes: SharePointFileVersionIndex[] = [
      { file_id: 'file-a', site_id: SITE, versions: [make_version()] },
      { file_id: 'file-b', site_id: SITE, versions: [make_version()] },
    ];

    await repo.write_run_index(ctx, SITE, 'snap-1', indexes);
    await repo.write_run_index(ctx, SITE, 'snap-2', []);

    expect(put).toHaveBeenCalledTimes(1);
    expect(Object.keys(objects)).toEqual(['sharepoint/index/site-1/runs/snap-1.json']);
  });

  it('merges run shards with legacy per-file objects, oldest version first', async () => {
    const { ctx } = make_ctx({
      'sharepoint/index/site-1/files/file-a.json': {
        file_id: 'file-a',
        site_id: SITE,
        versions: [make_version({ snapshot_id: 'legacy', backup_at: '2025-01-01T00:00:00.000Z' })],
      },
      'sharepoint/index/site-1/runs/snap-2.json': {
        site_id: SITE,
        snapshot_id: 'snap-2',
        indexes: [
          {
            file_id: 'file-a',
            site_id: SITE,
            versions: [make_version({ snapshot_id: 'snap-2', backup_at: '2026-02-01T00:00:00Z' })],
          },
          { file_id: 'file-b', site_id: SITE, versions: [make_version()] },
        ],
      },
    });

    const indexes = await repo.list_by_site(ctx, SITE);

    const file_a = indexes.find((idx) => idx.file_id === 'file-a');
    expect(indexes.map((idx) => idx.file_id).sort()).toEqual(['file-a', 'file-b']);
    expect(file_a?.versions.map((v) => v.snapshot_id)).toEqual(['legacy', 'snap-2']);
  });

  it('collects known version ids across every index object', async () => {
    const { ctx } = make_ctx({
      'sharepoint/index/site-1/files/file-a.json': {
        file_id: 'file-a',
        site_id: SITE,
        versions: [make_version({ version_id: 'v1' })],
      },
      'sharepoint/index/site-1/runs/snap-2.json': {
        site_id: SITE,
        snapshot_id: 'snap-2',
        indexes: [
          {
            file_id: 'file-a',
            site_id: SITE,
            versions: [make_version({ version_id: 'v2' }), make_version()],
          },
        ],
      },
    });

    const known = await repo.load_known_version_ids(ctx, SITE);

    expect([...(known.get('file-a') ?? [])].sort()).toEqual(['v1', 'v2']);
  });

  it('propagates storage failures instead of reporting an empty history', async () => {
    const key = 'sharepoint/index/site-1/runs/snap-1.json';
    const { ctx } = make_ctx(
      { [key]: { site_id: SITE, snapshot_id: 'snap-1', indexes: [] } },
      { [key]: new Error('connection reset') },
    );

    await expect(repo.load_known_version_ids(ctx, SITE)).rejects.toThrow('connection reset');
  });

  it('skips an unparseable object but still returns the readable ones', async () => {
    const { ctx } = make_ctx({
      'sharepoint/index/site-1/runs/corrupt.json': 'not json {',
      'sharepoint/index/site-1/runs/snap-1.json': {
        site_id: SITE,
        snapshot_id: 'snap-1',
        indexes: [{ file_id: 'file-a', site_id: SITE, versions: [make_version()] }],
      },
    });

    const indexes = await repo.list_by_site(ctx, SITE);

    expect(indexes.map((idx) => idx.file_id)).toEqual(['file-a']);
  });
});
