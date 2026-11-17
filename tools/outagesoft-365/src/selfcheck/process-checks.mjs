/**
 * End-to-end checks of process handling: signal exit codes, a command that
 * cannot even be spawned, and the project-root tool home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { read_run, run_cli } from './run-harness.mjs';

/** Registers the process-handling checks. */
export async function run_process_checks({ work, check }) {
  await check('a child killed by a signal exits 128 plus the signal number', async () => {
    const run_dir = join(work, 'run-signal');
    const result = await run_cli(
      [
        'run',
        '--profile',
        'passthrough',
        '--quiet',
        '--out',
        run_dir,
        '--',
        process.execPath,
        '-e',
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { cwd: work },
    );
    assert.equal(result.code, 143, result.stderr);
    assert.equal(read_run(run_dir).run.child.signal, 'SIGTERM');
  });
  await check('a command that throws on spawn is still finalised and reported', async () => {
    const run_dir = join(work, 'run-spawn-throw');
    // An empty command makes spawn() throw synchronously rather than emit 'error'.
    const result = await run_cli(
      ['run', '--profile', 'passthrough', '--quiet', '--out', run_dir, '--', ''],
      { cwd: work },
    );
    assert.equal(result.code, 127, result.stderr);
    const { run } = read_run(run_dir);
    assert.ok(run.finished_at && run.child?.error, JSON.stringify(run.child));
    assert.ok(existsSync(join(run_dir, 'report.md')), 'no report for the failed spawn');
  });
  await check('runs from a subdirectory share the repository root tool home', async () => {
    const root = join(work, 'repo');
    const sub = join(root, 'packages', 'cli');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    const result = await run_cli(
      ['run', '--profile', 'passthrough', '--quiet', '--', process.execPath, '-e', '0'],
      { cwd: sub },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(root, '.outagesoft-365', 'identity.key')));
    assert.equal(
      readdirSync(join(root, '.outagesoft-365')).filter((n) => n !== 'identity.key').length,
      1,
    );
    assert.ok(!existsSync(join(sub, '.outagesoft-365')));
  });
}
