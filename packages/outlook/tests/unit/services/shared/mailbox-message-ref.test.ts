import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  ConfigError,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  ManifestRepository,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { SaveService } from '@/services/save/save.service';
import { refuse_message_ref_in_mailbox_mode } from '@/services/shared/mailbox-entry-resolver';
import {
  make_restore_entry,
  make_restore_harness,
  make_restore_manifest,
  type RestoreHarness,
} from '../restore/restore.service.fixtures';

/**
 * Issue #705 at the service layer, which the SDK reaches without the CLI's flag check:
 * `restoreMailbox` and `saveMailbox` with `messageRef` used to process the whole mailbox.
 */
const OWNER = 'john.doe@example.com';

describe('refuse_message_ref_in_mailbox_mode', () => {
  it('accepts options without a message reference', () => {
    expect(() => refuse_message_ref_in_mailbox_mode({})).not.toThrow();
    expect(() => refuse_message_ref_in_mailbox_mode({ message_ref: '' })).not.toThrow();
  });

  it('refuses a message reference with a ConfigError', () => {
    expect(() => refuse_message_ref_in_mailbox_mode({ message_ref: '1' })).toThrow(ConfigError);
  });
});

describe('RestoreService.restore_mailbox with message_ref', () => {
  let harness: RestoreHarness;

  beforeEach(() => {
    harness = make_restore_harness();
    const manifest = make_restore_manifest([make_restore_entry('msg-1', 'f1')]);
    vi.mocked(harness.mock_manifests.list_by_owner).mockResolvedValue([manifest]);
  });

  it('rejects before reading storage, calling Graph, or writing a message', async () => {
    await expect(
      harness.service.restore_mailbox('test-tenant', OWNER, { message_ref: '1' }),
    ).rejects.toThrow(ConfigError);

    expect(harness.mock_manifests.list_by_owner).not.toHaveBeenCalled();
    expect(harness.mock_connector.mailbox_exists).not.toHaveBeenCalled();
    expect(harness.mock_restore.create_message).not.toHaveBeenCalled();
  });
});

describe('SaveService.save_mailbox with message_ref', () => {
  let mock_manifests: ManifestRepository;
  let service: SaveService;

  beforeEach(() => {
    const ctx = stub_tenant_context().ctx;
    const factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(ctx),
      create_readonly: vi.fn().mockResolvedValue(ctx),
      create_storage_only: vi.fn().mockResolvedValue(ctx),
    };
    mock_manifests = { list_by_owner: vi.fn() } as unknown as ManifestRepository;

    const container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue({} as MailboxConnector);
    container.bind(SaveService).toSelf();
    service = container.get(SaveService);
  });

  it('rejects before reading storage and settles the caller stream', async () => {
    const sink = new PassThrough();

    await expect(
      service.save_mailbox('test-tenant', OWNER, { message_ref: '1', output: sink }),
    ).rejects.toThrow(ConfigError);

    expect(mock_manifests.list_by_owner).not.toHaveBeenCalled();
    expect(sink.destroyed).toBe(true);
  });
});
