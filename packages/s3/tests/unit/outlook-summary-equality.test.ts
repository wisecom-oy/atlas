import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type {
  AttachmentEntry,
  Manifest,
  ManifestEntry,
  MailboxSummary,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { CatalogService } from '@wisecom/atlas-core/services/catalog/catalog.service';
import { merge_snapshot_entries } from '@wisecom/atlas-core/services/shared/manifest-entry-merger';
import { StatsService } from '@wisecom/atlas-core/services/stats/stats.service';
import {
  aggregate_bucket_stats,
  aggregate_mailbox_stats,
} from '@wisecom/atlas-core/services/stats/stats-aggregator';
import { outlook_summary_key } from '@/adapters/outlook-snapshot-summary-layout';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER_A = '00000000-0000-0000-0000-00000000aaaa';
const OWNER_B = '00000000-0000-0000-0000-00000000bbbb';

function attachment(size_bytes: number): AttachmentEntry {
  return {
    attachment_id: `att-${size_bytes}`,
    name: 'file.pdf',
    content_type: 'application/pdf',
    size_bytes,
    storage_key: `att-key-${size_bytes}`,
    checksum: 'c',
    is_inline: false,
  };
}

function entry(
  object_id: string,
  size_bytes: number,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    object_id,
    storage_key: `key-${object_id}`,
    checksum: `sum-${object_id}`,
    size_bytes,
    ...extra,
  };
}

