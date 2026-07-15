#!/usr/bin/env node
/**
 * Links the compiled CLI onto the PATH as `atlas` after `npm install`,
 * so non-global installs still get a system-wide command.
 *
 * Skips (with a warning where the user should know) when:
 * - `atlas` is already a shell alias in a known rc file
 * - another `atlas` executable is already on PATH
 * - no writable bin directory exists
 * - running on Windows (npm creates .cmd shims for global installs)
 * - running inside the Atlas monorepo as a lifecycle hook (contributor installs)
 *
 * Never fails the install: every exit path is code 0.
 * Opt out with ATLAS_SKIP_POSTINSTALL=1. Manual run: `node scripts/postinstall.mjs`.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const WORKSPACE_MARKER = fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url));
const OUR_CLI_SUFFIX = join('@wisecom', 'atlas-cli', 'dist', 'cli.mjs');
const RC_FILES = [
  '.bashrc',
  '.bash_aliases',
  '.zshrc',
  '.profile',
  join('.config', 'fish', 'config.fish'),
];

/** Prefixed warning that stands out in npm's install noise. */
function warn(message) {
  console.warn(`[atlas postinstall] ${message}`);
}

/** Returns the rc file that defines an `atlas` alias, or null. */
function find_alias_definition() {
  for (const rc of RC_FILES) {
    const rc_path = join(homedir(), rc);
    try {
      // Covers `alias atlas=...` (POSIX shells) and `alias atlas ...` (fish).
      if (/^\s*alias\s+atlas\s*[= ]/m.test(readFileSync(rc_path, 'utf8'))) return rc_path;
    } catch {
      // Unreadable or absent rc file - nothing to detect.
    }
  }
  return null;
}

/** Returns the first executable named `atlas` on PATH, or null. */
function find_existing_command() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'atlas');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable in this PATH entry.
    }
  }
  return null;
}

/** True when the executable resolves to this (or any) Atlas CLI install. */
function is_atlas_cli(executable_path) {
  try {
    const real = realpathSync(executable_path);
    return real === realpathSync(CLI_PATH) || real.endsWith(OUR_CLI_SUFFIX);
  } catch {
    return false;
  }
}

/** Picks a writable bin directory, preferring ones already on PATH. */
function pick_bin_dir() {
  const path_dirs = new Set((process.env.PATH ?? '').split(delimiter));
  const local_bin = join(homedir(), '.local', 'bin');
  for (const dir of ['/usr/local/bin', local_bin]) {
    if (!path_dirs.has(dir)) continue;
    try {
      accessSync(dir, constants.W_OK);
      return { dir, on_path: true };
    } catch {
      // Not writable without elevation - try the next candidate.
    }
  }
  try {
    mkdirSync(local_bin, { recursive: true });
    accessSync(local_bin, constants.W_OK);
    return { dir: local_bin, on_path: path_dirs.has(local_bin) };
  } catch {
    return null;
  }
}

/** Installs the `atlas` symlink unless the name is taken or the environment opts out. */
function main() {
  if (process.env.ATLAS_SKIP_POSTINSTALL || process.env.CI) return;
  if (process.platform === 'win32') return; // npm creates atlas.cmd shims for global installs
  // Contributor `pnpm install` inside the monorepo must not touch the system.
  if (process.env.npm_lifecycle_event === 'postinstall' && existsSync(WORKSPACE_MARKER)) return;
  if (!existsSync(CLI_PATH)) return; // source checkout without a build - nothing to link

  const alias_rc = find_alias_definition();
  if (alias_rc) {
    warn(
      `skipped: \`atlas\` is already defined as an alias in ${alias_rc}. ` +
        `Remove the alias and re-run \`node ${fileURLToPath(import.meta.url)}\`, ` +
        `or invoke the CLI via \`npx atlas\`.`,
    );
    return;
  }

  const existing = find_existing_command();
  if (existing) {
    if (is_atlas_cli(existing)) return; // already installed - idempotent
    warn(
      `skipped: \`atlas\` already exists at ${existing} and is not the Atlas CLI. ` +
        `Invoke this install via \`npx atlas\` instead.`,
    );
    return;
  }

  const target = pick_bin_dir();
  if (!target) {
    warn('skipped: no writable bin directory (/usr/local/bin or ~/.local/bin) found.');
    return;
  }

  chmodSync(CLI_PATH, 0o755);
  const link = join(target.dir, 'atlas');
  rmSync(link, { force: true }); // clear a stale/broken symlink missed by the X_OK scan
  symlinkSync(CLI_PATH, link);
  console.log(`[atlas postinstall] linked ${link} -> ${CLI_PATH}`);
  if (!target.on_path) {
    warn(`${target.dir} is not on your PATH. Add it, e.g.: export PATH="${target.dir}:$PATH"`);
  }
}

try {
  main();
} catch (error) {
  warn(`skipped: ${error?.message ?? error}`);
}
