import { vi } from 'vitest';
import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { read_encrypted_json } from '@/services/shared/stored-json-reader';
import {
  stored_count,
  type SnapshotSummaryLayout,
} from '@/services/shared/snapshot-summary-layout';

/** A minimal workload manifest: what the summary machinery needs and nothing more. */
export interface FixtureManifest {
  readonly owner_id: string;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly total_size_bytes: number;
  readonly entries: readonly string[];
}

export interface FixtureSummary extends SnapshotSummary {
  readonly owner_id: string;
  readonly total_files: number;
}

export const OWNER = 'owner-1';
export const OTHER_OWNER = 'owner-2';

export function manifest_key(owner_id: string, snapshot_id: string): string {
  return `fixture/manifests/${owner_id}/${snapshot_id}.json`;
}

export function summary_key(owner_id: string): string {
  return `fixture/_meta/${owner_id}/snapshots.json`;
}

/** Reads a fixture manifest the way a workload's reader would, rejecting a mismatched body. */
async function read_manifest(
  ctx: TenantContext,
  key: string,
): Promise<FixtureManifest | undefined> {
  const parsed = (await read_encrypted_json(ctx, key, 'fixture manifest')) as
    (Omit<FixtureManifest, 'created_at'> & { created_at: string }) | undefined;
  if (parsed === undefined) return undefined;
  if (manifest_key(parsed.owner_id, parsed.snapshot_id) !== key) {
    throw new UnreadableObjectsError('mismatched fixture manifest', [key]);
  }
  return { ...parsed, created_at: new Date(parsed.created_at) };
}

export const LAYOUT: SnapshotSummaryLayout<FixtureManifest, FixtureSummary> = {
  label: 'Fixture',
  summary_key,
  manifest_prefix: (owner_id) => `fixture/manifests/${owner_id}/`,
  manifest_root_prefix: 'fixture/manifests/',
  manifest_key,
  read_manifest,
  summarize: (manifest, key) => ({
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: key,
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    owner_id: manifest.owner_id,
    total_files: manifest.entries.length,
  }),
  parse_details: (row, common) => {
    const total_files = stored_count(row, 'total_files');
    if (typeof row.owner_id !== 'string' || total_files === undefined) return undefined;
    return { ...common, owner_id: row.owner_id, total_files };
  },
};

export function fixture_manifest(epoch: number, owner_id = OWNER): FixtureManifest {
  return {
    owner_id,
    snapshot_id: `snap-${epoch}`,
    created_at: new Date(epoch),
    total_size_bytes: epoch,
    entries: ['a', 'b'],
  };
}

/** Stores a manifest without touching its owner's summary, as a pre-feature release would. */
export async function store_manifest_only(
  harness: InMemoryTenantContext,
  manifest: FixtureManifest,
): Promise<string> {
  const key = manifest_key(manifest.owner_id, manifest.snapshot_id);
  await harness.ctx.storage.put(
    key,
    harness.ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key),
  );
  return key;
}

/** Flips one bit of a stored object so it fails its authentication tag. */
export function damage(harness: InMemoryTenantContext, key: string): void {
  const bytes = Buffer.from(harness.raw(key)!);
  bytes[bytes.length - 1]! ^= 0x80;
  harness.set_raw(key, bytes);
}

/** An in-memory tenant whose `get` calls on manifest keys are counted. */
export function counting_harness(): {
  harness: InMemoryTenantContext;
  manifest_reads: () => string[];
} {
  const harness = in_memory_tenant_context();
  const get = vi.spyOn(harness.ctx.storage, 'get');
  const manifest_reads = (): string[] =>
    get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('fixture/manifests/'));
  return { harness, manifest_reads };
}
