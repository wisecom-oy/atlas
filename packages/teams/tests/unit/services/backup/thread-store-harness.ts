import { vi, type Mock } from 'vitest';
import type {
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';

export const BACKUP_AT = '2025-01-01T00:00:00.000Z';
export const HOSTED_BODY =
  '<img src="https://graph.example.test/teams/t/channels/c/messages/r/hostedContents/h1/$value">';

export interface ThreadHarness {
  readonly scope: BackupRunScope;
  readonly put: Mock;
  readonly exists: Mock;
  readonly encrypt: Mock;
  readonly list_replies: Mock;
  readonly list_hosted_contents: Mock;
  readonly download_hosted_content: Mock;
}

/** A storage harness where every object reports `exists_result`, so dedupe paths can be steered. */
export function make_harness(exists_result = false): ThreadHarness {
  const put = vi.fn(async () => undefined);
  const exists = vi.fn(async () => exists_result);
  const encrypt = vi.fn((plaintext: Buffer) => plaintext);
  const list_replies = vi.fn(async () => [] as TeamsGraphResource[]);
  const list_hosted_contents = vi.fn(async () => [] as TeamsGraphResource[]);
  const download_hosted_content = vi.fn(async () => Buffer.from('image-bytes'));
  const ctx = {
    storage: { put, exists },
    encrypt,
    create_content_hmac: () => stub_tenant_create_content_hmac(),
  } as unknown as TenantContext;
  const connector = {
    list_replies,
    list_hosted_contents,
    download_hosted_content,
  } as unknown as TeamsConnector;
  const scope: BackupRunScope = {
    ctx,
    connector,
    tenant_id: 'tenant-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt: () => false,
    force_full: false,
  };
  return {
    scope,
    put,
    exists,
    encrypt,
    list_replies,
    list_hosted_contents,
    download_hosted_content,
  };
}

export function root(overrides: Partial<TeamsGraphResource> = {}): TeamsGraphResource {
  return {
    id: 'root-1',
    body: { content: 'hello' },
    lastModifiedDateTime: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function live(
  replies: TeamsGraphResource[] = [],
  base: TeamsGraphResource = root(),
): TeamsRootChange {
  return { root: base, deleted: false, replies };
}

export function tombstone(): TeamsRootChange {
  return { root: root({ deletedDateTime: '2025-01-02T00:00:00Z' }), deleted: true };
}
