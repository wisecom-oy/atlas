import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core';
import { report_drive_restore, type DriveRestoreSummary } from '@/commands/drive/restore-presenter';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => undefined) }));

/**
 * Issue #631 through the shared drive restore presenter from #682: a restore that ran past a
 * damaged manifest names its key and exits 9. A failed file exits 2, as Outlook restore does
 * (issue #712), and that partial code wins over 9 because the restore itself is incomplete.
 */
const DAMAGED_KEY = 'onedrive/manifests/owner-1/od-snap-1700000000000-abc.json';
const EXIT_CONTENT_UNREADABLE = 9;

function summary(overrides: Partial<DriveRestoreSummary> = {}): DriveRestoreSummary {
  return {
    snapshot_id: 'snap-1',
    files_restored: 2,
    folders_created: 1,
    files_skipped: 0,
    errors: [],
    interrupted: false,
    ...overrides,
  };
}

let error_spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.exitCode = undefined;
  error_spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'success').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('report_drive_restore unreadable keys', () => {
  it('names a damaged manifest the restore skipped and exits 9', async () => {
    await report_drive_restore('Restore', summary({ unreadable_keys: [DAMAGED_KEY] }), []);

    const lines = error_spy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.some((line: string) => line.includes(DAMAGED_KEY))).toBe(true);
    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
  });

  it('exits partial when the restore also had a failed file', async () => {
    await report_drive_restore(
      'Restore',
      summary({ unreadable_keys: [DAMAGED_KEY], errors: ['file-1: upload failed'] }),
      [],
    );

    expect(process.exitCode).toBe(2);
  });

  it('leaves a clean restore at exit 0', async () => {
    await report_drive_restore('Restore', summary(), []);

    expect(error_spy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('report_drive_restore unmatched file filters (issue #707)', () => {
  it('names each unmatched value, exits 2 and does not report success', async () => {
    await report_drive_restore(
      'Restore',
      summary({ unmatched_file_filters: ['/no/such.txt'] }),
      [],
    );

    const lines = error_spy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.some((line: string) => line.includes('"/no/such.txt"'))).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(logger.success).not.toHaveBeenCalled();
  });

  it('exits partial when the restore also had a failed file', async () => {
    await report_drive_restore(
      'Restore',
      summary({ unmatched_file_filters: ['/no/such.txt'], errors: ['file-1: upload failed'] }),
      [],
    );

    expect(process.exitCode).toBe(2);
  });
});

describe('report_drive_restore damaged content object (issue #712)', () => {
  it('lists the damaged file and exits 2, the code its skip line prints', async () => {
    await report_drive_restore(
      'Restore',
      summary({
        files_skipped: 1,
        errors: ['file-2.txt: stored object failed AES-GCM authentication; skipped'],
      }),
      [],
    );

    const lines = error_spy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toContain('Files skipped: 1 -- exit 2');
    expect(process.exitCode).toBe(2);
    expect(logger.success).not.toHaveBeenCalled();
  });
});
