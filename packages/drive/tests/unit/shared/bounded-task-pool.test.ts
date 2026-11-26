import { describe, expect, it } from 'vitest';
import { BoundedTaskPool } from '@/shared/bounded-task-pool';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('BoundedTaskPool', () => {
  it('never runs more than its limit at once', async () => {
    const pool = new BoundedTaskPool(3);
    let running = 0;
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      await pool.add(async () => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
      });
    }
    await pool.drain();

    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('raises the first failure once the tasks in flight settle, and starts nothing after it', async () => {
    const pool = new BoundedTaskPool(2);
    const started: string[] = [];
    let release_slow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release_slow = resolve;
    });
    await pool.add(async () => {
      started.push('slow');
      await slow;
    });
    await pool.add(async () => {
      started.push('failing');
      throw new Error('upload refused');
    });

    const blocked = pool.add(async () => {
      started.push('after');
    });
    release_slow();

    await expect(blocked).rejects.toThrow('upload refused');
    await expect(pool.drain()).rejects.toThrow('upload refused');
    expect(started).toEqual(['slow', 'failing']);
  });
});
