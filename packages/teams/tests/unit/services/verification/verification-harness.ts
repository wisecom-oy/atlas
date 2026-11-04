import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsIndexRepository,
  TeamsMessageRef,
  TeamsSnapshotIndex,
  TeamsStoredBlobRef,
  TeamsThread,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import type { StubEncryptedObjectStore } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { TeamsVerificationService } from '@/services/verification/verification.service';

export const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
export const SNAPSHOT = 'teams-snap-2000-bbbbbb';
export const SHARD_KEY = `teams/manifests/${TEAM}/channels/channel-1/shard-name.json`;
export const TIMESTAMP = '2025-01-01T00:00:00.000Z';

/** Stores one sealed blob in `bucket` and returns the reference an index or shard would record. */
export function put_blob(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  storage_key: string,
  plaintext: string,
): TeamsStoredBlobRef {
  const bytes = Buffer.from(plaintext, 'utf-8');
  bucket.set(storage_key, store.encrypt(bytes));
  return {
    storage_key,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

export function message(
  own: TeamsStoredBlobRef,
  extra: Partial<TeamsMessageRef> = {},
): TeamsMessageRef {
  return { ...own, last_modified_at: TIMESTAMP, hosted: {}, ...extra };
}

export function thread(root: TeamsMessageRef): TeamsThread {
  return { root, replies: {} };
}

export function shard_with(threads: Record<string, TeamsThread>): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: 'channel-1',
    channel: { id: 'channel-1' },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  };
}

export function index_listing(shard_key: string): TeamsSnapshotIndex {
  return {
    id: `${TEAM}-${SNAPSHOT}`,
    format_version: 1,
    tenant_id: 'tenant',
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date(TIMESTAMP),
    team: { id: TEAM },
    members: [],
    channels: [
      {
        channel_id: 'channel-1',
        shard_key,
        shard_checksum: 'unused',
        thread_count: 1,
        message_count: 1,
        size_bytes: 0,
      },
    ],
    totals: { thread_count: 1, message_count: 1, size_bytes: 0 },
  };
}

/**
 * Builds the service over an in-memory bucket. `shards` maps a shard key to the shard `load`
 * returns; a key that is in the bucket but not in `shards` makes `load` throw as a corrupt shard.
 * A key in `newer` makes `load` throw as a shard written in a newer format.
 */
export function setup(
  store: StubEncryptedObjectStore,
  bucket: Map<string, Buffer>,
  shards: Map<string, TeamsChannelShard> = new Map(),
  newer: string[] = [],
) {
  const get = vi.fn(async (key: string) => {
    const body = bucket.get(key);
    if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return body;
  });
  const ctx = {
    storage: { exists: vi.fn(async (key: string) => bucket.has(key)), get },
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_content_hmac: () => stub_tenant_create_content_hmac(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const find_by_snapshot = vi.fn<TeamsIndexRepository['find_by_snapshot']>();
  const load = vi.fn(async (_ctx: TenantContext, key: string) => {
    if (newer.includes(key)) throw new UnsupportedFormatVersionError(`newer shard ${key}`);
    const shard = shards.get(key);
    if (shard === undefined) throw new UnreadableContentError(`corrupt shard ${key}`);
    return shard;
  });
  const service = new TeamsVerificationService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    { find_by_snapshot } as unknown as TeamsIndexRepository,
    { load } as unknown as TeamsChannelShardRepository,
  );
  return { get, find_by_snapshot, service };
}

/** Stores a shard object in the bucket and makes `load` return `content` for its key. */
export function put_shard(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  shards: Map<string, TeamsChannelShard>,
  content: TeamsChannelShard,
): void {
  bucket.set(SHARD_KEY, store.encrypt(Buffer.from('shard bytes')));
  shards.set(SHARD_KEY, content);
}