function manifest(
  owner_id: string,
  snapshot_id: string,
  created_at: string,
  entries: ManifestEntry[],
  extra: Partial<Manifest> = {},
): Manifest {
  const total_size_bytes = entries.reduce(
    (sum, e) =>
      sum + e.size_bytes + (e.attachments ?? []).reduce((a, att) => a + att.size_bytes, 0),
    0,
  );
  return {
    id: `id-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: entries.length,
    total_size_bytes,
    delta_links: {},
    id_format: 'immutable',
    entries,
    ...extra,
  };
}

/**
 * Two mailboxes with overlapping IDs, a re-captured message, removals that hide older entries
 * (one of them a quiet run with no entries), attachments, a folderless entry, and purposes.
 */
function save_fixture_manifests(): Manifest[] {
  return [
    manifest(
      OWNER_A,
      'a1',
      '2026-03-01T10:00:00Z',
      [
        entry('m1', 100, { folder_id: 'inbox', attachments: [attachment(40), attachment(10)] }),
        entry('m2', 200, { folder_id: 'inbox' }),
        entry('m3', 50, { folder_id: 'sent', attachments: [attachment(30)] }),
      ],
      { owner_email: 'alice@example.com', mailbox_purpose: 'user' },
    ),
    manifest(
      OWNER_A,
      'a2',
      '2026-03-05T10:00:00Z',
      [entry('m2', 210, { folder_id: 'sent' }), entry('m4', 80, { folder_id: 'inbox' })],
      { removed_object_ids: ['m1'] },
    ),
    manifest(OWNER_A, 'a3', '2026-03-09T10:00:00Z', [entry('m5', 10)], {
      removed_object_ids: ['m3', 'gone-id'],
    }),
    manifest(OWNER_A, 'a4', '2026-03-12T10:00:00Z', [], { removed_object_ids: ['m5'] }),
    manifest(
      OWNER_B,
      'b1',
      '2026-03-03T10:00:00Z',
      [entry('x1', 5), entry('x2', 7, { folder_id: 'inbox' })],
      { mailbox_purpose: 'shared' },
    ),
    manifest(OWNER_B, 'b2', '2026-03-04T10:00:00Z', [entry('x2', 20, { folder_id: 'inbox' })], {
      removed_object_ids: ['x1'],
    }),
  ];
}

interface Harness {
  readonly ctx: ReturnType<typeof in_memory_tenant_context>['ctx'];
  readonly raw_harness: ReturnType<typeof in_memory_tenant_context>;
  readonly repo: S3ManifestRepository;
  readonly catalog: CatalogService;
  readonly stats: StatsService;
  readonly manifest_reads: () => string[];
}

async function build_harness(manifests: readonly Manifest[]): Promise<Harness> {
  const raw_harness = in_memory_tenant_context();
  const repo = new S3ManifestRepository();
  for (const m of manifests) await repo.save(raw_harness.ctx, m);
  const factory = {
    create: async () => raw_harness.ctx,
    create_readonly: async () => raw_harness.ctx,
    create_storage_only: async () => raw_harness.ctx,
  } as unknown as TenantContextFactory;
  const catalog = new CatalogService(factory, repo);
  const stats = new StatsService(factory, repo, {} as never, {} as never);
  const get = vi.spyOn(raw_harness.ctx.storage, 'get');
  const manifest_reads = (): string[] =>
    get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('manifests/'));
  return { ctx: raw_harness.ctx, raw_harness, repo, catalog, stats, manifest_reads };
}

/** The mailbox overview as the decrypt path computed it before #726: a merged chain per owner. */
function reference_mailboxes(manifests: readonly Manifest[]): MailboxSummary[] {
  const by_owner = new Map<string, Manifest[]>();
  for (const m of manifests) by_owner.set(m.owner_id, [...(by_owner.get(m.owner_id) ?? []), m]);
  return [...by_owner]
    .map(([owner_id, list]) => {
      const newest_first = [...list].sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime(),
      );
      const purpose = newest_first.find((m) => m.mailbox_purpose)?.mailbox_purpose;
      const owner_email = newest_first.find((m) => m.owner_email)?.owner_email;
      return {
        owner_id,
        ...(owner_email ? { owner_email } : {}),
        ...(purpose ? { mailbox_purpose: purpose } : {}),
        snapshot_count: newest_first.length,
        total_objects: merge_snapshot_entries(newest_first).length,
        total_size_bytes: newest_first.reduce((sum, m) => sum + m.total_size_bytes, 0),
        last_backup_at: newest_first[0]!.created_at,
      };
    })
    .sort((a, b) => a.owner_id.localeCompare(b.owner_id));
}

/** Decrypts every manifest and computes the answers the summary path must reproduce. */
async function decrypt_path_answers(h: Harness) {
  const all = await h.repo.list_all_manifests(h.ctx);
  return {
    mailboxes: reference_mailboxes(all),
    bucket: aggregate_bucket_stats('tenant-1', all),
    mailbox_a: aggregate_mailbox_stats(OWNER_A, await h.repo.list_by_owner(h.ctx, OWNER_A)),
    mailbox_b: aggregate_mailbox_stats(OWNER_B, await h.repo.list_by_owner(h.ctx, OWNER_B)),
  };
}

/** Runs the summary path and checks it against the decrypt path, reading no manifest on the way. */
async function expect_summary_path_matches(h: Harness, expected_reads: number | 'none') {
  const expected = await decrypt_path_answers(h);
  vi.mocked(h.ctx.storage.get).mockClear();
  const mailboxes = await h.catalog.list_mailboxes('tenant-1');
  const bucket = await h.stats.get_bucket_stats('tenant-1');
  const mailbox_a = await h.stats.get_mailbox_stats('tenant-1', OWNER_A);
  const mailbox_b = await h.stats.get_mailbox_stats('tenant-1', OWNER_B);

  expect(mailboxes).toEqual(expected.mailboxes);
  expect({ ...bucket, aggregation_us: 0 }).toEqual(expected.bucket);
  expect({ ...mailbox_a, aggregation_us: 0 }).toEqual(expected.mailbox_a);
  expect({ ...mailbox_b, aggregation_us: 0 }).toEqual(expected.mailbox_b);
  if (expected_reads === 'none') {
    expect(h.manifest_reads()).toEqual([]);
  } else {
    expect(h.manifest_reads().length).toBeGreaterThanOrEqual(expected_reads);
  }
}

/** Rewrites every owner's stored summary document through `transform`, keeping it encrypted. */
function rewrite_summaries(
  h: Harness,
  transform: (rows: Record<string, unknown>[]) => unknown[],
): void {
  for (const owner of [OWNER_A, OWNER_B]) {
    const key = outlook_summary_key(owner);
    const doc = JSON.parse(h.ctx.decrypt(h.raw_harness.raw(key)!, key).toString('utf-8'));
    const body = { ...doc, snapshots: transform(doc.snapshots) };
    h.raw_harness.set_raw(key, h.ctx.encrypt(Buffer.from(JSON.stringify(body)), key));
  }
}

describe('Outlook summary path equals the decrypt path (#726)', () => {
  it('answers the overview and both stats views from the summary rows alone', async () => {
    const h = await build_harness(save_fixture_manifests());

    await expect_summary_path_matches(h, 'none');
  });

  it('answers the same when every owner summary document is missing', async () => {
    const h = await build_harness(save_fixture_manifests());
    h.raw_harness.remove(outlook_summary_key(OWNER_A));
    h.raw_harness.remove(outlook_summary_key(OWNER_B));

    await expect_summary_path_matches(h, 1);
  });

  it('answers the same from rows written before the aggregates, decrypting only those manifests', async () => {
    const h = await build_harness(save_fixture_manifests());
    rewrite_summaries(h, (rows) => rows.map(({ aggregates: _dropped, ...legacy }) => legacy));

    await expect_summary_path_matches(h, 1);
  });

  it('answers the same when the summary has a row for a manifest that is gone and lacks one for another', async () => {
    const save_manifests = save_fixture_manifests();
    const h = await build_harness(save_manifests);
    h.raw_harness.remove(`manifests/${OWNER_A}/a2.json`);
    rewrite_summaries(h, (rows) => rows.filter((row) => row.snapshot_id !== 'b1'));

    await expect_summary_path_matches(h, 1);
  });
});
