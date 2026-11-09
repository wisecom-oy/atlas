import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const LOCK_FILE = 'config.lock';
/** How long a command waits for another command's update before giving up. */
const LOCK_TIMEOUT_MS = 10_000;
const RETRY_MS = 25;

/**
 * Runs `critical` while holding an exclusive lock file in `dir`, released however it exits.
 *
 * The lock records its holder as `<pid>@<host>` and is cleared only when that process has exited
 * on this host. Nothing reads the wall clock: VM and WSL2 host time sync can step it by minutes,
 * which made an mtime staleness check break live locks (issue #597).
 *
 * ponytail: two waiters that both find the same dead holder can each remove the lock and enter
 * together; that needs a process killed mid-update first. Move to an OS advisory lock (flock) if
 * the store ever gets a long-running writer.
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

/** Creates the lock file exclusively, waiting for a live holder and clearing a dead one. */
function acquire_lock(lock_path: string): void {
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (try_create_lock(lock_path)) return;
    if (remove_if_holder_exited(lock_path)) continue;
    if (performance.now() >= deadline) {
      throw new Error(
        `The secure config store is locked by another Atlas command (${lock_path}). ` +
          'If no other atlas config or atlas tenants command is running, delete that file.',
      );
    }
    sleep_sync(RETRY_MS);
  }
}

/** Creates the lock file and records this process as its holder; false when it already exists. */
function try_create_lock(lock_path: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock_path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
  try {
    writeSync(fd, `${process.pid}@${hostname()}`);
  } catch (err) {
    rmSync(lock_path, { force: true });
    throw err;
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Deletes the lock when its holder has exited; true when the lock is gone either way. */
function remove_if_holder_exited(lock_path: string): boolean {
  let holder: string;
  try {
    holder = readFileSync(lock_path, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (!holder_has_exited(holder)) return false;
  rmSync(lock_path, { force: true });
  return true;
}

/**
 * True only for a `<pid>@<this host>` holder whose process is gone. An empty holder (still being
 * written) and a holder on another host are treated as live.
 */
function holder_has_exited(holder: string): boolean {
  const match = /^(\d+)@(.+)$/.exec(holder);
  if (match === null || match[2] !== hostname()) return false;
  try {
    process.kill(Number(match[1]), 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Blocks the thread: the store API is synchronous, and the wait is a few milliseconds. */
function sleep_sync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
