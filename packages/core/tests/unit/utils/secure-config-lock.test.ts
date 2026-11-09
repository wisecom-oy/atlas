import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { with_store_lock } from '@/utils/secure-config-lock';

describe('with_store_lock', () => {
  let dir: string;
  let lock_path: string;
  let exited_pid: number;

  beforeAll(() => {
    exited_pid = spawnSync(process.execPath, ['-e', '']).pid;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-lock-'));
    lock_path = join(dir, 'config.lock');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Plants a lock an hour old, which is how a live lock looks after the wall clock steps. */
  const plant_old_lock = (holder: string): void => {
    writeFileSync(lock_path, holder);
    const an_hour_ago = new Date(Date.now() - 3_600_000);
    utimesSync(lock_path, an_hour_ago, an_hour_ago);
  };

  it('records this process as the holder while the critical section runs', () => {
    const holder = with_store_lock(dir, () => readFileSync(lock_path, 'utf-8'));

    expect(holder).toBe(`${process.pid}@${hostname()}`);
    expect(existsSync(lock_path)).toBe(false);
  });

  it('clears a lock whose holder process has exited', () => {
    plant_old_lock(`${exited_pid}@${hostname()}`);

    expect(with_store_lock(dir, () => 'ran')).toBe('ran');
    expect(existsSync(lock_path)).toBe(false);
  });

  it.each([
    ['a live process on this host', () => `${process.pid}@${hostname()}`],
    ['a process on another host', () => `${exited_pid}@another-host`],
    ['an unknown holder', () => ''],
  ])('keeps a lock held by %s however old it looks', (_label, holder) => {
    plant_old_lock(holder());
    // Expire the 10 second wait on the first check instead of sleeping through it.
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(Number.POSITIVE_INFINITY);

    expect(() => with_store_lock(dir, () => 'ran')).toThrow('locked by another Atlas command');
    expect(readFileSync(lock_path, 'utf-8')).toBe(holder());
  });
});
