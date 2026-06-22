import { describe, it, expect, afterEach } from 'vitest';
import { SlidingWindowLimiter } from '@/services/shared/sliding-window-limiter';

describe('SlidingWindowLimiter', () => {
  let limiter: SlidingWindowLimiter;

  afterEach(() => {
    limiter?.shutdown();
  });

  it('allows immediate acquisition when tokens are available', async () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 100);
    await limiter.acquire(1);
    expect(limiter.available).toBe(99);
  });

  it('allows acquiring multiple tokens at once', async () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 100);
    await limiter.acquire(10);
    expect(limiter.available).toBe(90);
  });

  it('blocks when no tokens are available and resolves after slide reclaims', async () => {
    limiter = new SlidingWindowLimiter(2_000, 100, 2);
    await limiter.acquire(2);
    expect(limiter.available).toBe(0);

    const start = Date.now();
    await limiter.acquire(1);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('reset restores all tokens', async () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 50);
    await limiter.acquire(50);
    expect(limiter.available).toBe(0);

    limiter.reset();
    expect(limiter.available).toBe(50);
  });

  it('shutdown releases pending acquires', async () => {
    limiter = new SlidingWindowLimiter(60_000, 1_000, 1);
    await limiter.acquire(1);

    const promise = limiter.acquire(1);
    limiter.shutdown();
    await promise;
  });

  it('throws on invalid configuration', () => {
    expect(() => new SlidingWindowLimiter(0, 1_000, 100)).toThrow();
    expect(() => new SlidingWindowLimiter(10_000, 0, 100)).toThrow();
    expect(() => new SlidingWindowLimiter(10_000, 1_000, -1)).toThrow();
    expect(() => new SlidingWindowLimiter(1_000, 3_000, 10)).toThrow();
  });

  it('throws after shutdown', async () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 10);
    limiter.shutdown();
    await expect(limiter.acquire(1)).rejects.toThrow('shut down');
  });

  it('acquire(0) is a no-op', async () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 10);
    await limiter.acquire(0);
    expect(limiter.available).toBe(10);
  });

  it('reports capacity correctly', () => {
    limiter = new SlidingWindowLimiter(10_000, 1_000, 42);
    expect(limiter.capacity).toBe(42);
  });
});
