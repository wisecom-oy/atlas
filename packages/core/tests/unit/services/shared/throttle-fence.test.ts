import { describe, it, expect, afterEach } from 'vitest';
import { ThrottleFence } from '@/services/shared/throttle-fence';

describe('ThrottleFence', () => {
  let fence: ThrottleFence;

  afterEach(() => {
    fence?.clear();
  });

  it('wait() resolves immediately when no fence is active', async () => {
    fence = new ThrottleFence();
    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('wait() blocks until the fence duration expires', async () => {
    fence = new ThrottleFence();
    fence.raise(0.1);
    expect(fence.is_raised).toBe(true);

    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  it('multiple raise() calls use the longest remaining duration', async () => {
    fence = new ThrottleFence();
    fence.raise(0.2);
    fence.raise(0.05);

    const start = Date.now();
    await fence.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('clear() drops the fence immediately', async () => {
    fence = new ThrottleFence();
    fence.raise(10);

    let resolved = false;
    const waiter = fence.wait().then(() => {
      resolved = true;
    });

    fence.clear();
    await waiter;
    expect(resolved).toBe(true);
    expect(fence.is_raised).toBe(false);
  });

  it('raise(0) is a no-op', () => {
    fence = new ThrottleFence();
    fence.raise(0);
    expect(fence.is_raised).toBe(false);
  });

  it('raise(-1) is a no-op', () => {
    fence = new ThrottleFence();
    fence.raise(-1);
    expect(fence.is_raised).toBe(false);
  });

  it('all blocked callers are released simultaneously', async () => {
    fence = new ThrottleFence();
    fence.raise(0.1);

    const results: number[] = [];
    const p1 = fence.wait().then(() => results.push(Date.now()));
    const p2 = fence.wait().then(() => results.push(Date.now()));
    const p3 = fence.wait().then(() => results.push(Date.now()));

    await Promise.all([p1, p2, p3]);
    expect(results.length).toBe(3);
    const spread = Math.max(...results) - Math.min(...results);
    expect(spread).toBeLessThan(50);
  });
});
