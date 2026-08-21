import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_PARTIAL, report_skipped_items } from '@/command-run-outcome';

/**
 * Guards the #143 failure mode: `save` and `restore` count a file they could not
 * decrypt as skipped rather than as an error, so a run that dropped everything
 * used to exit 0 and every scheduler saw success.
 */
describe('report_skipped_items', () => {
  let previous: typeof process.exitCode;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previous;
  });

  it('exits partial when items were skipped', () => {
    report_skipped_items(3, 'File');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('leaves a clean run alone', () => {
    report_skipped_items(0, 'File');
    expect(process.exitCode).toBeUndefined();
  });

  it('never downgrades a hard failure to partial', () => {
    process.exitCode = 1;
    report_skipped_items(0, 'File');
    expect(process.exitCode).toBe(1);
  });
});
