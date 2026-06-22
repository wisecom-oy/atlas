import { describe, it, expect, vi } from 'vitest';
import { verify_folder_message_count } from '@/services/restore/restore-folder-verifier';
import type { RestoreConnector } from '@wisecom/atlas-types';

function make_restore_connector(
  count_folder_messages: RestoreConnector['count_folder_messages'],
): RestoreConnector {
  return {
    create_mail_folder: vi.fn(),
    create_message: vi.fn(),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages,
    list_folder_messages: vi.fn(),
  };
}

describe('verify_folder_message_count', () => {
  const tenant_id = 'tenant-1';
  const mailbox_id = 'user@test.com';
  const folder_id = 'folder-abc';
  const folder_name = 'Inbox';

  it('returns missing 0 when remote count >= attempted', async () => {
    const connector = make_restore_connector(vi.fn().mockResolvedValue(10));

    const result = await verify_folder_message_count(
      connector,
      tenant_id,
      mailbox_id,
      folder_id,
      10,
      folder_name,
    );

    expect(result).toEqual({ missing: 0, api_failed: false });
    expect(connector.count_folder_messages).toHaveBeenCalledWith(tenant_id, mailbox_id, folder_id);
  });

  it('returns missing N when remote count < attempted', async () => {
    const connector = make_restore_connector(vi.fn().mockResolvedValue(7));

    const result = await verify_folder_message_count(
      connector,
      tenant_id,
      mailbox_id,
      folder_id,
      10,
      folder_name,
    );

    expect(result).toEqual({ missing: 3, api_failed: false });
  });

  it('returns api_failed true when connector throws', async () => {
    const connector = make_restore_connector(
      vi.fn().mockRejectedValue(new Error('Graph API unavailable')),
    );

    const result = await verify_folder_message_count(
      connector,
      tenant_id,
      mailbox_id,
      folder_id,
      10,
      folder_name,
    );

    expect(result).toEqual({ missing: 0, api_failed: true });
  });
});
