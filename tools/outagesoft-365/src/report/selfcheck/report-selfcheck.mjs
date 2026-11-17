/**
 * Self-check for the report half of outagesoft-365. No network, no relay, no credentials.
 *
 * Builds synthetic run directories in a temporary folder, writes each report through the real
 * `write_report` and `write_compare` paths, and asserts on report.json, report.md and the terminal
 * summary. Stops at the first failure.
 *
 * Run with: node tools/outagesoft-365/src/report/report-selfcheck.mjs
 */
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { create_workspace } from './report-selfcheck-fixtures.mjs';
import { behaviour_checks } from './report-selfcheck-behaviour.mjs';
import { verdict_checks } from './report-selfcheck-verdicts.mjs';
import { robustness_checks } from './report-selfcheck-robustness.mjs';
import { engine_field_checks } from './report-selfcheck-engine-fields.mjs';
import { paging_checks } from './report-selfcheck-paging.mjs';

/** Runs every report check, printing `ok` lines; throws on the first failure and returns the count. */
export async function run_report_selfcheck() {
  const workspace = await create_workspace();
  const checks = [
    ...behaviour_checks,
    ...verdict_checks,
    ...robustness_checks,
    ...engine_field_checks,
    ...paging_checks,
  ];
  try {
    for (const [name, check] of checks) {
      try {
        await check(workspace);
      } catch (err) {
        err.message = `report selfcheck failed: ${name}\n${err.message}`;
        throw err;
      }
      console.log(`  ok  ${name}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  return checks.length;
}

function is_entry_module() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (is_entry_module()) {
  try {
    const count = await run_report_selfcheck();
    console.log(`\n${count} report checks passed`);
  } catch (err) {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  }
}
