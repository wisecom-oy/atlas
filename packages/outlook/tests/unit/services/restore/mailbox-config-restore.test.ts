import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  MailboxConfigSource,
  MailboxConnector,
} from '@wisecom/atlas-types';
import { restore_mailbox_config_document } from '@/services/restore/mailbox-config-restore';

const target_id = 'jane.roe@example.com';

const snapshot: MailboxConfigDocument = {
  master_categories: [
    { id: 'src-1', displayName: 'Unchanged', color: 'preset0' },
    { id: 'src-2', displayName: 'Recoloured', color: 'preset4' },
    { id: 'src-3', displayName: 'Missing', color: 'preset7' },
  ],
  mailbox_settings: {
    timeZone: 'W. Europe Standard Time',
    language: { locale: 'en-US' },
    userPurpose: 'user',
  },
  message_rules: [
    {
      id: 'rule-1',
      displayName: 'File invoices',
      sequence: 1,
      isEnabled: true,
      hasError: false,
      conditions: { subjectContains: ['Invoice'] },
      actions: { moveToFolder: 'src-folder', stopProcessingRules: true },
    },
    { id: 'rule-2', displayName: 'Archive reports', actions: { copyToFolder: 'gone-folder' } },
    { id: 'rule-3', displayName: 'Flag reviews', actions: { markImportance: 'high' } },
  ],
  rule_folder_paths: { 'src-folder': 'Inbox/Example Folder', 'gone-folder': 'Old Folder' },
};

const current: MailboxConfigSource = {
  master_categories: [
    { id: 'tgt-1', displayName: 'Unchanged', color: 'preset0' },
    { id: 'tgt-2', displayName: 'Recoloured', color: 'preset1' },
  ],
  mailbox_settings: { timeZone: 'UTC', language: { locale: 'en-US' }, userPurpose: 'shared' },
  message_rules: [
    { id: 'tgt-rule', displayName: 'Flag reviews', actions: { markImportance: 'high' } },
  ],
};

function connectors(): { config: MailboxConfigConnector; mailbox: MailboxConnector } {
  const config: MailboxConfigConnector = {
    fetch_mailbox_config: vi.fn().mockResolvedValue(current),
    create_master_category: vi.fn(),
    update_master_category_color: vi.fn(),
    update_mailbox_settings: vi.fn(),
    create_message_rule: vi.fn(),
    update_message_rule: vi.fn(),
  };
  const mailbox = {
    list_mail_folders: vi.fn().mockResolvedValue([
      {
        folder_id: 'tgt-folder',
        display_name: 'Example Folder',
        folder_path: 'inbox/example folder',
        total_item_count: 0,
      },
    ]),
  } as Partial<MailboxConnector> as MailboxConnector;
  return { config, mailbox };
}

describe('restore_mailbox_config_document', () => {
  it('writes categories, then settings, then rules, touching only what differs', async () => {
    const { config, mailbox } = connectors();

    const outcome = await restore_mailbox_config_document(
      { config, mailbox, tenant_id: 'tenant', target_id },
      snapshot,
    );

    expect(config.update_master_category_color).toHaveBeenCalledWith(
      'tenant',
      target_id,
      'tgt-2',
      'preset4',
    );
    expect(config.create_master_category).toHaveBeenCalledWith('tenant', target_id, {
      displayName: 'Missing',
      color: 'preset7',
    });
    expect(config.update_mailbox_settings).toHaveBeenCalledWith('tenant', target_id, {
      timeZone: 'W. Europe Standard Time',
    });
    expect(config.create_message_rule).toHaveBeenCalledOnce();
    expect(config.update_message_rule).not.toHaveBeenCalled();
    const [category_order] = vi.mocked(config.create_master_category).mock.invocationCallOrder;
    const [settings_order] = vi.mocked(config.update_mailbox_settings).mock.invocationCallOrder;
    const [rule_order] = vi.mocked(config.create_message_rule).mock.invocationCallOrder;
    expect(category_order).toBeLessThan(settings_order!);
    expect(settings_order).toBeLessThan(rule_order!);
    expect(outcome).toMatchObject({
      categories_restored: 2,
      settings_restored: true,
      rules_restored: 1,
      errors: [],
    });
  });

  it('remaps rule folders by path and skips rules whose folder the target lacks', async () => {
    const { config, mailbox } = connectors();

    const outcome = await restore_mailbox_config_document(
      { config, mailbox, tenant_id: 'tenant', target_id },
      snapshot,
    );

    expect(config.create_message_rule).toHaveBeenCalledWith('tenant', target_id, {
      displayName: 'File invoices',
      sequence: 1,
      isEnabled: true,
      conditions: { subjectContains: ['Invoice'] },
      actions: { moveToFolder: 'tgt-folder', stopProcessingRules: true },
    });
    expect(outcome.skipped_rules).toEqual([
      {
        name: 'Archive reports',
        reason: 'copyToFolder targets folder "Old Folder", which the target mailbox lacks',
      },
    ]);
  });

  it('keeps going after one failed write and fails outright on a missing grant', async () => {
    const { config, mailbox } = connectors();
    vi.mocked(config.create_master_category).mockRejectedValueOnce(new Error('Conflict'));

    const outcome = await restore_mailbox_config_document(
      { config, mailbox, tenant_id: 'tenant', target_id },
      snapshot,
    );
    expect(outcome.errors).toEqual(['Category "Missing": Conflict']);
    expect(outcome.rules_restored).toBe(1);

    vi.mocked(config.update_mailbox_settings).mockRejectedValueOnce(new AuthError('denied'));
    await expect(
      restore_mailbox_config_document(
        { config, mailbox, tenant_id: 'tenant', target_id },
        snapshot,
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
