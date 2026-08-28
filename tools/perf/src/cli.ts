#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { program } from 'commander';

import { parse_profile } from './profile-parser.js';
import { run_profiled } from './profiler.js';
import { format_report } from './report-formatter.js';

program
  .name('atlas-perf')
  .description('Performance profiling tooling for Atlas backup/restore pipelines')
  .version('0.1.0');

program
  .command('profile')
  .description('Run an atlas command with CPU profiling and output a text analysis')
  .option('--flamegraph', 'Also generate flamegraph HTML via 0x', false)
  .option('-o, --output-dir <dir>', 'Directory for profile artifacts', '.perf-output')
  .argument('[atlas-args...]', 'Arguments passed to the atlas CLI (e.g. backup -m user@co.com)')
  .action(async (atlas_args: string[], opts: { flamegraph: boolean; outputDir: string }) => {
    const output_dir = resolve(process.cwd(), opts.outputDir);
    await mkdir(output_dir, { recursive: true });

    console.log('[atlas-perf] Starting profiled run...\n');

    let result;
    try {
      result = await run_profiled({
        atlas_args,
        output_dir,
        use_0x: opts.flamegraph,
      });
    } catch (err) {
      // Setup problems, a missing CLI build above all, are operator mistakes rather than crashes,
      // so they get the message without a stack trace on top of it.
      console.error(`[atlas-perf] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n[atlas-perf] Process exited with code ${result.exit_code}`);

    if (result.exit_code !== 0) {
      // A profile of a failed run measures the failure. Reporting on it looked like a successful
      // analysis and exited 0, which is how a broken CLI path went unnoticed (issue #207).
      console.error(
        '[atlas-perf] The profiled command failed, so there is nothing worth analysing. ' +
          'Fix the command first, then re-run.',
      );
      process.exitCode = result.exit_code;
      return;
    }

    console.log(`[atlas-perf] CPU profile: ${result.cpuprofile_path}`);
    if (result.flamegraph_path) {
      console.log(`[atlas-perf] Flamegraph: ${result.flamegraph_path}`);
    }

    console.log('\n[atlas-perf] Analyzing profile...\n');

    const command_label = `atlas ${atlas_args.join(' ')}`;
    const report = await parse_profile(result.cpuprofile_path, command_label);
    const output = format_report(report);

    console.log(output);
  });

program
  .command('analyze')
  .description('Analyze an existing .cpuprofile file and output a text report')
  .argument('<cpuprofile>', 'Path to a .cpuprofile file')
  .option('-l, --label <label>', 'Command label for the report header', 'atlas (unknown)')
  .action(async (cpuprofile: string, opts: { label: string }) => {
    const file_path = resolve(process.cwd(), cpuprofile);

    console.log(`[atlas-perf] Analyzing: ${file_path}\n`);

    const report = await parse_profile(file_path, opts.label);
    const output = format_report(report);

    console.log(output);
  });

program.parse();
