import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core';
import { report_drive_restore, type DriveRestoreSummary } from '@/commands/drive/restore-presenter';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => undefined) }));

/**
 * Issue #631 through the shared drive restore presenter from #682: a restore that ran past a
 * damaged manifest names its key and exits 9, and errors or an interrupt keep their own code.
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

    const lines = error_spy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes(DAMAGED_KEY))).toBe(true);
    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
  });

  it('keeps exit 1 when the restore also had errors', async () => {
    await report_drive_restore(
      'Restore',
      summary({ unreadable_keys: [DAMAGED_KEY], errors: ['file-1: upload failed'] }),
      [],
    );

    expect(process.exitCode).toBe(1);
  });

  it('leaves a clean restore at exit 0', async () => {
    await report_drive_restore('Restore', summary(), []);

    expect(error_spy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
