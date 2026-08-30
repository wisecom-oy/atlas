import { describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { STORAGE_DISPOSER_TOKEN } from '@wisecom/atlas-types';
import type { StorageDisposer } from '@wisecom/atlas-types';
import { create_disposer } from '@/instance-disposal';

const SOME_TOKEN = Symbol.for('SomethingElse');

function make_container(disposer?: StorageDisposer): Container {
  const container = new Container();
  container.bind(SOME_TOKEN).toConstantValue({ kept: true });
  if (disposer) container.bind<StorageDisposer>(STORAGE_DISPOSER_TOKEN).toConstantValue(disposer);
  return container;
}

describe('create_disposer', () => {
  it('releases storage and then unbinds the container', async () => {
    const order: string[] = [];
    const container = make_container(async () => {
      order.push('storage');
    });

    await create_disposer(container)();

    order.push(container.isBound(SOME_TOKEN) ? 'still-bound' : 'unbound');
    // Storage first: it owns the sockets, and unbinding first would make it
    // unreachable.
    expect(order).toEqual(['storage', 'unbound']);
  });

  it('is idempotent, so a finally block and an await using scope can both fire', async () => {
    const storage = vi.fn(async () => undefined);
    const dispose = create_disposer(make_container(storage));

    await dispose();
    await dispose();
    await dispose();

    expect(storage).toHaveBeenCalledTimes(1);
  });

  it('unbinds even when storage teardown throws', async () => {
    const container = make_container(async () => {
      throw new Error('socket close failed');
    });

    await expect(create_disposer(container)()).resolves.toBeUndefined();

    // Otherwise one failing step leaks everything behind it, which is the state
    // this issue is about.
    expect(container.isBound(SOME_TOKEN)).toBe(false);
  });

  it('works on a container with no storage bound', async () => {
    const container = make_container();

    await expect(create_disposer(container)()).resolves.toBeUndefined();
    expect(container.isBound(SOME_TOKEN)).toBe(false);
  });

  it('disposes a thousand containers without retaining their bindings', async () => {
    const disposed: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const container = make_container(async () => {
        disposed.push(i);
      });
      await create_disposer(container)();
      expect(container.isBound(SOME_TOKEN)).toBe(false);
    }

    // The acceptance criterion of issue #42, at the level a unit test can reach:
    // every instance released its storage and dropped its bindings. Socket
    // counts are asserted in the smoke test against a real S3 client.
    expect(disposed).toHaveLength(1000);
  });
});
