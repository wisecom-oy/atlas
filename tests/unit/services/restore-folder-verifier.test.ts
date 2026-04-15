import { describe, it, expect, vi } from 'vitest';
import { verify_folder_message_count } from '@/services/restore/restore-folder-verifier';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import { logger } from '@/utils/logger';

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

function make_connector(count: number): RestoreConnector {
  return {
    create_mail_folder: vi.fn(),
    create_message: vi.fn(),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn().mockResolvedValue(count),
    list_folder_messages: vi.fn().mockResolvedValue([]),
  };
}

describe('verify_folder_message_count', () => {
  it('does not warn when remote count matches attempted', async () => {
    const connector = make_connector(5);
    await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when remote count exceeds attempted', async () => {
    const connector = make_connector(10);
    await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when remote count is less than attempted', async () => {
    const connector = make_connector(3);
    await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 message(s) may not have persisted'),
    );
  });

  it('warns gracefully when count_folder_messages throws', async () => {
    const connector = make_connector(0);
    (connector.count_folder_messages as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Graph timeout'),
    );
    await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unable to confirm message count'),
    );
  });
});
