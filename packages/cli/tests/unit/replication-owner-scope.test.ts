import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { register_replicate_command } from '@/commands/replicate.command';
import { register_rehydrate_command } from '@/commands/rehydrate.command';
import {
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN, GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import type { ReplicationResult } from '@wisecom/atlas-types';

const OWNER_EMAIL = 'user@example.com';
const OWNER_OBJECT_ID = '75a21b57-4d82-4f42-9ccc-7c231c30f78c';

const RESULT: ReplicationResult = {
  snapshot_id: 'od-snap-1',
  target_id: 'replica',
  status: 'COMPLETED',
  objects_copied: 3,
  objects_skipped: 0,
  objects_failed: 0,
  bytes_copied: 1024,
  elapsed_ms: 12,
  errors: [],
};

interface OneDriveReplicationMock {
  replicate_owner: Mock;
  replicate_all_owner_snapshots: Mock;
  rehydrate_owner_snapshot: Mock;
  rehydrate_owner: Mock;
}

interface OutlookReplicationMock {
  replicate_snapshot: Mock;
  get_replication_status: Mock;
  get_replication_status_by_owner: Mock;
  rehydrate_tenant: Mock;
}

function make_onedrive_mock(): OneDriveReplicationMock {
  return {
    replicate_owner: vi.fn().mockResolvedValue([RESULT]),
    replicate_all_owner_snapshots: vi.fn().mockResolvedValue([RESULT]),
    rehydrate_owner_snapshot: vi.fn().mockResolvedValue(RESULT),
    rehydrate_owner: vi.fn().mockResolvedValue(RESULT),
  };
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

describe('replicate/rehydrate --owner OneDrive scope', () => {
  let container: Container;
  let onedrive: OneDriveReplicationMock;
  let outlook: OutlookReplicationMock;
  let program: Command;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    container = new Container();
    onedrive = make_onedrive_mock();
    outlook = {
      replicate_snapshot: vi.fn().mockResolvedValue([RESULT]),
      get_replication_status: vi.fn().mockResolvedValue([]),
      get_replication_status_by_owner: vi.fn().mockResolvedValue([]),
      rehydrate_tenant: vi.fn().mockResolvedValue({
        total: RESULT,
        workloads: [
          { workload: 'outlook', result: RESULT },
          { workload: 'onedrive', result: RESULT },
          { workload: 'sharepoint', result: RESULT },
        ],
      }),
    };

    container.bind(ONEDRIVE_REPLICATION_USE_CASE_TOKEN).toConstantValue(onedrive);
    container.bind(REPLICATION_USE_CASE_TOKEN).toConstantValue(outlook);
    container.bind(SHAREPOINT_REPLICATION_USE_CASE_TOKEN).toConstantValue({});
    const identity = {
      resolve_user: vi.fn().mockResolvedValue({
        object_id: OWNER_OBJECT_ID,
        email: OWNER_EMAIL,
        display_name: 'Example User',
      }),
    };
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue(identity);
    container.bind(GRAPH_IDENTITY_RESOLVER_TOKEN).toConstantValue(identity);
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({
      tenant_id: 'test-tenant',
      encryption_passphrase: 'pass',
    });

    program = new Command();
    program.exitOverride();
    register_replicate_command(program, () => container);
    register_rehydrate_command(program, () => container);
  });

  it('replicates every unreplicated snapshot under the owner object ID, not the raw email', async () => {
    await program.parseAsync(['replicate', '-o', OWNER_EMAIL, ...TARGET_ARGS], { from: 'user' });

    expect(onedrive.replicate_all_owner_snapshots).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
      [expect.objectContaining({ endpoint: 'http://replica:9000' })],
    );
    expect(onedrive.replicate_owner).not.toHaveBeenCalled();
  });

  it('routes replicate -o with -s to the single OneDrive snapshot, not the Outlook path', async () => {
    await program.parseAsync(['replicate', '-o', OWNER_EMAIL, '-s', 'od-snap-1', ...TARGET_ARGS], {
      from: 'user',
    });

    expect(onedrive.replicate_owner).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
      'od-snap-1',
      expect.any(Array),
    );
    expect(outlook.replicate_snapshot).not.toHaveBeenCalled();
  });

  it('passes a raw object ID through untouched so DR works without Graph', async () => {
    await program.parseAsync(['replicate', '-o', OWNER_OBJECT_ID, ...TARGET_ARGS], {
      from: 'user',
    });

    expect(onedrive.replicate_all_owner_snapshots).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
      expect.any(Array),
    );
  });

  it('scopes --status -o to the resolved owner object ID', async () => {
    await program.parseAsync(['replicate', '--status', '-o', OWNER_EMAIL], { from: 'user' });

    expect(outlook.get_replication_status_by_owner).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
    );
  });

  it('rehydrates the owner from the replica using the resolved object ID', async () => {
    await program.parseAsync(['rehydrate', '-o', OWNER_EMAIL, ...SOURCE_ARGS], { from: 'user' });

    expect(onedrive.rehydrate_owner).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
      expect.objectContaining({ endpoint: 'http://replica:9000' }),
    );
  });

  it('routes rehydrate -o with -s to the single OneDrive snapshot', async () => {
    await program.parseAsync(['rehydrate', '-o', OWNER_EMAIL, '-s', 'od-snap-1', ...SOURCE_ARGS], {
      from: 'user',
    });

    expect(onedrive.rehydrate_owner_snapshot).toHaveBeenCalledWith(
      'test-tenant',
      OWNER_OBJECT_ID,
      'od-snap-1',
      expect.anything(),
    );
    expect(onedrive.rehydrate_owner).not.toHaveBeenCalled();
  });

  it('dispatches --all to full tenant recovery across every workload', async () => {
    await program.parseAsync(['rehydrate', '--all', ...SOURCE_ARGS], { from: 'user' });

    expect(outlook.rehydrate_tenant).toHaveBeenCalledWith(
      'test-tenant',
      expect.objectContaining({ endpoint: 'http://replica:9000' }),
    );
  });

  it('warns naming each workload the replica held nothing for', async () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const empty = { ...RESULT, objects_copied: 0, objects_skipped: 0, objects_total: 0 };
    vi.mocked(outlook.rehydrate_tenant).mockResolvedValue({
      total: RESULT,
      workloads: [
        { workload: 'outlook', result: RESULT },
        { workload: 'onedrive', result: empty },
        { workload: 'sharepoint', result: empty },
      ],
    });

    await program.parseAsync(['rehydrate', '--all', ...SOURCE_ARGS], { from: 'user' });

    const warned = warn_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('onedrive, sharepoint');
    expect(warned).not.toContain('outlook,');
    warn_spy.mockRestore();
  });
});
