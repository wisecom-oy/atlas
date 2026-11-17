/**
 * Run directories: `<repo>/.outagesoft-365/<UTC timestamp>/` holding run.json,
 * journal.jsonl and the reports, next to the shared identity key.
 *
 * The tool home sits at the nearest ancestor of the working directory that
 * contains `.git`, so runs started from `packages/cli` and from the repository
 * root share one key (and so comparable identity keys) and one run list.
 * Outside a repository it falls back to the working directory.
 *
 * Files are created 0600 and the directory 0700: the journal holds no
 * secrets, but its templated URLs and timings still describe a tenant's
 * workload, and a shared machine has no reason to read them.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const TOOL_DIR_NAME = '.outagesoft-365';

/** The nearest ancestor of `start` (itself included) that contains `.git`, or `start` itself. */
export function find_project_root(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** The tool's home: run directories and the identity key. */
export function tool_home(start = process.cwd()) {
  return join(find_project_root(start), TOOL_DIR_NAME);
}

/** UTC timestamp usable as a directory name on every platform. */
function timestamp_name(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}

/** Throws (a usage error) when --out already holds a run, before anything is started. */
export function check_out_dir(out) {
  if (out && existsSync(join(resolve(out), 'journal.jsonl'))) {
    throw new Error(`--out '${out}' already holds a run; choose an empty directory`);
  }
}

/** Creates the run directory: --out if given, else a fresh timestamped one under the tool home. */
export function create_run_dir(out) {
  if (out) {
    check_out_dir(out);
    const dir = resolve(out);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  const home = tool_home();
  const base = join(home, timestamp_name());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Two runs started in the same second get -2, -3, ...; mkdir without `recursive` fails if taken.
  for (let n = 1; ; n += 1) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** Writes run.json atomically (temp file and rename), so a reader never sees half a file. */
export function write_run_json(run_dir, run) {
  const target = join(run_dir, 'run.json');
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** The most recently modified run directory under the tool home, or null when there is none. */
export function newest_run_dir() {
  const home = tool_home();
  if (!existsSync(home)) return null;
  const runs = readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(home, entry.name, 'run.json')))
    .map((entry) => {
      const dir = join(home, entry.name);
      return { dir, mtime: statSync(join(dir, 'run.json')).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? 1 : -1));
  return runs[0]?.dir ?? null;
}
