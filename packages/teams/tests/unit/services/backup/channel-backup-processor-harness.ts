import { vi } from 'vitest';
import type {
  TeamsChannelShard,
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TeamsThread,
  TenantContext,
} from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';

export const BACKUP_AT = '2025-01-01T00:00:00.000Z';
export const TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const CHANNEL: TeamsGraphResource = { id: 'channel-1', displayName: 'General' };
export const CHANNEL_WITH_EMAIL = {
  id: 'channel-1',
  displayName: 'General',
  email: 'general@example.invalid',
} as TeamsGraphResource;
export const SHARED_CHANNEL = {
  id: 'channel-1',
  displayName: 'Shared',
  email: 'shared@example.invalid',
  membershipType: 'shared',
} as TeamsGraphResource;

export function root_change(id: string): TeamsRootChange {
  return { root: { id }, deleted: false };
}

/** A stored thread with no replies, as the thread store would write it. */
export function thread_entry(id: string): TeamsThread {
  return {
    root: {
      storage_key: `key-${id}`,
      checksum: `sum-${id}`,
      size_bytes: 1,
      last_modified_at: BACKUP_AT,
      hosted: {},
    },
    replies: {},
  };
}

/** A previous channel shard holding the given threads. */
export function previous_shard(
  threads: Record<string, TeamsThread>,
  read_mode: TeamsChannelShard['read_mode'] = 'full',
): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM_ID,
    channel_id: 'channel-1',
    channel: CHANNEL,
    members: [],
    tabs: [],
    read_mode,
    threads,
  };
}

/** A connector whose every channel call resolves to an empty result unless overridden. */
export function make_connector(overrides: Partial<TeamsConnector> = {}): TeamsConnector {
  return {
    list_channel_members: vi.fn(async () => []),
    list_channel_tabs: vi.fn(async () => []),
    get_channel_files_folder: vi.fn(async () => undefined),
    list_channel_shared_teams: vi.fn(async () => []),
    fetch_message_delta_page: vi.fn(async () => ({ roots: [], delta_link: 'link-default' })),
    list_channel_messages_page: vi.fn(async () => ({ roots: [] })),
    list_replies: vi.fn(async () => []),
    get_channel_message: vi.fn(async () => ({ status: 'not_found' })),
    ...overrides,
  } as unknown as TeamsConnector;
}

/** A run scope over the given connector. */
export function make_scope(
  connector: TeamsConnector,
  should_interrupt = (): boolean => false,
  force_full = false,
): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector,
    tenant_id: 'tenant-1',
    team_id: TEAM_ID,
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
    force_full,
    checkpoints: new InMemoryTeamsChannelCheckpointRepository(),
    lease: stub_held_owner_lease(),
    progress: { roots_applied: vi.fn() },
  };
}
