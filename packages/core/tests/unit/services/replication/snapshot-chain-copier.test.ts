import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  copy_missing_chain_links,
  copy_order,
  type SnapshotChainCopyPlan,
} from '@/services/replication/snapshot-chain-copier';

/**
 * Issue #714. A snapshot is its manifest folded with every older manifest of its owner, so a
 * destination must never hold a newer manifest whose older links are missing. These pin the order
 * of the copy, the skip of what is already there, and the stop at the first failure.
 */
interface TestManifest {
  readonly snapshot_id: string;
  readonly owner_id: string;
  readonly created_at: Date;
}

function snapshot(owner_id: string, seconds: number): TestManifest {
  return {
    snapshot_id: `snap-${owner_id}-${seconds}`,
    owner_id,
    created_at: new Date(seconds * 1000),
  };
}

function key_of(manifest: TestManifest): string {
  return `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
}

/** A plan that writes the manifest, or fails one object for the snapshots named in `failing`. */
function plan_failing(
  failing: readonly string[] = [],
  copied: string[] = [],
): SnapshotChainCopyPlan<TestManifest> {
  return {
    manifest_key: key_of,
    owner_of: (manifest) => manifest.owner_id,
    copy: async (_source: TenantContext, dest: TenantContext, manifest, manifest_key) => {
      copied.push(manifest.snapshot_id);
      if (failing.includes(manifest.snapshot_id)) {
        return {
          objects_copied: 0,
          objects_skipped: 0,
          objects_failed: 1,
          bytes_copied: 0,
          errors: ['x: denied'],
        };
      }
      await dest.storage.put(manifest_key, Buffer.from(manifest.snapshot_id));
      return {
        objects_copied: 1,
        objects_skipped: 0,
        objects_failed: 0,
        bytes_copied: 1,
        errors: [],
      };
    },
  };
}

describe('copy_missing_chain_links', () => {
  const source = in_memory_tenant_context();

  it('copies oldest first whatever order the snapshots were listed in', async () => {
    const dest = in_memory_tenant_context();
    const copied: string[] = [];
    const chain = [snapshot('a', 3), snapshot('a', 1), snapshot('a', 2)];

    await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: chain,
      plan: plan_failing([], copied),
      dest_id: 'replica',
    });

    expect(copied).toEqual(['snap-a-1', 'snap-a-2', 'snap-a-3']);
  });

  it('leaves snapshots the destination already holds untouched', async () => {
    const dest = in_memory_tenant_context();
    const held = snapshot('a', 2);
    dest.set_raw(key_of(held), Buffer.from('original'));
    const copied: string[] = [];

    const outcome = await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: [snapshot('a', 1), held, snapshot('a', 3)],
      plan: plan_failing([], copied),
      dest_id: 'replica',
    });

    expect(copied).toEqual(['snap-a-1', 'snap-a-3']);
    expect(outcome.present.map((m) => m.snapshot_id)).toEqual(['snap-a-2']);
    expect(dest.raw(key_of(held))?.toString()).toBe('original');
  });

  it('writes no newer snapshot of an owner once an older one fails, and names what it left out', async () => {
    const dest = in_memory_tenant_context();
    const chain = [snapshot('a', 1), snapshot('a', 2), snapshot('a', 3), snapshot('a', 4)];

    const outcome = await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: chain,
      plan: plan_failing(['snap-a-2']),
      dest_id: 'replica',
    });

    expect(dest.keys()).toEqual(['manifests/a/snap-a-1.json']);
    expect(outcome.not_copied.map((m) => m.snapshot_id)).toEqual(['snap-a-3', 'snap-a-4']);
    const failed = outcome.attempted.find((link) => link.result.objects_failed > 0);
    expect(failed?.manifest.snapshot_id).toBe('snap-a-2');
    expect(failed?.result.errors).toContain('x: denied');
    expect(failed?.result.errors.at(-1)).toContain('snap-a-3, snap-a-4');
  });

  it('keeps copying other owners after one owner chain stops', async () => {
    const dest = in_memory_tenant_context();
    const chain = [snapshot('a', 1), snapshot('b', 2), snapshot('a', 3), snapshot('b', 4)];

    const outcome = await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: chain,
      plan: plan_failing(['snap-a-1']),
      dest_id: 'replica',
    });

    expect(dest.keys()).toEqual(['manifests/b/snap-b-2.json', 'manifests/b/snap-b-4.json']);
    expect(outcome.not_copied.map((m) => m.snapshot_id)).toEqual(['snap-a-3']);
  });

  it('resumes at the gap on a rerun', async () => {
    const dest = in_memory_tenant_context();
    const chain = [snapshot('a', 1), snapshot('a', 2), snapshot('a', 3)];
    await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: chain,
      plan: plan_failing(['snap-a-2']),
      dest_id: 'r',
    });
    const copied: string[] = [];

    const outcome = await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: chain,
      plan: plan_failing([], copied),
      dest_id: 'r',
    });

    expect(copied).toEqual(['snap-a-2', 'snap-a-3']);
    expect(outcome.present.map((m) => m.snapshot_id)).toEqual(['snap-a-1']);
  });

  it('reports each attempted snapshot as soon as it is copied', async () => {
    const dest = in_memory_tenant_context();
    const seen: string[] = [];
    const on_attempted = vi.fn(async (link: { manifest: TestManifest }) => {
      seen.push(`${link.manifest.snapshot_id}:${dest.keys().length}`);
    });

    await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: [snapshot('a', 1), snapshot('a', 2)],
      plan: plan_failing(),
      dest_id: 'replica',
      on_attempted,
    });

    expect(seen).toEqual(['snap-a-1:1', 'snap-a-2:2']);
  });
  it('copies the requested snapshot after every same-time link, and orders the rest by id', async () => {
    const dest = in_memory_tenant_context();
    const copied: string[] = [];
    const at = new Date(5_000);
    const target = { snapshot_id: 'snap-a-b', owner_id: 'a', created_at: at };
    const tied = [
      target,
      { ...target, snapshot_id: 'snap-a-c' },
      { ...target, snapshot_id: 'snap-a-a' },
    ];

    await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: [snapshot('a', 9), ...tied, snapshot('a', 1)],
      plan: plan_failing([], copied),
      dest_id: 'replica',
      target_snapshot_id: 'snap-a-b',
    });

    expect(copied).toEqual(['snap-a-1', 'snap-a-a', 'snap-a-c', 'snap-a-b', 'snap-a-9']);
  });

  it('never writes the requested snapshot when a same-time link it needs fails', async () => {
    const dest = in_memory_tenant_context();
    const at = new Date(5_000);
    const target = { snapshot_id: 'snap-a-a', owner_id: 'a', created_at: at };
    const older = { ...target, snapshot_id: 'snap-a-z' };

    const outcome = await copy_missing_chain_links(source.ctx, dest.ctx, {
      manifests: [target, older],
      plan: plan_failing(['snap-a-z']),
      dest_id: 'replica',
      target_snapshot_id: 'snap-a-a',
    });

    expect(dest.keys()).toEqual([]);
    expect(outcome.not_copied.map((m) => m.snapshot_id)).toEqual(['snap-a-a']);
  });

  it('orders the same input the same way whatever order it arrives in', () => {
    const at = new Date(5_000);
    const a = { snapshot_id: 'x', owner_id: 'a', created_at: at };
    const b = { ...a, snapshot_id: 'y' };

    expect(copy_order([a, b]).map((m) => m.snapshot_id)).toEqual(['x', 'y']);
    expect(copy_order([b, a]).map((m) => m.snapshot_id)).toEqual(['x', 'y']);
  });
});
