import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ProfileOptions {
  atlas_args: string[];
  output_dir: string;
  use_0x: boolean;
}

export interface ProfileResult {
  cpuprofile_path: string;
  flamegraph_path?: string | undefined;
  exit_code: number;
}

/**
 * Spawns the atlas CLI with V8 CPU profiling enabled.
 * Returns the path to the generated .cpuprofile file.
 */
export async function run_profiled(options: ProfileOptions): Promise<ProfileResult> {
  const { atlas_args, output_dir, use_0x } = options;

  const cli_entry = resolve(process.cwd(), 'packages/cli/dist/cli.js');

  if (use_0x) {
    return run_with_0x(cli_entry, atlas_args, output_dir);
  }

  return run_with_cpu_prof(cli_entry, atlas_args, output_dir);
}

async function run_with_cpu_prof(
  cli_entry: string,
  atlas_args: string[],
  output_dir: string,
): Promise<ProfileResult> {
  const node_args = [
    '--cpu-prof',
    `--cpu-prof-dir=${output_dir}`,
    '--cpu-prof-interval=500',
    cli_entry,
    ...atlas_args,
  ];

  console.log(`[atlas-perf] Profiling: node ${node_args.join(' ')}`);
  console.log(`[atlas-perf] Output dir: ${output_dir}`);

  const exit_code = await spawn_and_wait('node', node_args);

  const cpuprofile_path = await find_cpuprofile(output_dir);
  return { cpuprofile_path, exit_code };
}

async function run_with_0x(
  cli_entry: string,
  atlas_args: string[],
  output_dir: string,
): Promise<ProfileResult> {
  const zero_x_args = [
    '--collect-only',
    `-D`,
    output_dir,
    '--',
    'node',
    '--cpu-prof',
    `--cpu-prof-dir=${output_dir}`,
    cli_entry,
    ...atlas_args,
  ];

  console.log(`[atlas-perf] Profiling with 0x: npx 0x ${zero_x_args.join(' ')}`);

  const exit_code = await spawn_and_wait('npx', ['0x', ...zero_x_args]);

  const cpuprofile_path = await find_cpuprofile(output_dir);
  const flamegraph_path = await find_flamegraph(output_dir);

  return { cpuprofile_path, flamegraph_path, exit_code };
}

function spawn_and_wait(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function find_cpuprofile(dir: string): Promise<string> {
  const files = await readdir(dir);
  const profile = files.find((f) => f.endsWith('.cpuprofile'));
  if (!profile) {
    throw new Error(`No .cpuprofile found in ${dir}. Did the process exit cleanly?`);
  }
  return resolve(dir, profile);
}

async function find_flamegraph(dir: string): Promise<string | undefined> {
  try {
    const files = await readdir(dir);
    const html = files.find((f) => f.endsWith('.html'));
    return html ? resolve(dir, html) : undefined;
  } catch {
    return undefined;
  }
}
