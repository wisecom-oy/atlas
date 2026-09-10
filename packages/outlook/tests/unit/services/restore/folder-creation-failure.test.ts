import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManifestEntry,
  RestoreConnector,
  TenantContext,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import { execute_restore_loop } from '@/services/restore/restore-loop-executor';

/**
 * Issue #360. `ensure_subfolder` ran outside any error handling, so one Graph 4xx on
 * `create_mail_folder` propagated out of the loop and abandoned every folder after it. The drive
 * restores degrade per folder; this was the one path that discarded the rest of the run.
 */

const MESSAGE = Buffer.from(JSON.stringify({ subject: 'Example subject', parentFolderId: 'f1' }));

function make_entry(object_id: string, folder_id: string): ManifestEntry {
  return {
    object_id,
    storage_key: `data/user/${object_id}`,
    checksum: createHash('sha256').update(MESSAGE).digest('hex'),
    size_bytes: MESSAGE.length,
    folder_id,
  };
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn(async () => MESSAGE), put: vi.fn() },
    encrypt: (data: Buffer) => data,
    decrypt: vi.fn(() => MESSAGE),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_dashboard(): TransferProgressReporter {
  return {
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    finish: vi.fn(),
  } as unknown as TransferProgressReporter;
}

/** Refuses to create exactly one folder, by the display name the folder map gives it. */
function make_connector(refused: string): RestoreConnector {
  return {
    create_mail_folder: vi.fn(async (_t: string, _o: string, name: string, _parent: string) => {
      if (name === refused) throw new Error('ErrorAccessDenied');
      return { folder_id: `created-${name}`, display_name: name };
    }),
    create_message: vi.fn().mockResolvedValue('new-msg'),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
  } as unknown as RestoreConnector;
}

async function run(refused: string): Promise<{
  restored_count: number;
  errors: readonly string[];
  created: readonly string[];
}> {
  const connector = make_connector(refused);
  const groups = new Map<string, ManifestEntry[]>([
    ['f1', [make_entry('msg-1', 'f1')]],
    ['f2', [make_entry('msg-2', 'f2'), make_entry('msg-3', 'f2')]],
    ['f3', [make_entry('msg-4', 'f3')]],
  ]);
  const folder_map = new Map<string, string>([
    ['f1', 'Inbox'],
    ['f2', 'Projects'],
    ['f3', 'Archive'],
  ]);

  const result = await execute_restore_loop(
    make_ctx(),
    connector,
    'tenant-1',
    'john.doe@example.com',
    'snap-1',
    { folder_id: 'root-1', display_name: 'Restore-2026' },
    groups,
    folder_map,
    new Map<string, string>(),
    make_dashboard(),
    {},
  );

  const created = vi.mocked(connector.create_mail_folder).mock.calls.map((call) => String(call[2]));
  return { restored_count: result.restored_count, errors: result.errors, created };
}

describe('a folder that cannot be created during outlook restore', () => {
  it('costs its own messages and leaves the later folders restored', async () => {
    const { restored_count, errors, created } = await run('Projects');

    // Inbox before it and Archive after it both land; only Projects is lost.
    expect(restored_count).toBe(2);
    expect(created).toContain('Archive');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Projects');
  });

  it('names how many messages the failed folder took with it', async () => {
    const { errors } = await run('Projects');

    expect(errors[0]).toContain('2 message(s) not restored');
  });

  it('restores every folder when none of them refuse', async () => {
    const { restored_count, errors } = await run('nothing-refuses-this');

    expect(restored_count).toBe(4);
    expect(errors).toEqual([]);
  });
});
