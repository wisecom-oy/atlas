/**
 * Self-check cases for untrusted and incomplete input, output hygiene, and the compare command.
 */
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TERMINAL_LINE_BUDGET } from './render-terminal.mjs';
import { write_compare } from './write-compare.mjs';
import {
  DRIVE_URL,
  rec,
  report_for,
  run_json,
  write_run_dir,
} from './report-selfcheck-fixtures.mjs';

const ok = (t, key, extra = {}) => rec({ t, key, ...extra });

function noisy_run_lines() {
  const lines = [];
  for (let i = 0; i < 60; i += 1) {
    const key = `u${i}`;
    lines.push(
      rec({ t: i * 200, key, fault: 'throttle_429', status: 429, retry_after: 1, total: 2 }),
    );
    lines.push(ok(i * 200 + 1500, key));
  }
  lines.push(rec({ t: 20000, key: 'x', fault: 'quantum_flux', forwarded: true }));
  return lines;
}

/** Robustness and compare checks as `[name, async (workspace) => void]`. */
export const robustness_checks = [
  [
    'zero relayed requests produce the loud warning',
    async (ws) => {
      const { model, md, terminal } = await report_for(ws, 'zero', {
        run: run_json({ relayed_requests: 0 }),
        lines: [],
      });
      assert.ok(model.warnings.some((w) => w.code === 'zero_relayed' && w.level === 'loud'));
      assert.match(md, /\[!CAUTION\]\n> No requests were relayed/);
      assert.match(terminal, /No requests were relayed/);
    },
  ],
  [
    'a non-zero child exit produces its warning',
    async (ws) => {
      const { model, md } = await report_for(ws, 'exit3', {
        run: run_json({ child: { exit_code: 3, signal: null, duration_ms: 10 } }),
        lines: [ok(0, 'a')],
      });
      assert.ok(model.warnings.some((w) => w.code === 'child_failed'));
      assert.match(md, /The child exited with code 3/);
    },
  ],
  [
    'malformed and relay_error lines are counted, not fatal',
    async (ws) => {
      const lines = [
        '{not json',
        '{"relay_error":"planner threw"}',
        '{"t":1}',
        '[1,2]',
        '',
        ok(0, 'a'),
        ok(10, 'b'),
      ];
      const { model, md } = await report_for(ws, 'malformed', { lines });
      assert.deepEqual(
        [model.input.attempts, model.input.malformed, model.input.relay_errors],
        [2, 3, 1],
      );
      assert.ok(model.warnings.some((w) => w.code === 'relay_errors'));
      assert.match(md, /planner threw/);
    },
  ],
  [
    'a killed run without child or finish time still produces a report',
    async (ws) => {
      const run = run_json({ finished_at: null, child: null, relayed_requests: 5 });
      const { model, md } = await report_for(ws, 'killed', {
        run,
        lines: [
          ok(0, 'a'),
          rec({
            t: 5,
            key: 'b',
            fault: 'no_response',
            status: null,
            outcome: 'no_response',
            total: 90000,
          }),
        ],
      });
      assert.equal(model.run.finalised, false);
      assert.ok(model.warnings.some((w) => w.code === 'unjournaled'));
      assert.match(md, /child result was not recorded/);
    },
  ],
  [
    'a missing or corrupt run.json is tolerated',
    async (ws) => {
      const { model } = await report_for(ws, 'corrupt-run', {
        run: '{"schema": 1, "profile":',
        lines: [ok(0, 'a')],
      });
      assert.equal(model.run.run_json_present, false);
      assert.equal(model.requested.totals.requests, 1);
    },
  ],
  [
    'an unknown fault id is reported generically',
    async (ws) => {
      const { model } = await report_for(ws, 'unknown-fault', {
        lines: [rec({ t: 0, key: 'q', fault: 'quantum_flux', status: 503 })],
      });
      assert.equal(model.injected.by_fault[0].category, 'unknown');
      assert.equal(model.response.chains.by_origin[0].label, 'quantum_flux');
    },
  ],
  [
    'report.md has no em dash and no raw path, and the terminal stays in budget',
    async (ws) => {
      const run = run_json({
        outages: [
          { service: 'onedrive', start_ms: 1000, duration_ms: 5000, fault: 'unavailable_503' },
        ],
      });
      const { md, terminal, report_path } = await report_for(ws, 'hygiene', {
        run,
        lines: noisy_run_lines(),
      });
      assert.ok(!md.includes(String.fromCharCode(0x2014)), 'em dash in report.md');
      assert.ok(
        !/\s--\s/.test(md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')),
        'double hyphen used as punctuation',
      );
      assert.ok(!md.includes('/opt/node-runtime'), 'executable path leaked');
      assert.ok(
        md.includes('`--verify-cmd "<verification command>"`'),
        'code span was entity-escaped',
      );
      assert.ok(
        md.startsWith('# outagesoft-365 report\n\n'),
        'heading not followed by a blank line',
      );
      const lines = terminal.split('\n');
      assert.ok(lines.length <= TERMINAL_LINE_BUDGET, `${lines.length} terminal lines`);
      assert.equal(lines[lines.length - 1], `report: ${report_path}`);
    },
  ],
  [
    'compare finds three identities fetched in the baseline but never in the run',
    async (ws) => {
      const fetch = (t, id, extra) =>
        rec({
          t,
          key: `k-${id}-${t}`,
          identity: id,
          url: DRIVE_URL,
          service: 'onedrive',
          kind: 'download',
          ...extra,
        });
      const baseline = await write_run_dir(ws, 'cmp-baseline', {
        run: run_json({ profile: { id: 'passthrough', severity: 0, rates: {} } }),
        lines: ['f1', 'f2', 'f3', 'f4', 'f5'].map((id, i) => fetch(i * 10, id)),
      });
      const faulted = await write_run_dir(ws, 'cmp-run', {
        lines: [
          fetch(0, 'f1'),
          fetch(10, 'f2'),
          fetch(20, 'f3', { fault: 'unavailable_503', status: 503 }),
          fetch(30, 'f3', { fault: 'unavailable_503', status: 503 }),
          fetch(40, 'f9'),
        ],
      });
      const { report_path, terminal_summary } = await write_compare(baseline, faulted);
      const json = JSON.parse(await readFile(join(faulted, 'compare.json'), 'utf8'));
      assert.deepEqual(
        [json.lost.total, json.lost.requested_never_succeeded, json.lost.never_requested],
        [3, 1, 2],
      );
      assert.equal(json.only_in_run.total, 1);
      assert.match(terminal_summary, /LOST: 3 identities/);
      assert.match(await readFile(report_path, 'utf8'), /never fetched successfully in this run/);
    },
  ],
  [
    'compare refuses journals without identity_key',
    async (ws) => {
      const legacy = (t) => rec({ t, key: `k${t}`, identity: null });
      const baseline = await write_run_dir(ws, 'cmp-legacy-a', { lines: [legacy(0)] });
      const faulted = await write_run_dir(ws, 'cmp-legacy-b', { lines: [legacy(0)] });
      await assert.rejects(
        write_compare(baseline, faulted),
        (err) => err.code === 'OUTAGESOFT_COMPARE_REFUSED' && /identity_key/.test(err.message),
      );
      await assert.rejects(access(join(faulted, 'compare.md')));
    },
  ],
];
