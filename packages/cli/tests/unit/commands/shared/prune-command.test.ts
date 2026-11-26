import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import type { SnapshotPruneResult } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import { execute_prune, type PruneCommandSpec } from '@/commands/shared/prune.command';
import { parse_prune_cutoff } from '@/commands/shared/prune-cutoff';
import { print_prune_result } from '@/commands/shared/prune-presenter';

const TOKEN = Symbol.for('TestSnapshotPruneUseCase');
const NOW = new Date('2026-06-01T12:00:00Z');

function result(overrides: Partial<SnapshotPruneResult> = {}): SnapshotPruneResult {
  return {
    deleted_objects: 4,
    deleted_manifests: 2,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
    dry_run: false,
    before: NOW,
    baseline_snapshot_ids: ['s3'],
    removed_snapshot_ids: ['s1', 's2'],
    retained_manifest_keys: [],
    failed_manifest_keys: [],
    deleted_bytes: 2048,
    interrupted: false,
    ...overrides,
  };
}

const SPEC: PruneCommandSpec = {
  workload: 'onedrive',
  owner_flag: '-o, --owner <id>',
  owner_option: 'owner',
  owner_noun: 'owner',
  token: TOKEN,
  resolve_owner: async (_container, _tenant, input) => input.toLowerCase(),
};

function prune_container(prune_snapshots = vi.fn(async () => result())): Container {
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });
  container.bind(TOKEN).toConstantValue({ prune_snapshots });
  return container;
}

describe('parse_prune_cutoff', () => {
  it.each([
    ['90d', '2026-03-03T12:00:00.000Z'],
    ['2w', '2026-05-18T12:00:00.000Z'],
    ['36h', '2026-05-31T00:00:00.000Z'],
    ['2026-03-01', '2026-03-01T00:00:00.000Z'],
    ['2026-03-01T08:30:00Z', '2026-03-01T08:30:00.000Z'],
  ])('reads %s as %s', (value, expected) => {
    expect(parse_prune_cutoff(value, NOW)?.toISOString()).toBe(expected);
  });

  it.each(['last spring', '90', '90 days', '2026-13-45', ''])('refuses %s', (value) => {
    expect(parse_prune_cutoff(value, NOW)).toBeUndefined();
  });
});

describe('atlas <workload> prune', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('runs a dry run without asking, with the resolved owner and the parsed cut-off', async () => {
    const prune_snapshots = vi.fn(async () => result({ dry_run: true }));
    await execute_prune(prune_container(prune_snapshots), SPEC, {
      owner: 'OWNER-1',
      before: '2026-03-01',
      dryRun: true,
    });

    expect(prune_snapshots).toHaveBeenCalledWith('test-tenant', 'owner-1', {
      before: new Date('2026-03-01T00:00:00Z'),
      dry_run: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a cut-off it cannot read, before touching storage', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const prune_snapshots = vi.fn();
    await execute_prune(prune_container(prune_snapshots), SPEC, {
      owner: 'o',
      before: 'soon',
      yes: true,
    });

    expect(prune_snapshots).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--before'));
    expect(process.exitCode).toBe(1);
  });

  it('runs with -y and exits 0 when nothing was left behind', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const prune_snapshots = vi.fn(async () => result());
    await execute_prune(prune_container(prune_snapshots), SPEC, {
      owner: 'o',
      before: '90d',
      yes: true,
    });

    expect(prune_snapshots).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('print_prune_result', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('lists retained manifests and exits 1, as a delete does, so a scheduled run notices', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);

    print_prune_result(
      result({ retained_manifests: 1, retained_manifest_keys: ['onedrive/manifests/o/s1.json'] }),
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onedrive/manifests/o/s1.json'));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when unreferenced content could not be swept, but not for a dry run', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);

    print_prune_result(result({ dry_run: true, content_sweep_skipped: 'quarantined_objects' }));
    expect(process.exitCode).toBeUndefined();

    print_prune_result(result({ content_sweep_skipped: 'quarantined_objects' }));
    expect(process.exitCode).toBe(1);
  });
});
