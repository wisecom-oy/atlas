/**
 * `write_compare(baseline_dir, run_dir)`: compares two runs by identity and writes compare.md and
 * compare.json into the second run's directory.
 *
 * Refuses, by throwing an error with code `OUTAGESOFT_COMPARE_REFUSED` and writing nothing, when
 * either journal is missing, empty, or lacks identity_key: comparing by url_key instead would
 * report every changed delta token as a lost item.
 */
import { basename, join, resolve } from 'node:path';
import { journal_path, stream_journal } from './journal-reader.mjs';
import { compare_censuses, compare_refusal, create_identity_census } from './compare-model.mjs';
import { render_compare_markdown, render_compare_terminal } from './render-compare.mjs';
import { write_file_atomically } from './write-report.mjs';

async function take_census(run_dir) {
  const census = create_identity_census();
  const reader = await stream_journal(journal_path(run_dir), (a) => census.add(a));
  return { ...census.finish(), journal_present: reader.journal_present };
}

/** Compares two run directories and writes the result into `run_dir`. */
export async function write_compare(baseline_dir, run_dir) {
  if (resolve(baseline_dir) === resolve(run_dir)) {
    throw Object.assign(new Error('Cannot compare a run with itself.'), {
      code: 'OUTAGESOFT_COMPARE_REFUSED',
    });
  }
  const [baseline, run] = [await take_census(baseline_dir), await take_census(run_dir)];
  const refusal = compare_refusal(baseline, run);
  if (refusal) throw Object.assign(new Error(refusal), { code: 'OUTAGESOFT_COMPARE_REFUSED' });
  const comparison = compare_censuses(baseline, run);
  // Directory names only: an absolute path can carry a username.
  const names = { baseline: basename(resolve(baseline_dir)), run: basename(resolve(run_dir)) };
  const report_path = join(run_dir, 'compare.md');
  await write_file_atomically(
    join(run_dir, 'compare.json'),
    `${JSON.stringify({ ...names, ...comparison }, null, 2)}\n`,
  );
  await write_file_atomically(report_path, render_compare_markdown(comparison, names));
  return { report_path, terminal_summary: render_compare_terminal(comparison, report_path) };
}
