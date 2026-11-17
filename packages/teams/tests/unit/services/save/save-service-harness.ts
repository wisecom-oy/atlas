import { Container } from 'inversify';
import { Writable } from 'node:stream';
import { vi } from 'vitest';
import type {
  TeamsChannelIndexEntry,
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TeamsThread,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { TeamsSaveService } from '@/services/save/save.service';
import {
  message_ref,
  put_blob,
  put_message,
  stub_save_context,
  TEAM,
  TIMESTAMP,
} from './save-harness';

export const SNAPSHOT = 'teams-snap-2000-bbbbbb';
export const TENANT = 'tenant';
export const IMAGE_BASE64 = Buffer.from('PNGDATA').toString('base64');
// Fixture blobs and the service must share one key, or every read fails to decrypt.
export const store = stub_encrypted_object_store();

export function channel_entry(channel_id: string, display_name: string): TeamsChannelIndexEntry {
  return {
    channel_id,
    display_name,
    shard_key: `shard/${channel_id}`,
    shard_checksum: 'unused',
    thread_count: 1,
    message_count: 1,
    size_bytes: 0,
  };
}

export function snapshot_index(channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return {
    id: `${TEAM}-${SNAPSHOT}`,
    format_version: 1,
    tenant_id: TENANT,
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date(TIMESTAMP),
    team: { id: TEAM, displayName: 'Team One' },
    members: [],
    channels,
    totals: { thread_count: channels.length, message_count: channels.length, size_bytes: 0 },
  } as unknown as TeamsSnapshotIndex;
}

/** A channel shard with empty members and tabs; `extra` sets the fields a test cares about. */
export function channel_shard(
  channel_id: string,
  display_name: string,
  threads: Record<string, TeamsThread>,
  extra: Partial<TeamsChannelShard> = {},
): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id,
    channel: { id: channel_id, displayName: display_name },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
    ...extra,
  } as unknown as TeamsChannelShard;
}

/** Builds the service from only its three storage ports, so a Graph connector cannot be needed. */
export function build_service(
  index: TeamsSnapshotIndex | undefined,
  shards: Map<string, TeamsChannelShard>,
  bucket: Map<string, Buffer>,
): TeamsSaveService {
  const container = new Container();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
    create_readonly: vi.fn(async () => stub_save_context(store, bucket)),
  } as unknown as TenantContextFactory);
  container.bind(TEAMS_INDEX_REPOSITORY_TOKEN).toConstantValue({
    find_by_snapshot: vi.fn(async () => index),
  } as unknown as TeamsIndexRepository);
  container.bind(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN).toConstantValue({
    load: vi.fn(async (_ctx: unknown, key: string) => shards.get(key)),
  } as unknown as TeamsChannelShardRepository);
  container.bind(TeamsSaveService).toSelf();
  return container.get(TeamsSaveService);
}

/**
 * Two channels. General has a hosted image, a script-laden body, and a deleted root with a kept
 * version.
 */
export function fixture() {
  const bucket = new Map<string, Buffer>();
  const image = put_blob(bucket, store, 'img-1', 'PNGDATA');
  const root = put_message(bucket, store, 'root-1', {
    id: 'root-1',
    createdDateTime: TIMESTAMP,
    from: { user: { displayName: 'Author One' } },
    body: {
      contentType: 'html',
      content:
        '<p onclick="x()">Hello</p><script>alert(1)</script>' +
        `<img src="https://graph.test/messages/root-1/hostedContents/h1/$value" onerror="x()">` +
        '<meta http-equiv="refresh" content="0"><base href="https://evil.test/">',
    },
  });
  const kept = put_message(bucket, store, 'kept-2', {
    id: 'root-2',
    createdDateTime: TIMESTAMP,
    body: { contentType: 'html', content: '<p>last live text</p>' },
  });
  const tomb = put_message(bucket, store, 'tomb-2', {
    id: 'root-2',
    createdDateTime: TIMESTAMP,
    body: { contentType: 'html', content: '<p>tombstone</p>' },
  });
  const random = put_message(bucket, store, 'root-3', {
    id: 'root-3',
    createdDateTime: TIMESTAMP,
    body: { contentType: 'html', content: '<p>elsewhere</p>' },
  });
  const general: TeamsThread = {
    root: message_ref(root, {
      hosted: { h1: { ...image, content_type: 'image/png' } },
    }),
    replies: {},
  };
  const deleted: TeamsThread = {
    root: message_ref(tomb, {
      deleted_at: '2025-02-01T00:00:00.000Z',
      kept: { ...kept, hosted: {} },
    }),
    replies: {},
  };
  const other: TeamsThread = { root: message_ref(random), replies: {} };
  const shards = new Map<string, TeamsChannelShard>([
    [
      'shard/channel-1',
      channel_shard('channel-1', 'General', { 'root-1': general, 'root-2': deleted }),
    ],
    ['shard/channel-2', channel_shard('channel-2', 'Random', { 'root-3': other })],
  ]);
  const index = snapshot_index([
    channel_entry('channel-1', 'General'),
    channel_entry('channel-2', 'Random'),
  ]);
  return { bucket, index, shards };
}

export function collecting_writable(): { stream: Writable; bytes: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}
