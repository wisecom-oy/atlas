import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector, MailMessage, TenantContext } from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import {
  capture_reaction_properties,
  store_single_message,
} from '@/services/backup/message-payload-store';

const REACTIONS = [
  { id: 'String {41F28F13-83F4-4114-A584-EEDB5A6B0BFF} Name OwnerReactionType', value: 'like' },
];

const MESSAGE: MailMessage = {
  message_id: 'msg-1',
  folder_id: 'folder-1',
  subject: 'Hi',
  received_at: new Date('2026-03-10T14:30:22.000Z'),
  size_bytes: 42,
  raw_body: Buffer.from('{"id":"msg-1"}'),
  has_attachments: false,
};

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

describe('reaction capture on backup (issue #481)', () => {
  it('records reactions on the manifest entry', async () => {
    const { manifest_entry } = await store_single_message(
      make_ctx(),
      MESSAGE,
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
      MESSAGE,
      'owner',
      undefined,
      undefined,
      [],
    );
    expect(manifest_entry).not.toHaveProperty('reaction_properties');
  });

  it('loses only the reactions when the fetch fails for this message', async () => {
    const connector = connector_with(() => Promise.reject(new Error('ErrorItemNotFound')));
    await expect(capture_reaction_properties(connector, 't', 'owner', MESSAGE)).resolves.toEqual(
      [],
    );
  });

  it('propagates a permission failure instead of silently dropping reactions', async () => {
    const connector = connector_with(() => Promise.reject(new AuthError('denied')));
    await expect(
      capture_reaction_properties(connector, 't', 'owner', MESSAGE),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
