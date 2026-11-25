/**
 * Issue #859, observed on a real event loop. Each case runs the limiter source in a child Node
 * process shaped like the CLI entry: the command promise is not awaited at the top level, so Node
 * exits as soon as no libuv handle is left, and the exit code is whatever the command set.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIMITER_URL = pathToFileURL(
  fileURLToPath(
    new URL('../../../../src/services/shared/sliding-window-limiter.ts', import.meta.url),
  ),
).href;

/** Far longer than any case should take; a process still running then is held open. */
const CHILD_TIMEOUT_MS = 15_000;

interface ChildExit {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

/** Runs `command_body` as the body of an async command in a CLI-shaped child process. */
function run_command(command_body: string): ChildExit {
  const script = `
    const { SlidingWindowLimiter } = await import(${JSON.stringify(LIMITER_URL)});
    async function command() { ${command_body} }
    command().then(
      () => console.log('command finished'),
      () => { process.exitCode = 3; },
    );
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
  );
  return { status: child.status, signal: child.signal, stdout: child.stdout };
}

describe('SlidingWindowLimiter process lifetime', () => {
  it('keeps a command parked on the window alive until tokens arrive, then lets it finish', () => {
    const exit = run_command(`
      const limiter = new SlidingWindowLimiter(400, 100, 1);
      await limiter.acquire(1);
      await limiter.acquire(1);
    `);

    expect(exit.stdout).toContain('command finished');
    expect(exit.status).toBe(0);
  });

  it('exits promptly once a run is done, with its limiter idle and never shut down', () => {
    const started = Date.now();
    const exit = run_command(`
      const limiter = new SlidingWindowLimiter(600_000, 1_000, 5);
      await limiter.acquire(1);
    `);

    expect(exit.signal).toBeNull();
    expect(exit.status).toBe(0);
    expect(exit.stdout).toContain('command finished');
    expect(Date.now() - started).toBeLessThan(CHILD_TIMEOUT_MS);
  });

  it('exits with the failed command code once the hold is released, with a caller still parked', () => {
    const exit = run_command(`
      const limiter = new SlidingWindowLimiter(600_000, 1_000, 1);
      await limiter.acquire(1);
      void limiter.acquire(1);
      process.exitCode = 2;
      limiter.release_process_hold();
      await new Promise(() => {});
    `);

    expect(exit.signal).toBeNull();
    expect(exit.status).toBe(2);
    expect(exit.stdout).not.toContain('command finished');
  });
});
