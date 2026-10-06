// Prints merged coverage per workspace package from coverage/coverage-summary.json.
//
// The root `vitest run --coverage` measures every source file against every package's tests, then
// writes one entry per file. This folds those entries back into one row per package, which is the
// number to read: a package's own run undercounts code exercised from elsewhere (issue #445).

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const repo_root = resolve(import.meta.dirname, '../..');
const summary_path = resolve(repo_root, 'coverage/coverage-summary.json');
const METRICS = ['lines', 'branches', 'functions', 'statements'];

let summary;
try {
  summary = JSON.parse(readFileSync(summary_path, 'utf8'));
} catch {
  console.error(`No ${relative(repo_root, summary_path)}; run \`pnpm run test:coverage\` first.`);
  process.exit(1);
}

const packages = new Map();
for (const [file, metrics] of Object.entries(summary)) {
  const match = /packages\/([^/]+)\/src\//.exec(file.replaceAll('\\', '/'));
  if (!match) continue;
  const name = match[1];
  if (!packages.has(name)) {
    packages.set(name, Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }])));
  }
  const totals = packages.get(name);
  for (const metric of METRICS) {
    totals[metric].covered += metrics[metric].covered;
    totals[metric].total += metrics[metric].total;
  }
}

const percent = ({ covered, total }) => (total === 0 ? '-' : `${((covered / total) * 100).toFixed(1)}%`);
const rows = [...packages.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, totals]) => [name, ...METRICS.map((metric) => percent(totals[metric]))]);
const header = ['Package', 'Lines', 'Branches', 'Functions', 'Statements'];
const widths = header.map((title, column) =>
  Math.max(title.length, ...rows.map((row) => row[column].length)),
);
const format = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ');

console.log('\nMerged coverage per package (every package test run counted)\n');
console.log(format(header));
console.log(format(widths.map((width) => '-'.repeat(width))));
for (const row of rows) console.log(format(row));
