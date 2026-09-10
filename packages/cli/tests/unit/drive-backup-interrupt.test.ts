import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install_interrupt_gate } from '@/adapters/interrupt-gate';
import { report_run_outcome, EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * Issue #367. Only the Outlook backup wired SIGINT into its run, so Ctrl+C during a drive backup
 * killed the process where the signal landed, with exit 130 and no interrupted state recorded.
 * The drive handlers also never passed `interrupted` to the reporter, so even with a flag an
 * interrupted run with no item errors would have exited 0.
 */
describe('the drive backup interrupt gate', () => {
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

  it('reports not-interrupted until the signal arrives', () => {
    const gate = install_interrupt_gate('stopping');
    try {
      expect(gate.should_interrupt()).toBe(false);
      process.emit('SIGINT');
      expect(gate.should_interrupt()).toBe(true);
    } finally {
      gate.dispose();
    }
  });

  it('stops listening once disposed, so a later signal is not this run', () => {
    const gate = install_interrupt_gate('stopping');
    gate.dispose();

    process.emit('SIGINT');

    expect(gate.should_interrupt()).toBe(false);
  });

  it('exits partial for an interrupted run that had no item errors', () => {
    report_run_outcome({ errors: [], warnings: [], interrupted: true }, 'file');

    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });
});
