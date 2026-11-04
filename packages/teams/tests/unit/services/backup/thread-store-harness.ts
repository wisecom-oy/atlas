import { vi, type Mock } from 'vitest';
import type { TeamsConnector, TeamsGraphResource, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';

export const BACKUP_AT = '2025-01-01T00:00:00.000Z';
export const DELETED_AT = '2025-01-02T00:00:00.000Z';
export const TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const CHANNEL_ID = 'channel-1';

export interface ThreadHarness {
  readonly scope: BackupRunScope;
  /** Stored objects by key. Plaintext, because the encrypt stub is the identity. */
  readonly objects: Record<string, Buffer>;
  readonly put: Mock;
  readonly list_hosted_contents: Mock;
  readonly download_hosted_content: Mock;
}

/** A storage harness backed by an in-memory bucket, with counting put and hosted calls. */
export function make_harness(force_full = false): ThreadHarness {
  const objects: Record<string, Buffer> = {};
  const put = vi.fn(async (key: string, data: Buffer) => {
    objects[key] = data;
  });
  const ctx = {
    storage: {
      put,
      exists: async (key: string) => key in objects,
      get: async (key: string) => objects[key],
    },
    encrypt: (plaintext: Buffer) => plaintext,
    create_content_hmac: () => stub_tenant_create_content_hmac(),
  } as unknown as TenantContext;
  const list_hosted_contents = vi.fn(async () => [] as TeamsGraphResource[]);
  const download_hosted_content = vi.fn(async () => Buffer.from('image-bytes'));
  const connector = { list_hosted_contents, download_hosted_content } as unknown as TeamsConnector;
  const scope: BackupRunScope = {
    ctx,
    connector,
    tenant_id: 'tenant-1',
    team_id: TEAM_ID,
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt: () => false,
    force_full,
  };
  return { scope, objects, put, list_hosted_contents, download_hosted_content };
}

/** A live Graph message. Pass `body` with an image reference to exercise hosted content. */
export function message(
  id: string,
  overrides: Partial<TeamsGraphResource> = {},
): TeamsGraphResource {
  return {
    id,
    body: { contentType: 'html', content: 'hello' },
    lastModifiedDateTime: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/** The Graph shape of a message that was removed: a deletion timestamp, no meaningful body. */
export function deleted(id: string): TeamsGraphResource {
  return message(id, { deletedDateTime: DELETED_AT, body: { contentType: 'html', content: '' } });
}

/** An `<img>` reference to a hosted content item of the given message. */
export function hosted_body(root_id: string, hosted_id: string, reply_id?: string): string {
  const path =
    reply_id === undefined
      ? `messages/${root_id}/hostedContents/${hosted_id}`
      : `messages/${root_id}/replies/${reply_id}/hostedContents/${hosted_id}`;
  return `<img src="https://graph.example.test/teams/t/channels/c/${path}/$value">`;
}
