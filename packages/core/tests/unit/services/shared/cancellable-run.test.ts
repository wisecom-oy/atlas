/**
 * Issue #682. `run_cancellable` turned any rejection into the interrupted result once the signal
 * had fired. A failure that only happened to land after Ctrl+C, such as a key that does not fit the
 * snapshot, was then reported as an interrupted run that restored nothing.
 */
import { describe, expect, it } from 'vitest';
import { is_cancellation_of, run_cancellable } from '@/services/shared/cancellable-run';

const INTERRUPTED = 'interrupted';

function aborted_signal(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe('run_cancellable', () => {
  it('resolves the interrupted result when the run rejects with the abort reason', async () => {
    const reason = new Error('Run interrupted by Ctrl+C');
    const signal = aborted_signal(reason);

    const result = await run_cancellable(
      { abort_signal: signal },
      () => Promise.reject(reason),
      () => INTERRUPTED,
    );

    expect(result).toBe(INTERRUPTED);
  });

  it('resolves the interrupted result when the abort reason is the cause of the rejection', async () => {
    const reason = new Error('Run interrupted by Ctrl+C');
    const signal = aborted_signal(reason);

    const result = await run_cancellable(
      { abort_signal: signal },
      () => Promise.reject(new Error('listing failed', { cause: reason })),
      () => INTERRUPTED,
    );

    expect(result).toBe(INTERRUPTED);
  });

  it('rethrows an unrelated error even when the signal has already fired', async () => {
    const signal = aborted_signal(new Error('Run interrupted by Ctrl+C'));
    const key_error = new Error('AES-GCM authentication failed');

    await expect(
      run_cancellable(
        { abort_signal: signal },
        () => Promise.reject(key_error),
        () => INTERRUPTED,
      ),
    ).rejects.toBe(key_error);
  });

  it('rethrows every error when no signal fired', async () => {
    const failure = new Error('HTTP 500');

    await expect(
      run_cancellable(
        { abort_signal: new AbortController().signal },
        () => Promise.reject(failure),
        () => INTERRUPTED,
      ),
    ).rejects.toBe(failure);
  });
});

describe('is_cancellation_of', () => {
  it('recognises a non-Error abort reason carried as the cause', () => {
    const signal = aborted_signal('shutdown');

    expect(
      is_cancellation_of(new Error('The run was cancelled', { cause: 'shutdown' }), signal),
    ).toBe(true);
    expect(is_cancellation_of(new Error('The run was cancelled'), signal)).toBe(false);
  });
});
