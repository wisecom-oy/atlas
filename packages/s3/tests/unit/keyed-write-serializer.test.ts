/** Issue #974: checked writes to one key run one at a time in arrival order; other keys do not wait. */
import { describe, expect, it } from 'vitest';
import { KeyedWriteSerializer } from '@/adapters/keyed-write-serializer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KeyedWriteSerializer', () => {
  it('runs tasks under one key in arrival order, never two at once', async () => {
    const serializer = new KeyedWriteSerializer();
    const events: string[] = [];
    const gate = deferred();

    const first = serializer.run('k', async () => {
      events.push('first start');
      await gate.promise;
      events.push('first end');
    });
    const second = serializer.run('k', async () => {
      events.push('second');
    });
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first start', 'first end', 'second']);
  });

  it('does not hold a task behind another key', async () => {
    const serializer = new KeyedWriteSerializer();
    const gate = deferred();
    const blocked = serializer.run('a', () => gate.promise);

    await expect(serializer.run('b', async () => 'done')).resolves.toBe('done');
    gate.resolve();
    await blocked;
  });

  it('lets the next task run after one fails, and returns each result', async () => {
    const serializer = new KeyedWriteSerializer();

    const failed = serializer.run('k', async () => Promise.reject(new Error('refused')));
    const next = serializer.run('k', async () => 42);

    await expect(failed).rejects.toThrow('refused');
    await expect(next).resolves.toBe(42);
  });
});
