import { describe, it, expect } from 'vitest';
import { ConcurrencySemaphore } from '@/services/shared/concurrency-semaphore';

describe('ConcurrencySemaphore', () => {
  it('allows immediate acquisition when slots are free', async () => {
    const sem = new ConcurrencySemaphore(4);
    await sem.acquire();
    expect(sem.available).toBe(3);
  });

  it('blocks when all slots are taken', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();
    expect(sem.available).toBe(0);

    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    sem.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it('processes waiters in FIFO order', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('release does not exceed capacity', () => {
    const sem = new ConcurrencySemaphore(2);
    sem.release();
    sem.release();
    sem.release();
    expect(sem.available).toBe(2);
  });

  it('reports waiting count', async () => {
    const sem = new ConcurrencySemaphore(1);
    await sem.acquire();
    const _p1 = sem.acquire();
    const _p2 = sem.acquire();
    expect(sem.waiting).toBe(2);
    sem.release();
    sem.release();
    await Promise.all([_p1, _p2]);
  });

  it('throws on invalid capacity', () => {
    expect(() => new ConcurrencySemaphore(0)).toThrow();
    expect(() => new ConcurrencySemaphore(-1)).toThrow();
  });

  it('reports capacity', () => {
    const sem = new ConcurrencySemaphore(8);
    expect(sem.capacity).toBe(8);
  });
});
