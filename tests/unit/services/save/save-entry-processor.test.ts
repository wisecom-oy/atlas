import { describe, it, expect, vi, beforeEach } from 'vitest';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import { compute_sha256 } from '@/services/save/save-integrity-validator';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ManifestEntry } from '@/domain/manifest';
import type { SaveProgressDashboard } from '@/services/save/save-progress-dashboard';

vi.mock(
  '@/services/save/save-zip-writer',
  (): Record<string, unknown> => ({
    create_save_archive: (): { archive: object; promise: Promise<number> } => ({
      archive: {},
      promise: Promise.resolve(128),
    }),
    add_eml_to_archive: vi.fn().mockResolvedValue(undefined),
    finalize_archive: vi.fn().mockResolvedValue(undefined),
  }),
);

function make_message_body(): Record<string, unknown> {
  return {
    subject: 'Hello',
    body: { content: 'World', contentType: 'text' },
    receivedDateTime: '2026-01-01T12:00:00Z',
  };
}

function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  const json = JSON.stringify(make_message_body());
  const plaintext = Buffer.from(json, 'utf-8');
  return {
    object_id: 'obj-1',
    storage_key: 'data/mbox/sha',
    checksum: compute_sha256(plaintext),
    size_bytes: plaintext.length,
    folder_id: 'fid-1',
    ...overrides,
  };
}

describe('save_entries_to_archive', () => {
  let ctx: TenantContext;
  let dashboard: SaveProgressDashboard;

  beforeEach(() => {
    const plaintext = Buffer.from(JSON.stringify(make_message_body()), 'utf-8');
    ctx = {
      tenant_id: 't',
      storage: {
        get: vi.fn().mockResolvedValue(plaintext),
        put: vi.fn(),
        exists: vi.fn(),
        delete: vi.fn(),
        delete_version: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn(),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn((b: Buffer) => b),
      decrypt: vi.fn((b: Buffer) => b),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    dashboard = {
      mark_active: vi.fn(),
      update_active: vi.fn(),
      mark_done: vi.fn(),
      mark_all_pending_interrupted: vi.fn(),
      mark_error: vi.fn(),
      update_total: vi.fn(),
      finish: vi.fn(),
      show_finalizing: vi.fn(),
    } as unknown as SaveProgressDashboard;
  });

  it('saves one entry and returns counts', async () => {
    const groups = new Map([['fid-1', [make_entry()]]]);
    const folder_map = new Map([['fid-1', 'Inbox']]);

    const result = await save_entries_to_archive(
      ctx,
      '/tmp/out.zip',
      false,
      groups,
      folder_map,
      dashboard,
      () => false,
    );

    expect(result.saved_count).toBe(1);
    expect(result.error_count).toBe(0);
    expect(result.total_bytes).toBe(128);
  });

  it('records integrity failure when checksum mismatches', async () => {
    const bad = make_entry({ checksum: '0'.repeat(64) });
    const groups = new Map([['fid-1', [bad]]]);
    const folder_map = new Map([['fid-1', 'Inbox']]);

    const result = await save_entries_to_archive(
      ctx,
      '/tmp/out.zip',
      false,
      groups,
      folder_map,
      dashboard,
      () => false,
    );

    expect(result.integrity_failures.length).toBeGreaterThan(0);
  });

  it('stops when interrupted', async () => {
    const groups = new Map([
      ['a', [make_entry({ object_id: '1' })]],
      ['b', [make_entry({ object_id: '2', folder_id: 'b' })]],
    ]);
    const folder_map = new Map([
      ['a', 'A'],
      ['b', 'B'],
    ]);
    let calls = 0;
    const result = await save_entries_to_archive(
      ctx,
      '/tmp/out.zip',
      false,
      groups,
      folder_map,
      dashboard,
      () => calls++ > 0,
    );

    expect(result.saved_count).toBeLessThan(2);
  });
});
