import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { BackupProgressReporter, MailboxConnector } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import type { GraphPageResponse } from '@/adapters/graph-delta-message-mapper';
import { run_mail_delta_pass } from '@/adapters/graph-mail-delta-sync';
import { create_delta_handover } from '@/adapters/graph-delta-round-events';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';
import { build_manifest } from '@/services/backup/snapshot-manifest-builder';

/**
 * Issue #894. A message Graph listed twice in a delta round was downloaded twice and recorded
 * twice. These runs page through the real delta pass into the real folder sync and in-memory
 * storage, so the figures compared are the ones a backup reports.
 */

const NEXT = 'https://graph.microsoft.com/v1.0/delta?skiptoken=next';
const DELTA_LINK = 'https://graph.microsoft.com/v1.0/delta?deltatoken=done';

function live(id: string): Record<string, unknown> {
  return { id, subject: `Subject ${id}`, parentFolderId: 'inbox', hasAttachments: false };
}

function removed(id: string): Record<string, unknown> {
  return { id, '@removed': { reason: 'deleted' } };
}

/** Builds the delta round: every page but the last links to the next. */
function round(...pages: Record<string, unknown>[][]): GraphPageResponse[] {
  return pages.map((value, index) =>
    index === pages.length - 1
      ? ({ value, '@odata.deltaLink': DELTA_LINK } as GraphPageResponse)
      : ({ value, '@odata.nextLink': NEXT } as GraphPageResponse),
  );
}

/** A connector that pages `pages` through the Graph delta pass and records each MIME download. */
function make_connector(pages: GraphPageResponse[]): {
  connector: MailboxConnector;
  mime_downloads: string[];
} {
  let next_page = 0;
  const { client } = stub_graph_client(() => pages[next_page++]);
  const mime_downloads: string[] = [];
  const connector = {
    fetch_delta: (
      _tenant_id: string,
      owner_id: string,
      folder_id: string,
      prev_delta_link: string | undefined,
      on_page: Parameters<MailboxConnector['fetch_delta']>[4],
    ) =>
      run_mail_delta_pass(
        client as unknown as Client,
        { owner_id, folder_id, prev_delta_link, delta_reset: false, page_size: 10, on_page },
        create_delta_handover(),
      ),
    fetch_mime: vi.fn(async (_tenant_id: string, _owner_id: string, message_id: string) => {
      mime_downloads.push(message_id);
      return Buffer.from(`MIME of ${message_id}`);
    }),
  } as unknown as MailboxConnector;
  return { connector, mime_downloads };
}

function make_progress(): BackupProgressReporter {
  return {
    update_paging: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
  } as unknown as BackupProgressReporter;
}

/** Syncs one folder from `pages` and returns what the run would report and record. */
async function sync_folder(pages: GraphPageResponse[]) {
  const { connector, mime_downloads } = make_connector(pages);
  const { ctx } = in_memory_tenant_context();
  const result = await sync_single_folder({
    ctx,
    connector,
    tenant_id: 'tenant-1',
    owner_id: 'user-1',
    folder_id: 'inbox',
    folder_index: 0,
    folder_total: 3,
    global_total: 3,
    global_processed_before: 0,
    sync_start: Date.now(),
    progress: make_progress(),
    is_interrupted: () => false,
    is_hard_stopped: () => false,
    operation_control: {},
    previous_manifest_entries: 0,
  });
  const manifest = build_manifest('user-1', 'snap-1', result.entries, {});
  return {
    entry_ids: result.entries.map((entry) => entry.object_id),
    removed_ids: result.removed_ids,
    stored: result.stored,
    deduplicated: result.deduplicated,
    captured_bytes: manifest.total_size_bytes,
    mime_downloads,
  };
}

describe('a delta round that lists a message more than once (issue #894)', () => {
  it('reports the same figures as a round without the repeats', async () => {
    const baseline = await sync_folder(round([live('msg-1'), live('msg-2')], [live('msg-3')]));
    const repeated = await sync_folder(
      round(
        [live('msg-1'), live('msg-2'), live('msg-1')],
        [live('msg-2'), live('msg-3'), live('msg-3')],
      ),
    );

    expect(repeated).toEqual(baseline);
    expect(repeated.entry_ids).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(repeated.mime_downloads).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(repeated.stored).toBe(3);
    expect(repeated.deduplicated).toBe(0);
  });

  it('keeps a message removed and added again in the round, without recording the removal', async () => {
    const result = await sync_folder(round([removed('msg-1'), live('msg-2')], [live('msg-1')]));

    expect(result.entry_ids).toEqual(['msg-2', 'msg-1']);
    expect(result.removed_ids).toEqual([]);
  });

  it('records no entry for a message the round removed after storing it', async () => {
    const result = await sync_folder(round([live('msg-1'), live('msg-2')], [removed('msg-1')]));

    expect(result.entry_ids).toEqual(['msg-2']);
    expect(result.removed_ids).toEqual(['msg-1']);
    // Downloaded once before the removal was read; never again.
    expect(result.mime_downloads).toEqual(['msg-1', 'msg-2']);
  });

  it('downloads nothing for a message removed on the page that listed it', async () => {
    const result = await sync_folder(round([live('msg-1'), removed('msg-1'), live('msg-2')]));

    expect(result.entry_ids).toEqual(['msg-2']);
    expect(result.removed_ids).toEqual(['msg-1']);
    expect(result.mime_downloads).toEqual(['msg-2']);
  });
});
