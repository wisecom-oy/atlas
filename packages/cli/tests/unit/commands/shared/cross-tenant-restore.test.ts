import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN, GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import {
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_contacts_command } from '@/commands/contacts/contacts.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';

const compose_target_container = vi.hoisted(() => vi.fn());
vi.mock('@/container', () => ({ compose_target_container }));

type Binding = readonly [symbol, unknown];
type Register = (program: Command, get_container: () => Container) => void;

/** A container with the source tenant's config plus the given service bindings. */
function make_container(tenant_id: string, bindings: Binding[]): Container {
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id });
  for (const [token, value] of bindings) container.bind(token).toConstantValue(value);
  return container;
}

async function run(register: Register, container: Container, args: string[]): Promise<void> {
  const program = new Command();
  register(program, () => container);
  await program.parseAsync(args, { from: 'user' });
}

function outlook_result(): Record<string, unknown> {
  return {
    snapshot_id: 'snap-1',
    restored_count: 0,
    attachment_count: 0,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    restore_folder_name: 'Restore-2026',
    interrupted: false,
  };
}

describe('cross-tenant restore with --target-profile', () => {
  let previous_exit_code: typeof process.exitCode;

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    process.exitCode = undefined;
    compose_target_container.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previous_exit_code;
  });

  describe('outlook restore', () => {
    it('writes through the target profile container and keeps the source tenant', async () => {
      const source_restore = { restore_snapshot: vi.fn() };
      const target_restore = { restore_snapshot: vi.fn().mockResolvedValue(outlook_result()) };
      const source = make_container('tenant-src', [[RESTORE_USE_CASE_TOKEN, source_restore]]);
      const target = make_container('tenant-dst', [[RESTORE_USE_CASE_TOKEN, target_restore]]);
      compose_target_container.mockReturnValue(target);

      await run(register_outlook_command, source, [
        'outlook',
        'restore',
        '-s',
        'snap-1',
        '-T',
        'dst@example.com',
        '--target-profile',
        'ops',
      ]);

      expect(compose_target_container).toHaveBeenCalledWith({ tenant_id: 'tenant-src' }, 'ops');
      expect(target_restore.restore_snapshot).toHaveBeenCalledWith(
        'tenant-src',
        'snap-1',
        expect.objectContaining({ target_mailbox: 'dst@example.com' }),
      );
      expect(source_restore.restore_snapshot).not.toHaveBeenCalled();
    });

    it('rejects --target-profile without -T before composing any container', async () => {
      const source_restore = { restore_snapshot: vi.fn() };
      const source = make_container('tenant-src', [[RESTORE_USE_CASE_TOKEN, source_restore]]);

      await expect(
        run(register_outlook_command, source, [
          'outlook',
          'restore',
          '-s',
          'snap-1',
          '--target-profile',
          'ops',
        ]),
      ).rejects.toThrow('--target-profile requires -T/--target');

      expect(compose_target_container).not.toHaveBeenCalled();
      expect(source_restore.restore_snapshot).not.toHaveBeenCalled();
    });

    it('uses the source container when no target profile is given', async () => {
      const source_restore = { restore_snapshot: vi.fn().mockResolvedValue(outlook_result()) };
      const source = make_container('tenant-src', [[RESTORE_USE_CASE_TOKEN, source_restore]]);

      await run(register_outlook_command, source, ['outlook', 'restore', '-s', 'snap-1']);

      expect(compose_target_container).not.toHaveBeenCalled();
      expect(source_restore.restore_snapshot).toHaveBeenCalledWith(
        'tenant-src',
        'snap-1',
        expect.not.objectContaining({ target_mailbox: expect.anything() }),
      );
    });
  });

  describe('onedrive restore', () => {
    it('resolves the target owner through the target container and the source owner through the source', async () => {
      const source_resolve = vi
        .fn()
        .mockResolvedValue({ object_id: 'src-id', display_name: 'Src', email: 'src@example.com' });
      const target_resolve = vi
        .fn()
        .mockResolvedValue({ object_id: 'dst-id', display_name: 'Dst', email: 'dst@example.com' });
      const source_restore = { restore_onedrive: vi.fn() };
      const target_restore = {
        restore_onedrive: vi.fn().mockResolvedValue({
          snapshot_id: 'snap-1',
          files_restored: 0,
          folders_created: 0,
          files_skipped: [],
          errors: [],
        }),
      };
      const source = make_container('tenant-src', [
        [USER_IDENTITY_RESOLVER_TOKEN, { resolve_user: source_resolve }],
        [ONEDRIVE_RESTORE_USE_CASE_TOKEN, source_restore],
      ]);
      const target = make_container('tenant-dst', [
        [GRAPH_IDENTITY_RESOLVER_TOKEN, { resolve_user: target_resolve }],
        [ONEDRIVE_RESTORE_USE_CASE_TOKEN, target_restore],
      ]);
      compose_target_container.mockReturnValue(target);

      await run(register_onedrive_command, source, [
        'onedrive',
        'restore',
        '-o',
        'src@example.com',
        '-s',
        'snap-1',
        '--target-owner',
        'dst@example.com',
        '--target-profile',
        'ops',
      ]);

      expect(compose_target_container).toHaveBeenCalledWith({ tenant_id: 'tenant-src' }, 'ops');
      expect(source_resolve).toHaveBeenCalledWith('tenant-src', 'src@example.com');
      expect(target_resolve).toHaveBeenCalledWith('tenant-src', 'dst@example.com');
      expect(target_restore.restore_onedrive).toHaveBeenCalledWith(
        'tenant-src',
        'src-id',
        expect.objectContaining({ snapshot_id: 'snap-1', target_owner_id: 'dst-id' }),
      );
      expect(source_restore.restore_onedrive).not.toHaveBeenCalled();
    });

    it('rejects --target-profile without --target-owner before composing any container', async () => {
      const source_restore = { restore_onedrive: vi.fn() };
      const source = make_container('tenant-src', [
        [ONEDRIVE_RESTORE_USE_CASE_TOKEN, source_restore],
      ]);

      await expect(
        run(register_onedrive_command, source, [
          'onedrive',
          'restore',
          '-o',
          'src-id',
          '-s',
          'snap-1',
          '--target-profile',
          'ops',
        ]),
      ).rejects.toThrow('--target-profile requires --target-owner');

      expect(compose_target_container).not.toHaveBeenCalled();
      expect(source_restore.restore_onedrive).not.toHaveBeenCalled();
    });

    it('uses the source container when no target profile is given', async () => {
      const source_restore = {
        restore_onedrive: vi.fn().mockResolvedValue({
          snapshot_id: 'snap-1',
          files_restored: 0,
          folders_created: 0,
          files_skipped: [],
          errors: [],
        }),
      };
      const source = make_container('tenant-src', [
        [USER_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
        [ONEDRIVE_RESTORE_USE_CASE_TOKEN, source_restore],
      ]);

      await run(register_onedrive_command, source, [
        'onedrive',
        'restore',
        '-o',
        'src-id',
        '-s',
        'snap-1',
      ]);

      expect(compose_target_container).not.toHaveBeenCalled();
      expect(source_restore.restore_onedrive).toHaveBeenCalledWith(
        'tenant-src',
        'src-id',
        expect.objectContaining({ snapshot_id: 'snap-1' }),
      );
    });
  });

  describe('contacts restore', () => {
    it('writes through the target profile container with the source tenant', async () => {
      const source_restore = { restore_contacts: vi.fn() };
      const target_restore = {
        restore_contacts: vi.fn().mockResolvedValue({
          snapshot_id: 'snap-1',
          contacts_restored: 0,
          contacts_skipped: 0,
          folders_created: 0,
          errors: [],
          interrupted: false,
        }),
      };
      const source = make_container('tenant-src', [
        [USER_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
        [CONTACTS_RESTORE_USE_CASE_TOKEN, source_restore],
      ]);
      const target = make_container('tenant-dst', [
        [GRAPH_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
        [CONTACTS_RESTORE_USE_CASE_TOKEN, target_restore],
      ]);
      compose_target_container.mockReturnValue(target);

      await run(register_contacts_command, source, [
        'contacts',
        'restore',
        '-m',
        'src-id',
        '-s',
        'snap-1',
        '-T',
        'dst-id',
        '--target-profile',
        'ops',
      ]);

      expect(target_restore.restore_contacts).toHaveBeenCalledWith(
        'tenant-src',
        'src-id',
        expect.objectContaining({ snapshot_id: 'snap-1', target_mailbox_id: 'dst-id' }),
      );
      expect(source_restore.restore_contacts).not.toHaveBeenCalled();
    });
  });

  describe('sharepoint restore', () => {
    it('rejects --target-profile without --target-site before composing any container', async () => {
      const source = make_container('tenant-src', []);

      await expect(
        run(register_sharepoint_command, source, [
          'sharepoint',
          'restore',
          '--site',
          'https://example.sharepoint.com/sites/team',
          '-s',
          'snap-1',
          '--target-profile',
          'ops',
        ]),
      ).rejects.toThrow('--target-profile requires --target-site');

      expect(compose_target_container).not.toHaveBeenCalled();
    });
  });
});
