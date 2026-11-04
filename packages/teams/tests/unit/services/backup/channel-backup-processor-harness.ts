import { vi } from 'vitest';
import type {
  TeamsChannelEntry,
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TeamsThreadEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';

export const BACKUP_AT = '2025-01-01T00:00:00.000Z';
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

export function thread_entry(id: string): TeamsThreadEntry {
  return {
    storage_key: `key-${id}`,
    checksum: `sum-${id}`,
    size_bytes: 1,
    last_modified_at: BACKUP_AT,
    reply_count: 0,
    hosted: {},
    backup_at: BACKUP_AT,
  };
}

export function previous_channel(threads: Record<string, TeamsThreadEntry>): TeamsChannelEntry {
  return {
    id: 'channel-1',
    channel: CHANNEL,
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  };
}

export function make_connector(overrides: Partial<TeamsConnector> = {}): TeamsConnector {
  return {
    list_channel_members: vi.fn(async () => []),
    list_channel_tabs: vi.fn(async () => []),
    get_channel_files_folder: vi.fn(async () => undefined),
    list_channel_shared_teams: vi.fn(async () => []),
    fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-default' })),
    list_channel_messages: vi.fn(async () => []),
    ...overrides,
  } as unknown as TeamsConnector;
}

export function make_scope(
  connector: TeamsConnector,
  should_interrupt = (): boolean => false,
  force_full = false,
): BackupRunScope {
  return {
    ctx: {} as TenantContext,
    connector,
    tenant_id: 'tenant-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt,
    force_full,
  };
}
