import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_SOURCE = fileURLToPath(new URL('../../scripts/postinstall.mjs', import.meta.url));

/**
 * Spawns the real postinstall script inside a sandbox home/install layout and
 * asserts how the `atlas` symlink is (or is not) taken over, per issue #423
 * and its bun follow-up: an older Atlas install holding the command is
 * repointed on a global install and left alone on a local one.
 */
describe('postinstall takeover', () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    while (sandboxes.length) rmSync(sandboxes.pop()!, { recursive: true, force: true });
  });

  /** Installs the script in a sandbox with an older Atlas install first on PATH. */
  function with_sandbox(global: boolean): {
    install: string;
    link: string;
    run: () => { stdout: string; stderr: string; status: number | null };
  } {
    const sandbox = mkdtempSync(join(tmpdir(), 'atlas-postinstall-'));
    sandboxes.push(sandbox);
    const tree = (which: 'bun' | 'project'): string => {
      const install =
        which === 'bun'
          ? join(sandbox, 'bun', 'install', 'global', 'node_modules', '@wisecom', 'atlas-cli')
          : join(sandbox, 'project', 'node_modules', '@wisecom', 'atlas-cli');
      mkdirSync(join(install, 'scripts'), { recursive: true });
      mkdirSync(join(install, 'dist'), { recursive: true });
      cpSync(SCRIPT_SOURCE, join(install, 'scripts', 'postinstall.mjs'));
      const cli = join(install, 'dist', 'cli.mjs');
      writeFileSync(cli, '#!/usr/bin/env node\nprocess.stdout.write("atlas test-fake");\n');
      chmodSync(cli, 0o755);
      return install;
    };
    const install = tree(global ? 'bun' : 'project');
    // The pre-existing `atlas` command belongs to the other (older) install.
    const older_cli = tree(global ? 'project' : 'bun');
    mkdirSync(join(sandbox, 'home', '.local', 'bin'), { recursive: true });
    const link = join(sandbox, 'home', '.local', 'bin', 'atlas');
    symlinkSync(join(older_cli, 'dist', 'cli.mjs'), link);

    return {
      install,
      link,
      run: () => {
        const result = spawnSync(process.execPath, [join(install, 'scripts', 'postinstall.mjs')], {
          encoding: 'utf8',
          env: {
            PATH: `${join(sandbox, 'home', '.local', 'bin')}${delimiter}/usr/bin:/bin`,
            HOME: join(sandbox, 'home'),
            ...(global ? { BUN_INSTALL: join(sandbox, 'bun') } : {}),
          },
        });
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
      },
    };
  }

  it('takes the command over from an older install on a global install', () => {
    const { install, link, run } = with_sandbox(true);
    const { status, stdout, stderr } = run();
    expect(stderr + stdout, `exit ${status}`).toContain('re-linked');
    expect(realpathSync(link)).toBe(realpathSync(join(install, 'dist', 'cli.mjs')));
  });

  it('leaves the command alone on a local install', () => {
    const { link, run } = with_sandbox(false);
    const before = realpathSync(link);
    const { status, stdout, stderr } = run();
    expect(stderr + stdout, `exit ${status}`).toContain('skipped');
    expect(realpathSync(link)).toBe(before);
  });

  it('replaces a broken stale link on a global install', () => {
    const { install, link, run } = with_sandbox(true);
    rmSync(link); // replace the healthy legacy link with a dangling one
    symlinkSync(join(sandboxes[0]!, 'no-such-old-install', 'cli.mjs'), link);
    const { status, stdout, stderr } = run();
    expect(stderr + stdout, `exit ${status}`).toContain('linked');
    expect(realpathSync(link)).toBe(realpathSync(join(install, 'dist', 'cli.mjs')));
  });
});
