import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  Manifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { restore_mailbox_config_snapshot } from '@/services/restore/restore-mailbox-config-snapshot';
import { create_mailbox_sync_harness } from '../backup/mailbox-sync.fixtures';

const owner_id = 'john.doe@example.com';
const document: MailboxConfigDocument = {
  message_rules: [],
  master_categories: [{ displayName: 'Example Category', color: 'preset2' }],
  mailbox_settings: {},
  rule_folder_paths: {},
};
const bytes = Buffer.from(JSON.stringify(document));
const checksum = createHash('sha256').update(bytes).digest('hex');

function manifest(snapshot_id: string, created_at: string, with_config: boolean): Manifest {
  return {
    id: snapshot_id,
    tenant_id: 'tenant',
    owner_id,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    entries: [],
    ...(with_config
      ? {
          mailbox_config: {
            storage_key: `mailbox-config/${owner_id}/${checksum}`,
            checksum,
            size_bytes: bytes.length,
            captured_at: created_at,
          },
        }
      : {}),
  };
}

function setup(stored: Buffer, target_has_config = false) {
  const harness = create_mailbox_sync_harness();
  const older = manifest('older', '2026-09-01T00:00:00Z', true);
  const target = manifest('target', '2026-09-02T00:00:00Z', target_has_config);
  vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(target);
  vi.mocked(harness.mock_manifests.list_all_manifests).mockResolvedValue([target, older]);
  vi.mocked(harness.mock_context.storage.get).mockResolvedValue(
    Buffer.concat([Buffer.from('E'), stored]),
  );
  const config: MailboxConfigConnector = {
    fetch_mailbox_config: vi.fn().mockResolvedValue({
      message_rules: [],
      master_categories: [],
      mailbox_settings: {},
    }),
    create_master_category: vi.fn(),
    update_master_category_color: vi.fn(),
    update_mailbox_settings: vi.fn(),
    create_message_rule: vi.fn(),
    update_message_rule: vi.fn(),
  };
  const tenant_factory: TenantContextFactory = {
    create: vi.fn(async () => harness.mock_context),
    create_readonly: vi.fn(async () => harness.mock_context),
    create_storage_only: vi.fn(async () => harness.mock_context),
  };
  const deps = {
    tenant_factory,
    manifests: harness.mock_manifests,
    mailbox_connector: harness.mock_connector,
    config_connector: config,
  };
  return { harness, config, deps };
}

describe('restore_mailbox_config_snapshot', () => {
  it('restores the configuration inherited from an older snapshot into the owner by default', async () => {
    const { harness, config, deps } = setup(bytes);

    const result = await restore_mailbox_config_snapshot(deps, 'tenant', 'target');

    expect(result.categories_restored).toBe(1);
    expect(config.create_master_category).toHaveBeenCalledWith('tenant', owner_id, {
      displayName: 'Example Category',
      color: 'preset2',
    });
    expect(harness.mock_context.destroy).toHaveBeenCalledOnce();
  });

  it('writes into another mailbox only when a target is named', async () => {
    const { harness, config, deps } = setup(bytes);

    await restore_mailbox_config_snapshot(deps, 'tenant', 'target', {
      target_mailbox: 'Jane.Roe@example.com',
    });

    expect(harness.mock_connector.mailbox_exists).toHaveBeenCalledWith(
      'tenant',
      'jane.roe@example.com',
    );
    expect(vi.mocked(config.create_master_category).mock.calls[0]?.[1]).toBe(
      'jane.roe@example.com',
    );
  });

  it('refuses a stored document that does not match its manifest checksum', async () => {
    const { config, deps } = setup(Buffer.from('{"tampered":true}'));

    await expect(restore_mailbox_config_snapshot(deps, 'tenant', 'target')).rejects.toThrow(
      'checksum does not match',
    );
    expect(config.fetch_mailbox_config).not.toHaveBeenCalled();
  });

  it('reports a snapshot chain without configuration as not found', async () => {
    const { harness, deps } = setup(bytes);
    vi.mocked(harness.mock_manifests.list_all_manifests).mockResolvedValue([
      manifest('target', '2026-09-02T00:00:00Z', false),
    ]);

    await expect(restore_mailbox_config_snapshot(deps, 'tenant', 'target')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
