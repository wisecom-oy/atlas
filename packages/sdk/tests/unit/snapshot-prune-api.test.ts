import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import {
  ONEDRIVE_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
  OUTLOOK_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
  SHAREPOINT_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type SnapshotPruneResult,
} from '@wisecom/atlas-types';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';
import { adapt_prune_options } from '@/snapshot-prune-options';

const OWNER_ID = 'eeeeeeee-0000-4000-8000-000000000005';
const SITE_ID = '11111111-0000-4000-8000-000000000001,22222222-0000-4000-8000-000000000002';

const RESULT: SnapshotPruneResult = {
  deleted_objects: 3,
  deleted_manifests: 2,
  retained_objects: 0,
  retained_manifests: 0,
  failed_objects: 0,
  failed_manifests: 0,
  dry_run: false,
  before: new Date('2026-05-01T00:00:00Z'),
  baseline_snapshot_ids: ['s3'],
  removed_snapshot_ids: ['s1', 's2'],
  retained_manifest_keys: [],
  failed_manifest_keys: [],
  deleted_bytes: 30,
  interrupted: false,
};

/** A container whose prune use cases record their calls and whose other ports do nothing. */
function prune_container() {
  const prune = {
    prune_snapshots: vi.fn(async (_tenant: string, _owner: string, _options: unknown) => RESULT),
  };
  const resolve_user = vi.fn(async () => ({ object_id: OWNER_ID }));
  const tokens = new Set([
    OUTLOOK_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
    ONEDRIVE_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
    SHAREPOINT_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
  ]);
  const any_port = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : vi.fn()) });
  const container = {
    get: (token: symbol) => {
      if (tokens.has(token)) return prune;
      if (token === USER_IDENTITY_RESOLVER_TOKEN) return { resolve_user };
      return any_port;
    },
  } as unknown as Container;
  return { container, prune };
}

describe('pruneSnapshots', () => {
  it('passes the owner id and the cut-off through, and returns the result in camelCase', async () => {
    const { container, prune } = prune_container();

    const result = await create_outlook_api('t', container).pruneSnapshots(OWNER_ID, {
      before: '2026-05-01T00:00:00Z',
      dryRun: true,
    });

    expect(prune.prune_snapshots).toHaveBeenCalledWith('t', OWNER_ID, {
      before: new Date('2026-05-01T00:00:00Z'),
      dry_run: true,
    });
    expect(result.removedSnapshotIds).toEqual(['s1', 's2']);
    expect(result.baselineSnapshotIds).toEqual(['s3']);
    expect(result.deletedBytes).toBe(30);
  });

  it('is on the OneDrive and SharePoint APIs too', async () => {
    const { container, prune } = prune_container();
    const before = new Date('2026-05-01T00:00:00Z');

    await create_onedrive_api('t', container).pruneSnapshots(OWNER_ID, { before });
    await create_sharepoint_api('t', container).pruneSnapshots(SITE_ID, { before });

    expect(prune.prune_snapshots.mock.calls.map((call) => call[1])).toEqual([OWNER_ID, SITE_ID]);
  });

  it('turns a signal into the cancellation hooks the service polls', () => {
    const controller = new AbortController();
    const adapted = adapt_prune_options({ before: new Date(0), signal: controller.signal }, 'm');
    expect(adapted.should_interrupt?.()).toBe(false);
    controller.abort();
    expect(adapted.should_interrupt?.()).toBe(true);
    expect(adapted.abort_signal).toBe(controller.signal);
  });

  it.each([
    ['no options', undefined],
    ['no cut-off', {}],
    ['an unparseable cut-off', { before: 'last spring' }],
    ['an invalid Date', { before: new Date(Number.NaN) }],
    ['a non-boolean dryRun', { before: new Date(0), dryRun: 'yes' }],
  ])('refuses %s before doing anything', async (_label, options) => {
    const { container, prune } = prune_container();
    await expect(
      create_outlook_api('t', container).pruneSnapshots(OWNER_ID, options as never),
    ).rejects.toThrow(/outlook\.pruneSnapshots requires/);
    expect(prune.prune_snapshots).not.toHaveBeenCalled();
  });
});
