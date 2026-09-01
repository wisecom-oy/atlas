import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { ATLAS_CONFIG_TOKEN, GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import {
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  ReplicationStatus,
  ReplicationVerificationStatus,
} from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import { register_replicate_command } from '@/commands/replicate.command';
import { register_rehydrate_command } from '@/commands/rehydrate.command';

/**
 * Obviously fake, and carrying trailing whitespace and a newline because that is
 * what `--target-secret-key - < secret.txt` actually delivers.
 */
const STDIN_SECRET = 'FAKE-stdin-s3-secret-do-not-use-6Hn3';
const STDIN_PAYLOAD = `${STDIN_SECRET}  \n`;
const INLINE_SECRET = 'FAKE-inline-s3-secret-do-not-use-2Pq8';

const mocks = vi.hoisted(() => ({
  read_file_sync: vi.fn(),
  create_storage_target: vi.fn(),
}));

// Only readFileSync is replaced: the point is to control what stdin (fd 0) yields
// without the test runner's own stdin taking part.
vi.mock('node:fs', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, readFileSync: mocks.read_file_sync };
});

// Captures the credential object the command assembles. The real factory builds an
// S3 client and hides the secret behind a private field, so the assertion needs the
// input, not the constructed target.
vi.mock('@wisecom/atlas-s3', () => ({
  create_storage_target: mocks.create_storage_target,
}));

const RESULT: ReplicationResult = {
  snapshot_id: 'od-snap-1',
  target_id: 'replica',
  status: ReplicationStatus.COMPLETED,
  objects_total: 1,
  objects_copied: 1,
  objects_skipped: 0,
  objects_failed: 0,
  bytes_copied: 64,
  elapsed_ms: 3,
  errors: [],
  verification_status: ReplicationVerificationStatus.PASSED,
};

/** The secret the command handed to the storage factory, or undefined when none was built. */
function captured_secret(): string | undefined {
  const call = (mocks.create_storage_target as Mock).mock.calls[0];
  return call?.[0]?.s3_secret_key as string | undefined;
}

describe('replicate/rehydrate secret key from stdin (issue #256)', () => {
  let container: Container;
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mocks.create_storage_target.mockImplementation((config: { s3_endpoint: string }) => ({
      target_id: 'replica',
      endpoint: config.s3_endpoint,
    }));
    mocks.read_file_sync.mockImplementation((fd: unknown) => {
      if (fd === 0) return STDIN_PAYLOAD;
      throw new Error(`unexpected readFileSync of ${String(fd)}`);
    });

    container = new Container();
    const onedrive = {
      replicate_owner: vi.fn().mockResolvedValue([RESULT]),
      replicate_all_owner_snapshots: vi.fn().mockResolvedValue([RESULT]),
      rehydrate_owner_snapshot: vi.fn().mockResolvedValue(RESULT),
      rehydrate_owner: vi.fn().mockResolvedValue(RESULT),
    };
    const identity = {
      resolve_user: vi.fn().mockResolvedValue({
        object_id: '75a21b57-4d82-4f42-9ccc-7c231c30f78c',
        email: 'user@example.com',
        display_name: 'Example User',
      }),
    };
    container.bind(ONEDRIVE_REPLICATION_USE_CASE_TOKEN).toConstantValue(onedrive);
    container.bind(REPLICATION_USE_CASE_TOKEN).toConstantValue({
      replicate_snapshot: vi.fn().mockResolvedValue([RESULT]),
      get_replication_status: vi.fn().mockResolvedValue([]),
      get_replication_status_by_owner: vi.fn().mockResolvedValue([]),
      rehydrate_tenant: vi.fn().mockResolvedValue({ total: RESULT, workloads: [] }),
    });
    container.bind(SHAREPOINT_REPLICATION_USE_CASE_TOKEN).toConstantValue({});
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

  it('reads the replicate target secret from stdin and trims trailing whitespace', async () => {
    const argv = [
      'replicate',
      '-o',
      'user@example.com',
      '--target-endpoint',
      'http://replica:9000',
      '--target-access-key',
      'FAKEACCESSKEYID12345',
      '--target-secret-key',
      '-',
    ];

    await program.parseAsync(argv, { from: 'user' });

    expect(mocks.read_file_sync).toHaveBeenCalledWith(0, 'utf-8');
    expect(captured_secret()).toBe(STDIN_SECRET);
    // The whole point: the secret is nowhere in the command line.
    expect(argv).toContain('-');
    expect(argv.join(' ')).not.toContain(STDIN_SECRET);
  });

  it('reads the rehydrate source secret from stdin', async () => {
    await program.parseAsync(
      [
        'rehydrate',
        '-o',
        'user@example.com',
        '--source-endpoint',
        'http://replica:9000',
        '--source-access-key',
        'FAKEACCESSKEYID12345',
        '--source-secret-key',
        '-',
      ],
      { from: 'user' },
    );

    expect(mocks.read_file_sync).toHaveBeenCalledWith(0, 'utf-8');
    expect(captured_secret()).toBe(STDIN_SECRET);
  });

  it('still accepts an inline secret without touching stdin', async () => {
    await program.parseAsync(
      [
        'replicate',
        '-o',
        'user@example.com',
        '--target-endpoint',
        'http://replica:9000',
        '--target-access-key',
        'FAKEACCESSKEYID12345',
        '--target-secret-key',
        INLINE_SECRET,
      ],
      { from: 'user' },
    );

    expect(captured_secret()).toBe(INLINE_SECRET);
    expect(mocks.read_file_sync).not.toHaveBeenCalledWith(0, 'utf-8');
  });

  it('fails clearly on empty stdin instead of authenticating with an empty secret', async () => {
    mocks.read_file_sync.mockImplementation((fd: unknown) => (fd === 0 ? '   \n' : ''));

    await expect(
      program.parseAsync(
        [
          'replicate',
          '-o',
          'user@example.com',
          '--target-endpoint',
          'http://replica:9000',
          '--target-access-key',
          'FAKEACCESSKEYID12345',
          '--target-secret-key',
          '-',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/--target-secret-key was given "-".*stdin was empty/s);

    expect(mocks.create_storage_target).not.toHaveBeenCalled();
  });

  it('fails clearly when stdin cannot be read', async () => {
    mocks.read_file_sync.mockImplementation(() => {
      throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
    });

    await expect(
      program.parseAsync(
        [
          'rehydrate',
          '-o',
          'user@example.com',
          '--source-endpoint',
          'http://replica:9000',
          '--source-access-key',
          'FAKEACCESSKEYID12345',
          '--source-secret-key',
          '-',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/--source-secret-key was given "-".*stdin could not be read.*EBADF/s);

    expect(mocks.create_storage_target).not.toHaveBeenCalled();
  });
});
