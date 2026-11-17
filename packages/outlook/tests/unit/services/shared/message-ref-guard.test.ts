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
import {
  refuse_blank_message_ref,
  refuse_message_ref_in_mailbox_mode,
} from '@/services/shared/message-ref-guard';
import {
  make_restore_entry,
  make_restore_harness,
  make_restore_manifest,
  type RestoreHarness,
} from '../restore/restore.service.fixtures';

/**
 * Issue #705 at the service layer, which the SDK reaches without the CLI's flag check. A message
 * reference in mailbox mode, or a blank one in snapshot mode, used to widen to every message.
 */
const OWNER = 'john.doe@example.com';
const BLANK_REFS = ['', '   '];

describe('refuse_message_ref_in_mailbox_mode', () => {
  it('accepts an absent message reference', () => {
    expect(() => refuse_message_ref_in_mailbox_mode(undefined)).not.toThrow();
  });

  it.each(['1', ''])('refuses message reference %j with a ConfigError', (message_ref) => {
    expect(() => refuse_message_ref_in_mailbox_mode(message_ref)).toThrow(ConfigError);
  });
});

describe('refuse_blank_message_ref', () => {
  it.each([undefined, '1', 'AAMkAGI2'])('accepts message reference %j', (message_ref) => {
    expect(() => refuse_blank_message_ref(message_ref)).not.toThrow();
  });

  it.each(BLANK_REFS)('refuses blank message reference %j with a ConfigError', (message_ref) => {
    expect(() => refuse_blank_message_ref(message_ref)).toThrow(ConfigError);
  });
});

describe('RestoreService message_ref guards', () => {
  let harness: RestoreHarness;

  beforeEach(() => {
    harness = make_restore_harness();
    const manifest = make_restore_manifest([make_restore_entry('msg-1', 'f1')]);
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
    vi.mocked(harness.mock_manifests.list_by_owner).mockResolvedValue([manifest]);
  });

  it.each(['1', ''])(
    'restore_mailbox rejects message_ref %j before reading storage, calling Graph, or writing',
    async (message_ref) => {
      await expect(
        harness.service.restore_mailbox('test-tenant', OWNER, { message_ref }),
      ).rejects.toThrow(ConfigError);

      expect(harness.mock_manifests.list_by_owner).not.toHaveBeenCalled();
      expect(harness.mock_connector.mailbox_exists).not.toHaveBeenCalled();
      expect(harness.mock_restore.create_message).not.toHaveBeenCalled();
    },
  );

  it.each(BLANK_REFS)(
    'restore_snapshot rejects blank message_ref %j before reading storage or writing',
    async (message_ref) => {
      await expect(
        harness.service.restore_snapshot('test-tenant', 'snap-1', { message_ref }),
      ).rejects.toThrow(ConfigError);

      expect(harness.mock_manifests.find_by_snapshot).not.toHaveBeenCalled();
      expect(harness.mock_restore.create_message).not.toHaveBeenCalled();
    },
  );
});

describe('SaveService message_ref guards', () => {
  let mock_manifests: ManifestRepository;
  let service: SaveService;

  beforeEach(() => {
    const ctx = stub_tenant_context().ctx;
    const factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(ctx),
      create_readonly: vi.fn().mockResolvedValue(ctx),
      create_storage_only: vi.fn().mockResolvedValue(ctx),
    };
    mock_manifests = {
      list_by_owner: vi.fn(),
      find_by_snapshot: vi.fn(),
    } as unknown as ManifestRepository;

    const container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue({} as MailboxConnector);
    container.bind(SaveService).toSelf();
    service = container.get(SaveService);
  });

  it.each(['1', ''])(
    'save_mailbox rejects message_ref %j before reading storage and settles the stream',
    async (message_ref) => {
      const sink = new PassThrough();

      await expect(
        service.save_mailbox('test-tenant', OWNER, { message_ref, output: sink }),
      ).rejects.toThrow(ConfigError);

      expect(mock_manifests.list_by_owner).not.toHaveBeenCalled();
      expect(sink.destroyed).toBe(true);
    },
  );

  it.each(BLANK_REFS)(
    'save_snapshot rejects blank message_ref %j before reading storage and settles the stream',
    async (message_ref) => {
      const sink = new PassThrough();

      await expect(
        service.save_snapshot('test-tenant', 'snap-1', { message_ref, output: sink }),
      ).rejects.toThrow(ConfigError);

      expect(mock_manifests.find_by_snapshot).not.toHaveBeenCalled();
      expect(sink.destroyed).toBe(true);
    },
  );
});
