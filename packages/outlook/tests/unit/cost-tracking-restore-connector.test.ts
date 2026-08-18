/**
 * The restore decorator declares an operation per call; the transport
 * middleware records one entry per HTTP request made inside it. These tests
 * cover the declaration: pool and label reaching the inner connector, which is
 * where the Graph client -- and therefore the counting middleware -- runs.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { GraphOperation } from '@wisecom/atlas-types';
import { CostTrackingRestoreConnector } from '@/adapters/cost-tracking-restore-connector.adapter';
import { get_active_operation } from '@wisecom/atlas-core/services/shared/graph-request-context';

function make_capturing_stub(seen: GraphOperation[]): RestoreConnector {
  const capture =
    <T>(value: T) =>
    async () => {
      const op = get_active_operation();
      if (op) seen.push(op);
      return value;
    };
  return {
    create_mail_folder: vi.fn(capture({ id: 'folder-id', display_name: 'Restored' })),
    create_message: vi.fn(capture('msg-id')),
    add_attachment: vi.fn(capture(undefined)),
    create_upload_session: vi.fn(capture({ upload_url: 'https://upload', expires_at: '' })),
    upload_attachment_chunk: vi.fn(capture(undefined)),
    count_folder_messages: vi.fn(capture(0)),
    list_folder_messages: vi.fn(capture([])),
  } as unknown as RestoreConnector;
}

describe('CostTrackingRestoreConnector — operation labelling', () => {
  it('labels every restore call against the outlook pool', async () => {
    const seen: GraphOperation[] = [];
    const connector = new CostTrackingRestoreConnector(make_capturing_stub(seen));

    await connector.create_mail_folder('t', 'user@example.com', 'Restored');
    await connector.create_message('t', 'user@example.com', 'f1', {});
    await connector.add_attachment('t', 'user@example.com', 'm1', {
      name: 'report.pdf',
      content_type: 'application/pdf',
      content: Buffer.alloc(8),
    });
    await connector.create_upload_session('t', 'user@example.com', 'm1', 'big.zip', 1024);
    await connector.upload_attachment_chunk('https://upload', Buffer.alloc(4), 0, 4);
    await connector.count_folder_messages('t', 'user@example.com', 'f1');
    await connector.list_folder_messages('t', 'user@example.com', 'f1', 10);

    expect(seen.map((op) => op.request_type)).toEqual([
      'create_folder',
      'create_message',
      'add_attachment',
      'create_upload_session',
      'upload_chunk',
      'count_folder_messages',
      'list_folder_messages',
    ]);
    expect(seen.every((op) => op.pool === 'outlook')).toBe(true);
  });

  it('leaves upload byte accounting to the transport', async () => {
    const seen: GraphOperation[] = [];
    const connector = new CostTrackingRestoreConnector(make_capturing_stub(seen));

    await connector.upload_attachment_chunk('https://upload', Buffer.alloc(4 * 1024 * 1024), 0, 4);

    // Declaring the size here would count a retried chunk once, though the
    // window is charged for every attempt actually sent.
    expect(seen[0]).toEqual({ pool: 'outlook', request_type: 'upload_chunk' });
  });

  it('leaves no operation in scope once a call returns', async () => {
    const connector = new CostTrackingRestoreConnector(make_capturing_stub([]));

    await connector.create_message('t', 'user@example.com', 'f1', {});

    expect(get_active_operation()).toBeUndefined();
  });
});
