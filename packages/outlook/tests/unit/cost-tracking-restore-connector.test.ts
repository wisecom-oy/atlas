import { describe, it, expect, vi } from 'vitest';
import type { RestoreConnector } from '@wisecom/atlas-types';
import { CostTrackingRestoreConnector } from '@/adapters/cost-tracking-restore-connector.adapter';
import { run_with_cost_tracking } from '@wisecom/atlas-core/services/shared/graph-request-context';

function make_restore_stub(): RestoreConnector {
  return {
    create_mail_folder: vi.fn().mockResolvedValue({
      folder_id: 'f1',
      display_name: 'Test',
      total_item_count: 0,
    }),
    create_message: vi.fn().mockResolvedValue('msg-id'),
    add_attachment: vi.fn().mockResolvedValue(undefined),
    create_upload_session: vi.fn().mockResolvedValue({
      upload_url: 'https://upload.example.com',
      expiration: '',
    }),
    upload_attachment_chunk: vi.fn().mockResolvedValue(undefined),
    count_folder_messages: vi.fn().mockResolvedValue(0),
    list_folder_messages: vi.fn().mockResolvedValue([]),
  };
}

describe('CostTrackingRestoreConnector', () => {
  it('create_mail_folder records to outlook pool', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.create_mail_folder('tenant', 'user@example.com', 'Restore-2026'),
    );
    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['create_folder']).toBe(1);
    expect(cost.by_service.identity).toBeUndefined();
  });

  it('create_message records to outlook pool', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.create_message('tenant', 'user@example.com', 'folder-id', {}),
    );
    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['create_message']).toBe(1);
  });

  it('add_attachment records upload_bytes', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.add_attachment('tenant', 'user@example.com', 'msg-id', {
        name: 'report.pdf',
        content_type: 'application/pdf',
        content: Buffer.alloc(2048),
        is_inline: false,
        content_id: '',
      }),
    );
    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.by_service.outlook?.upload_bytes).toBe(2048);
    expect(cost.requests_by_type['add_attachment']).toBe(1);
  });

  it('create_upload_session records to outlook pool', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.create_upload_session(
        'tenant',
        'user@example.com',
        'msg-id',
        'file.zip',
        10_000_000,
      ),
    );
    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['create_upload_session']).toBe(1);
  });

  it('upload_attachment_chunk records upload_bytes', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    const [, cost] = await run_with_cost_tracking(() =>
      connector.upload_attachment_chunk('https://upload-url', chunk, 0, chunk.length),
    );
    expect(cost.by_service.outlook?.upload_bytes).toBe(4 * 1024 * 1024);
    expect(cost.requests_by_type['upload_chunk']).toBe(1);
  });

  it('accumulates all restore operations correctly', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    const [, cost] = await run_with_cost_tracking(async () => {
      await connector.create_mail_folder('tenant', 'user@example.com', 'Restored');
      await connector.create_message('tenant', 'user@example.com', 'f1', {});
      await connector.create_message('tenant', 'user@example.com', 'f1', {});
      await connector.count_folder_messages('tenant', 'user@example.com', 'f1');
    });

    expect(cost.requests_total).toBe(4);
    expect(cost.by_service.outlook?.requests).toBe(4);
    expect(cost.requests_by_type['create_folder']).toBe(1);
    expect(cost.requests_by_type['create_message']).toBe(2);
    expect(cost.requests_by_type['count_folder_messages']).toBe(1);
  });

  it('does not throw outside a tracking context', async () => {
    const connector = new CostTrackingRestoreConnector(make_restore_stub());
    await expect(
      connector.create_mail_folder('tenant', 'user@example.com', 'Test'),
    ).resolves.toBeDefined();
  });
});
