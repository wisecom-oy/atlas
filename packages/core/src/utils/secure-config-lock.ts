import { closeSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = 'config.lock';
/** How long a command waits for another command's update before giving up. */
const LOCK_TIMEOUT_MS = 10_000;
/** An update holds the lock for milliseconds; a lock this old was left by a killed process. */
const STALE_LOCK_MS = 30_000;
const RETRY_MS = 25;

/**
 * Runs `critical` while holding an exclusive lock file in `dir`, released however it exits.
 *
 * ponytail: lock file with an mtime staleness check. Two waiters that both judge the same lock
 * stale can each remove it and enter together; that needs a process killed mid-update first. Move
 * to an OS advisory lock (flock) if the store ever gets a long-running writer.
 */
export function with_store_lock<T>(dir: string, critical: () => T): T {
  const lock_path = join(dir, LOCK_FILE);
  acquire_lock(lock_path);
  try {
    return critical();
  } finally {
    rmSync(lock_path, { force: true });
  }
}

/** Creates the lock file exclusively, waiting for a live holder and clearing a stale one. */
function acquire_lock(lock_path: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock_path, 'wx', 0o600));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (remove_if_stale(lock_path)) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `The secure config store is locked by another Atlas command (${lock_path}). ` +
          'If no other atlas config or atlas tenants command is running, delete that file.',
      );
    }
    sleep_sync(RETRY_MS);
  }
}

/** Deletes a lock older than {@link STALE_LOCK_MS}; true when the lock is gone either way. */
function remove_if_stale(lock_path: string): boolean {
  try {
    if (Date.now() - statSync(lock_path).mtimeMs < STALE_LOCK_MS) return false;
    rmSync(lock_path, { force: true });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Blocks the thread: the store API is synchronous, and the wait is a few milliseconds. */
function sleep_sync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
