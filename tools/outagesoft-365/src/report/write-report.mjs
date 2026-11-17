/**
 * `write_report(run_dir)`: reads a run directory and writes report.json and report.md into it.
 *
 * Used by `run` after the child exits and by `report` to rebuild from an existing journal. The
 * journal is streamed twice (see report-passes.mjs); the outputs are written to a temporary name
 * and renamed, so an interrupted rebuild never leaves a half-written report beside a good journal.
 */
import { chmod, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journal_path, read_run_info, stream_journal } from './journal/journal-reader.mjs';
import { assemble_report_model } from './analysis/report-model.mjs';
import { create_first_pass, create_second_pass } from './analysis/report-passes.mjs';
import { render_markdown } from './render/render-markdown.mjs';
import { render_terminal } from './render/render-terminal.mjs';

/**
 * Writes a file through a temporary sibling and a rename, with mode 0600 like the engine's own
 * run files: a report names request shapes and timings of someone's tenant.
 */
export async function write_file_atomically(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  // writeFile applies the mode only when it creates the file; a leftover temporary keeps its own.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Streams the journal through both passes and returns the report model. */
export async function build_report_from_run_dir(run_dir) {
  const run_info = await read_run_info(run_dir);
  const path = journal_path(run_dir);
  const first_pass = create_first_pass();
  const reader = await stream_journal(path, (a) => first_pass.add(a));
  const first = first_pass.finish();
  const second_pass = create_second_pass(run_info.run, first);
  if (reader.attempts) await stream_journal(path, (a) => second_pass.add(a));
  const second = second_pass.finish();
  return assemble_report_model(run_info, reader, first, second);
}

/** Builds the report for a run directory, writes report.json and report.md, returns the summary. */
export async function write_report(run_dir) {
  const model = await build_report_from_run_dir(run_dir);
  const report_path = join(run_dir, 'report.md');
  await write_file_atomically(join(run_dir, 'report.json'), `${JSON.stringify(model, null, 2)}\n`);
  await write_file_atomically(report_path, render_markdown(model));
  return { report_path, terminal_summary: render_terminal(model, report_path) };
}
