import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { FollowUpFlag, MailMessage, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { store_single_message } from '@/services/backup/message-payload-store';

const FLAG: FollowUpFlag = {
  status: 'flagged',
  start: { date_time: '2026-11-10T00:00:00.0000000', time_zone: 'UTC' },
  due: { date_time: '2026-11-20T00:00:00.0000000', time_zone: 'UTC' },
};
const PIN = [
  { id: 'SystemTime 0x0F02', value: '4500-09-01T00:00:00Z' },
  { id: 'SystemTime 0x0F01', value: '4500-09-01T00:00:00Z' },
];
const MIME = Buffer.from('From: a@example.com\r\nSubject: Hi\r\n\r\nBody.\r\n');

function make_message(flag?: FollowUpFlag): MailMessage {
  return {
    message_id: 'msg-1',
    folder_id: 'folder-1',
    subject: 'Hi',
    from: { address: 'a@example.com' },
    received_at: new Date('2026-11-01T09:00:00.000Z'),
    ...(flag ? { flag } : {}),
    size_bytes: 42,
    raw_body: Buffer.from('{"id":"msg-1"}'),
    has_attachments: false,
  };
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 't',
    storage: { exists: vi.fn().mockResolvedValue(true), put: vi.fn() },
    encrypt: vi.fn((data: Buffer) => data),
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

/** Issue #579: a MIME entry kept neither the flag's status and dates nor the pin. */
describe('flag and pin capture on backup', () => {
  it('records the flag and the pin on a MIME-backed entry', async () => {
    const { manifest_entry } = await store_single_message(
      make_ctx(),
      make_message(FLAG),
      'owner',
      undefined,
      MIME,
      { reaction_properties: [], pin_properties: PIN },
    );

    expect(manifest_entry.payload_format).toBe('mime');
    expect(manifest_entry.flag).toEqual(FLAG);
    expect(manifest_entry.pin_properties).toEqual(PIN);
  });

  it('records neither for an unflagged, unpinned message', async () => {
    const { manifest_entry } = await store_single_message(
      make_ctx(),
      make_message(),
      'owner',
      undefined,
      MIME,
    );

    expect(manifest_entry).not.toHaveProperty('flag');
    expect(manifest_entry).not.toHaveProperty('pin_properties');
  });
});
