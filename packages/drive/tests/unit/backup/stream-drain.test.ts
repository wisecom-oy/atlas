import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stream_to_buffer, with_timeout } from '@/backup/stream-drain';

const DRAIN_TIMEOUT_MS = 60_000;

describe('stream_to_buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains every chunk and leaves no timer armed', async () => {
    const stream = Readable.from([Buffer.from('ab'), 'cd', Buffer.from('ef')]);

    await expect(stream_to_buffer(stream, DRAIN_TIMEOUT_MS)).resolves.toEqual(
      Buffer.from('abcdef'),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  // Issue #676: the SharePoint copy cleared its timer only on a clean end, so an errored drain kept
  // the event loop and the buffered chunks alive for the whole drain budget.
  it('releases its timer at once when the stream errors', async () => {
    const stream = new PassThrough();
    const drained = stream_to_buffer(stream, DRAIN_TIMEOUT_MS);
    stream.write(Buffer.from('partial'));
    stream.destroy(new Error('socket hang up'));

    await expect(drained).rejects.toThrow('socket hang up');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not destroy an already failed stream when the drain budget would have run out', async () => {
    const stream = new PassThrough();
    const destroy = vi.spyOn(stream, 'destroy');
    const drained = stream_to_buffer(stream, DRAIN_TIMEOUT_MS);
    stream.destroy(new Error('reset'));
    await expect(drained).rejects.toThrow('reset');
    destroy.mockClear();

    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys a stalled stream and rejects once the timeout passes', async () => {
    const stream = new PassThrough();
    const drained = stream_to_buffer(stream, DRAIN_TIMEOUT_MS);
    const outcome = drained.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);

    expect(await outcome).toEqual(new Error('Graph content stream timed out'));
    expect(stream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('with_timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles with the promise and clears the timer', async () => {
    await expect(with_timeout(Promise.resolve('done'), 1_000, 'late')).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a rejection through and clears the timer', async () => {
    await expect(with_timeout(Promise.reject(new Error('boom')), 1_000, 'late')).rejects.toThrow(
      'boom',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the message when the promise does not settle in time', async () => {
    const outcome = with_timeout(new Promise<never>(() => undefined), 1_000, 'late').catch(
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toEqual(new Error('late'));
    expect(vi.getTimerCount()).toBe(0);
  });
});
