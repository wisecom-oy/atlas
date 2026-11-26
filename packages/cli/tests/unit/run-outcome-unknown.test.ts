import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core';
import { report_run_outcome, RESTORE_WRITES_SENT_ONCE_URL } from '@/command-run-outcome';
import { report_drive_restore, type DriveRestoreSummary } from '@/commands/drive/restore-presenter';

/**
 * Issue #893. A restore whose create may have committed printed the same error line as one Graph
 * refused. The summary now says how many items may exist in the target and where to read what to
 * check, and the exit code stays 2.
 */
vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

let warn_spy: ReturnType<typeof vi.spyOn>;
let error_spy: ReturnType<typeof vi.spyOn>;

function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

beforeEach(() => {
  process.exitCode = undefined;
  warn_spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  error_spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'success').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('report_run_outcome with outcome-unknown items (issue #893)', () => {
  it('counts the messages that may exist, points to troubleshooting, and keeps exit 2', () => {
    report_run_outcome(
      {
        errors: [
          'msg-1: outcome unknown, the item may exist: the create request ended with HTTP 504',
          'msg-2: Graph refused the create (400)',
        ],
        warnings: [],
        outcome_unknown: 1,
      },
      'message',
    );

    expect(lines(warn_spy)).toContain(
      'Outcome unknown: 1 message(s) may exist in the target although the restore reported an ' +
        `error. Check the target before restoring them again: ${RESTORE_WRITES_SENT_ONCE_URL}`,
    );
    expect(lines(error_spy)).toContain('Run incomplete: 2 message error(s) -- exit 2');
    expect(process.exitCode).toBe(2);
  });

  it('prints no outcome-unknown line when every failure was a refusal', () => {
    report_run_outcome(
      { errors: ['msg-2: Graph refused the create (400)'], warnings: [], outcome_unknown: 0 },
      'message',
    );

    expect(lines(warn_spy).some((line) => line.startsWith('Outcome unknown'))).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it('points to the troubleshooting section on restore writes', () => {
    expect(RESTORE_WRITES_SENT_ONCE_URL).toBe(
      'https://docs.atlas.wisecom.fi/troubleshooting#restore-writes-are-sent-once',
    );
  });
});

describe('report_drive_restore with outcome-unknown files (issue #893)', () => {
  it('counts the files that may exist and exits 2', async () => {
    const error = 'Report.docx: outcome unknown, the item may exist: the create request ended';
    const summary: DriveRestoreSummary = {
      snapshot_id: 'snap-1',
      files_restored: 1,
      folders_created: 0,
      files_skipped: 1,
      errors: [error],
      outcome_unknown: [{ path: '/Restore/Docs/Report.docx', error }],
      interrupted: false,
    };

    await report_drive_restore('Restore', summary, []);

    expect(lines(warn_spy)).toContain(
      'Outcome unknown: 1 file(s) may exist in the target although the restore reported an ' +
        `error. Check the target before restoring them again: ${RESTORE_WRITES_SENT_ONCE_URL}`,
    );
    expect(process.exitCode).toBe(2);
  });
});
