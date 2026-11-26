/**
 * Issue #874. An Outlook call parked on its mailbox's concurrency slot must stop waiting as soon as
 * the run is cancelled, and must not leave a slot behind that nobody will release.
 */

import { describe, expect, it } from 'vitest';
import { ConcurrencySemaphore } from '@/services/shared/concurrency-semaphore';

const INTERRUPTED = new Error('Run interrupted by Ctrl+C');

describe('ConcurrencySemaphore cancellation', () => {
  it('rejects a parked caller with the abort reason and drops it from the queue', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const parked = sem.acquire(controller.signal);

    controller.abort(INTERRUPTED);

    await expect(parked).rejects.toBe(INTERRUPTED);
    expect(sem.waiting).toBe(0);
  });

  it('keeps the slot for the next caller after a cancelled one', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const cancelled = sem.acquire(controller.signal);
    let next_done = false;
    const next = sem.acquire().then(() => (next_done = true));

    controller.abort(INTERRUPTED);
    await expect(cancelled).rejects.toBe(INTERRUPTED);
    sem.release();
    await next;

    expect(next_done).toBe(true);
    sem.release();
    expect(sem.available).toBe(1);
  });

  it('takes no slot when the signal fired before the call', async () => {
    const sem = new ConcurrencySemaphore(1);
    const controller = new AbortController();
    controller.abort(INTERRUPTED);

    await expect(sem.acquire(controller.signal)).rejects.toBe(INTERRUPTED);
    expect(sem.available).toBe(1);
  });

  it('wraps a reason that is not an Error, keeping it as the cause', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const parked = sem.acquire(controller.signal);

    controller.abort('stop');

    await expect(parked).rejects.toMatchObject({ cause: 'stop' });
  });

  it('ignores an abort after the slot was granted', async () => {
    const sem = new ConcurrencySemaphore(1);
    const controller = new AbortController();
    await sem.acquire(controller.signal);

    controller.abort(INTERRUPTED);
    sem.release();

    expect(sem.available).toBe(1);
  });
});
