import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { add_file_to_archive, create_file_archive } from '@/services/shared/file-save-zip-writer';

/**
 * Issue #343: `add_file_to_archive` resolved as soon as `append()` had queued the entry, so a
 * destination that consumed one entry did not stop a producer from enqueuing a hundred. Every one
 * of them sat in memory waiting for a consumer that was never going to catch up.
 */

const ENTRY_COUNT = 8;
const ENTRY_BYTES = 64 * 1024;

/** A destination that accepts nothing until it is released, and everything afterwards. */
function stalled_destination(): { stream: Writable; release: () => void } {
  const held: Array<() => void> = [];
  let accepting = false;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      if (accepting) {
        callback();
        return;
      }
      held.push(() => callback());
    },
  });
  return {
    stream,
    release: () => {
      accepting = true;
      while (held.length > 0) held.shift()!();
    },
  };
}

/**
 * Lets the archiver make whatever progress it can. The destination holds every write, so no number
 * of turns unblocks it: this waits for a settled state rather than for a duration.
 */
async function flush_event_loop(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

describe('archive backpressure (issue #343)', () => {
  it('stops accepting entries while the destination is not draining', async () => {
    const destination = stalled_destination();
    const file_archive = create_file_archive(destination.stream);
    const accepted: number[] = [];

    const appends = Array.from({ length: ENTRY_COUNT }, (_, index) =>
      add_file_to_archive(file_archive, '/', `file-${index}.bin`, Buffer.alloc(ENTRY_BYTES, index))
        .then(() => accepted.push(index))
        .catch(() => undefined),
    );

    await flush_event_loop();

    // The producer is bounded by the entry being written, not by how many it could decrypt.
    expect(accepted.length).toBeLessThan(ENTRY_COUNT);

    destination.release();
    await Promise.allSettled(appends);
    await file_archive.abort();
  });

  it('writes every entry once the destination drains', async () => {
    const draining = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback();
      },
    });
    const file_archive = create_file_archive(draining);
    const written: string[] = [];
    file_archive.archive.on('entry', (entry: { name: string }) => written.push(entry.name));

    for (let index = 0; index < 3; index++) {
      await add_file_to_archive(
        file_archive,
        'reports',
        `file-${index}.bin`,
        Buffer.alloc(1024, index),
      );
    }
    await file_archive.archive.finalize();

    expect(written).toEqual(['reports/file-0.bin', 'reports/file-1.bin', 'reports/file-2.bin']);
    expect(await file_archive.promise).toBeGreaterThan(0);
  });

  it('fails the next entry when the destination has died, rather than waiting on it', async () => {
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('no space left on device'));
      },
    });
    const file_archive = create_file_archive(failing);

    // The destination's error lands on the byte-count promise, and a piped archive that lost its
    // destination stops emitting `entry`, so without raising it here the producer waits forever.
    await expect(
      (async () => {
        for (let index = 0; index < ENTRY_COUNT; index++) {
          await add_file_to_archive(
            file_archive,
            'reports',
            `file-${index}.bin`,
            Buffer.alloc(ENTRY_BYTES, index),
          );
        }
      })(),
    ).rejects.toThrow(/no space left on device/);
  });
});
