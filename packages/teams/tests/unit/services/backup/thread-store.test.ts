import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TeamsThreadEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import { mark_thread_removed, store_thread } from '@/services/backup/thread-store';

const BACKUP_AT = '2025-01-01T00:00:00.000Z';
const HOSTED_BODY =
  '<img src="https://graph.example.test/teams/t/channels/c/messages/r/hostedContents/h1/$value">';

interface Harness {
  readonly scope: BackupRunScope;
  readonly put: Mock;
  readonly exists: Mock;
  readonly list_replies: Mock;
  readonly list_hosted_contents: Mock;
  readonly download_hosted_content: Mock;
}

function make_harness(exists_result = false): Harness {
  const put = vi.fn(async () => undefined);
  const exists = vi.fn(async () => exists_result);
  const list_replies = vi.fn(async () => [] as TeamsGraphResource[]);
  const list_hosted_contents = vi.fn(async () => [] as TeamsGraphResource[]);
  const download_hosted_content = vi.fn(async () => Buffer.from('image-bytes'));
  const ctx = {
    storage: { put, exists },
    encrypt: (plaintext: Buffer) => plaintext,
    create_content_hmac: () => createHmac('sha256', 'synthetic-test-key'),
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
    team_id: 'team-1',
    backup_at: BACKUP_AT,
    counters: create_backup_counters(),
    should_interrupt: () => false,
    force_full: false,
  };
  return {
    scope,
    put,
    exists,
    list_replies,
    list_hosted_contents,
    download_hosted_content,
  };
}

function root(overrides: Partial<TeamsGraphResource> = {}): TeamsGraphResource {
  return {
    id: 'root-1',
    body: { content: 'hello' },
    lastModifiedDateTime: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function live(replies: TeamsGraphResource[] = [], base = root()): TeamsRootChange {
  return { root: base, deleted: false, replies };
}

describe('store_thread', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = make_harness();
  });

  it('stores a deleted root as a tombstone without listing replies or hosted contents', async () => {
    const change: TeamsRootChange = {
      root: root({ deletedDateTime: '2025-01-02T00:00:00Z' }),
      deleted: true,
    };

    const entry = await store_thread(harness.scope, 'channel-1', change, undefined);

    expect(harness.list_replies).not.toHaveBeenCalled();
    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(entry.deleted_at).toBe(BACKUP_AT);
  });

  it('keeps the last live blob of a thread that was deleted', async () => {
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
    };
    const change: TeamsRootChange = { root: root({ deletedDateTime: 'x' }), deleted: true };

    const entry = await store_thread(harness.scope, 'channel-1', change, previous);

    expect(entry.last_live).toEqual({
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
    });
  });

  it('does not upload a live thread whose content matches the previous entry', async () => {
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();

    const again = await store_thread(harness.scope, 'channel-1', live(), first);

    expect(harness.put).not.toHaveBeenCalled();
    expect(again.checksum).toBe(first.checksum);
    expect(harness.scope.counters.threads_deduplicated).toBe(1);
  });

  it('uploads a thread again when its reply count changes', async () => {
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();
    const reply: TeamsGraphResource = { id: 'reply-1', body: { content: 'new reply' } };

    const again = await store_thread(harness.scope, 'channel-1', live([reply]), first);

    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(again.reply_count).toBe(1);
  });

  it('revives a deleted thread when Graph reports it live again with the same content', async () => {
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    const deleted = mark_thread_removed(harness.scope, first);

    const revived = await store_thread(harness.scope, 'channel-1', live(), deleted);

    expect(revived.deleted_at).toBeUndefined();
    expect(revived.last_live).toBeUndefined();
  });

  it('fetches replies through the connector when the change does not inline them', async () => {
    await store_thread(harness.scope, 'channel-1', { root: root(), deleted: false }, undefined);

    expect(harness.list_replies).toHaveBeenCalledWith('tenant-1', 'team-1', 'channel-1', 'root-1');
  });

  it('stores hosted contents referenced by the root and downloads them once', async () => {
    harness.list_hosted_contents.mockResolvedValueOnce([{ id: 'h1', contentType: 'image/png' }]);

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      undefined,
    );

    expect(harness.list_hosted_contents).toHaveBeenCalledTimes(1);
    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
    expect(Object.keys(entry.hosted)).toEqual(['h1']);
    expect(entry.hosted.h1?.content_type).toBe('image/png');
  });

  it('does not list hosted contents when no message references them', async () => {
    await store_thread(harness.scope, 'channel-1', live(), undefined);

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
  });

  it('reuses a hosted content already recorded on the previous entry', async () => {
    harness.list_hosted_contents.mockResolvedValue([{ id: 'h1' }]);
    const previous_hosted = {
      storage_key: 'hosted-key',
      checksum: 'hosted-checksum',
      size_bytes: 11,
    };
    const previous: TeamsThreadEntry = {
      storage_key: 'old',
      checksum: 'old',
      size_bytes: 1,
      last_modified_at: '',
      reply_count: 0,
      hosted: { h1: previous_hosted },
      backup_at: BACKUP_AT,
    };

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      previous,
    );

    expect(harness.download_hosted_content).not.toHaveBeenCalled();
    expect(entry.hosted.h1).toEqual(previous_hosted);
  });

  it('does not reference hosted contents of a reply Graph reports as deleted', async () => {
    const deleted_reply: TeamsGraphResource = {
      id: 'reply-1',
      body: { content: HOSTED_BODY },
      deletedDateTime: '2025-01-02T00:00:00Z',
    };

    await store_thread(harness.scope, 'channel-1', live([deleted_reply]), undefined);

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
  });

  it('skips the upload when the content key already exists in storage', async () => {
    harness = make_harness(true);

    await store_thread(harness.scope, 'channel-1', live(), undefined);

    expect(harness.exists).toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
  });
});

describe('mark_thread_removed', () => {
  it('marks a live thread deleted, keeps its blob as the last live one, and makes no Graph call', () => {
    const harness = make_harness();
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 7,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
    };

    const removed = mark_thread_removed(harness.scope, previous);

    expect(removed.deleted_at).toBe(BACKUP_AT);
    expect(removed.last_live).toEqual({
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 7,
    });
    expect(harness.list_replies).not.toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
  });

  it('returns an already deleted thread unchanged', () => {
    const harness = make_harness();
    const deleted: TeamsThreadEntry = {
      storage_key: 'tomb',
      checksum: 'tomb',
      size_bytes: 1,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
      deleted_at: '2024-12-01T00:00:00.000Z',
    };

    expect(mark_thread_removed(harness.scope, deleted)).toBe(deleted);
  });
});
