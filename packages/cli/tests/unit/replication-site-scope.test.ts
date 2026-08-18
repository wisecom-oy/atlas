import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { register_replicate_command } from '@/commands/replicate.command';
import { register_rehydrate_command } from '@/commands/rehydrate.command';
import {
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { ReplicationResult } from '@wisecom/atlas-types';

// Regression tests for issue #90: replicate/rehydrate --site accepted only a
// composite site id; a browser URL went straight into the storage key builder
// and failed with "Invalid storage key segment".

const SITE_URL = 'https://contoso.sharepoint.com/sites/finance';
const SITE_HOST_PATH = 'contoso.sharepoint.com:/sites/finance';
const SITE_ID =
  'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222';

const RESULT: ReplicationResult = {
  snapshot_id: 'sp-snap-1',
  target_id: 'replica',
  status: 'COMPLETED',
  objects_copied: 2,
  objects_skipped: 0,
  objects_failed: 0,
  bytes_copied: 512,
  elapsed_ms: 9,
  errors: [],
};

interface SharePointReplicationMock {
  replicate_site: Mock;
  replicate_all_site_snapshots: Mock;
  rehydrate_site_snapshot: Mock;
  rehydrate_site: Mock;
}

const TARGET_ARGS = [
  '--target-endpoint',
  'http://replica:9000',
  '--target-access-key',
  'key',
  '--target-secret-key',
  'secret',
];

const SOURCE_ARGS = [
  '--source-endpoint',
  'http://replica:9000',
  '--source-access-key',
  'key',
  '--source-secret-key',
  'secret',
];

describe('replicate/rehydrate --site SharePoint scope', () => {
  let container: Container;
  let sharepoint: SharePointReplicationMock;
  let resolve_site: Mock;
  let program: Command;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    container = new Container();
    sharepoint = {
      replicate_site: vi.fn().mockResolvedValue([RESULT]),
      replicate_all_site_snapshots: vi.fn().mockResolvedValue([RESULT]),
      rehydrate_site_snapshot: vi.fn().mockResolvedValue(RESULT),
      rehydrate_site: vi.fn().mockResolvedValue(RESULT),
    };
    resolve_site = vi.fn().mockResolvedValue({
      site_id: SITE_ID,
      site_url: SITE_URL,
      display_name: 'Finance',
    });

    container.bind(SHAREPOINT_REPLICATION_USE_CASE_TOKEN).toConstantValue(sharepoint);
    container.bind(REPLICATION_USE_CASE_TOKEN).toConstantValue({
      get_replication_status: vi.fn().mockResolvedValue([]),
      get_replication_status_by_owner: vi.fn().mockResolvedValue([]),
    });
    container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({
      tenant_id: 'test-tenant',
      encryption_passphrase: 'pass',
    });

    program = new Command();
    program.exitOverride();
    register_replicate_command(program, () => container);
    register_rehydrate_command(program, () => container);
  });

  it('replicates a site URL under the resolved composite id', async () => {
    await program.parseAsync(['replicate', '--site', SITE_URL, ...TARGET_ARGS], { from: 'user' });

    expect(resolve_site).toHaveBeenCalledWith('test-tenant', SITE_URL);
    expect(sharepoint.replicate_all_site_snapshots).toHaveBeenCalledWith('test-tenant', SITE_ID, [
      expect.objectContaining({ endpoint: 'http://replica:9000' }),
    ]);
  });

  it('accepts the hostname:/sites/<name> form', async () => {
    await program.parseAsync(
      ['replicate', '--site', SITE_HOST_PATH, '-s', 'sp-snap-1', ...TARGET_ARGS],
      { from: 'user' },
    );

    expect(resolve_site).toHaveBeenCalledWith('test-tenant', SITE_HOST_PATH);
    expect(sharepoint.replicate_site).toHaveBeenCalledWith(
      'test-tenant',
      SITE_ID,
      'sp-snap-1',
      expect.any(Array),
    );
  });

  it('passes a composite site id through without contacting Graph', async () => {
    await program.parseAsync(['replicate', '--site', SITE_ID, ...TARGET_ARGS], { from: 'user' });

    expect(resolve_site).not.toHaveBeenCalled();
    expect(sharepoint.replicate_all_site_snapshots).toHaveBeenCalledWith(
      'test-tenant',
      SITE_ID,
      expect.any(Array),
    );
  });

  it('rehydrates a site URL under the resolved composite id', async () => {
    await program.parseAsync(['rehydrate', '--site', SITE_URL, ...SOURCE_ARGS], { from: 'user' });

    expect(sharepoint.rehydrate_site).toHaveBeenCalledWith(
      'test-tenant',
      SITE_ID,
      expect.objectContaining({ endpoint: 'http://replica:9000' }),
    );
  });

  it('rehydrates a single site snapshot from a URL', async () => {
    await program.parseAsync(['rehydrate', '--site', SITE_URL, '-s', 'sp-snap-1', ...SOURCE_ARGS], {
      from: 'user',
    });

    expect(sharepoint.rehydrate_site_snapshot).toHaveBeenCalledWith(
      'test-tenant',
      SITE_ID,
      'sp-snap-1',
      expect.anything(),
    );
  });

  it('scopes --status by the resolved site id, not the raw URL', async () => {
    const use_case = container.get<{ get_replication_status_by_owner: Mock }>(
      REPLICATION_USE_CASE_TOKEN,
    );
    await program.parseAsync(['replicate', '--status', '--site', SITE_URL], { from: 'user' });

    expect(use_case.get_replication_status_by_owner).toHaveBeenCalledWith('test-tenant', SITE_ID);
  });
});
