import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_PARTIAL, report_run_outcome } from '@/command-run-outcome';

/**
 * Issue #197. The documented contract in `docs/reference/cli.md` is 0 complete,
 * 1 hard failure, 2 partial. Outlook save and restore mapped a per-item failure
 * to 1, which pages an operator for a run that is merely incomplete, and mapped
 * an integrity-only failure to 0, which tells a scheduler that an archive known
 * to be missing verified content is a clean success.
 */
describe('report_run_outcome', () => {
  let previous: typeof process.exitCode;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  it('exits partial when items failed, never 1', () => {
    report_run_outcome({ errors: ['message:1 decrypt failed'], warnings: [] }, 'message');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('exits partial when the only failures are integrity failures', () => {
    report_run_outcome(
      { errors: [], warnings: [], integrity_failures: ['message:tampered-1'] },
      'message',
    );
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('exits partial when the run was interrupted with nothing else wrong', () => {
    report_run_outcome({ errors: [], warnings: [], interrupted: true }, 'message');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('leaves a clean run at 0, and does not reclassify warnings as partial', () => {
    report_run_outcome(
      {
        errors: [],
        warnings: ['pre-restore verification: 1 older manifest'],
        integrity_failures: [],
      },
      'message',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('reports the integrity bucket separately from the error bucket', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(' '));
    });

    report_run_outcome(
      {
        errors: ['message:1 decrypt failed'],
        warnings: [],
        integrity_failures: ['message:tampered-1'],
      },
      'message',
    );

    const joined = errors.join('\n');
    expect(joined).toContain('message error: message:1 decrypt failed');
    expect(joined).toContain('message integrity failure: message:tampered-1');
    expect(joined).toContain('1 message error(s), 1 integrity failure(s)');
  });
});
