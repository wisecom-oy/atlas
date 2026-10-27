import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector, MailMessage, TenantContext } from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import {
  capture_page_reactions,
  store_single_message,
} from '@/services/backup/message-payload-store';

const REACTIONS = [
  { id: 'String {41F28F13-83F4-4114-A584-EEDB5A6B0BFF} Name OwnerReactionType', value: 'like' },
];

function make_message(message_id: string): MailMessage {
  return {
    message_id,
    folder_id: 'folder-1',
    subject: 'Hi',
    received_at: new Date('2026-03-10T14:30:22.000Z'),
    size_bytes: 42,
    raw_body: Buffer.from(`{"id":"${message_id}"}`),
    has_attachments: false,
  };
}

const PAGE = [make_message('msg-1'), make_message('msg-2'), make_message('msg-3')];

function make_ctx(): TenantContext {
  return {
    tenant_id: 't',
    storage: { exists: vi.fn().mockResolvedValue(true), put: vi.fn() },
    encrypt: vi.fn((data: Buffer) => data),
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

function connector_with(fetch: () => Promise<unknown>): MailboxConnector {
  return { fetch_reaction_properties: vi.fn(fetch) } as unknown as MailboxConnector;
}

describe('reaction capture on backup (issues #481, #513)', () => {
  it('records reactions on the manifest entry', async () => {
    const { manifest_entry } = await store_single_message(
      make_ctx(),
      PAGE[0]!,
      'owner',
      undefined,
      undefined,
      REACTIONS,
    );
    expect(manifest_entry.reaction_properties).toEqual(REACTIONS);
  });

  it('stores nothing extra for a message without reactions', async () => {
    const { manifest_entry } = await store_single_message(
      make_ctx(),
      PAGE[0]!,
      'owner',
      undefined,
      undefined,
      [],
    );
    expect(manifest_entry).not.toHaveProperty('reaction_properties');
  });

  it('reads the whole page in one call and counts the messages it could not read', async () => {
    const connector = connector_with(
      async () =>
        new Map([
          ['msg-1', REACTIONS],
          ['msg-3', []],
        ]),
    );

    const result = await capture_page_reactions(connector, 't', 'owner', PAGE);

    expect(connector.fetch_reaction_properties).toHaveBeenCalledOnce();
    expect(connector.fetch_reaction_properties).toHaveBeenCalledWith('t', 'owner', [
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
    expect(result.by_message.get('msg-1')).toEqual(REACTIONS);
    expect(result.failed).toBe(1);
  });

  it('counts every message on the page when the read fails, and keeps the messages', async () => {
    const connector = connector_with(() => Promise.reject(new Error('Graph 503')));

    const result = await capture_page_reactions(connector, 't', 'owner', PAGE);

    expect(result.by_message.size).toBe(0);
    expect(result.failed).toBe(3);
  });

  it('counts nothing when the connector cannot read reactions at all', async () => {
    const connector = connector_with(async () => undefined);

    await expect(capture_page_reactions(connector, 't', 'owner', PAGE)).resolves.toMatchObject({
      failed: 0,
    });
  });

  it('propagates a permission failure instead of silently dropping reactions', async () => {
    const connector = connector_with(() => Promise.reject(new AuthError('denied')));
    await expect(capture_page_reactions(connector, 't', 'owner', PAGE)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
