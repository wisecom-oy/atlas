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
  it('returns missing=0, api_failed=false when counts match', async () => {
    const connector = make_connector(5);
    const result = await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(result).toEqual({ missing: 0, api_failed: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns missing=0 when remote count exceeds attempted', async () => {
    const connector = make_connector(10);
    const result = await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(result).toEqual({ missing: 0, api_failed: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns missing count when remote is less than attempted', async () => {
    const connector = make_connector(3);
    const result = await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(result).toEqual({ missing: 2, api_failed: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 message(s) may not have persisted'),
    );
  });

  it('returns api_failed=true when count_folder_messages throws', async () => {
    const connector = make_connector(0);
    (connector.count_folder_messages as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Graph timeout'),
    );
    const result = await verify_folder_message_count(connector, 't1', 'mb1', 'f1', 5, 'Inbox');
    expect(result).toEqual({ missing: 0, api_failed: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unable to confirm message count'),
    );
  });
});
