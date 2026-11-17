/**
 * Self-check cases for the nine correctness verdicts: each check's PASS and its FAIL or WARN, plus
 * the NEEDS EVIDENCE fallbacks for journals that predate the replay fields.
 */
import assert from 'node:assert/strict';
import {
  DELTA_URL,
  SEND_URL,
  rec,
  report_for,
  run_json,
  verdict,
} from './report-selfcheck-fixtures.mjs';

const ok = (t, key, extra = {}) => rec({ t, key, ...extra });

async function verdict_of(ws, name, number, options) {
  const { model } = await report_for(ws, name, options);
  return verdict(model, number);
}

function post(t, key, extra) {
  return rec({ t, key, method: 'POST', url: SEND_URL, status: 202, ...extra });
}

/** Verdict checks as `[name, async (workspace) => void]`. */
export const verdict_checks = [
  [
    'verdict 1 Retry-After: PASS when honoured, FAIL when early',
    async (ws) => {
      const throttled = (key) =>
        rec({ t: 0, key, fault: 'throttle_429', status: 429, retry_after: 5, total: 0 });
      assert.equal(
        (await verdict_of(ws, 'v1-pass', 1, { lines: [throttled('a'), ok(5000, 'a')] })).verdict,
        'PASS',
      );
      const fail = await verdict_of(ws, 'v1-fail', 1, { lines: [throttled('a'), ok(1000, 'a')] });
      assert.equal(fail.verdict, 'FAIL');
      assert.equal(fail.examples.length, 1);
      assert.equal(
        (await verdict_of(ws, 'v1-none', 1, { lines: [ok(0, 'a')] })).verdict,
        'NOT OBSERVED',
      );
    },
  ],
  [
    'verdict 2 backoff: PASS when gaps grow, WARN when hammering',
    async (ws) => {
      const fail = (t) => rec({ t, key: 'b', fault: 'server_500', status: 500, total: 0 });
      assert.equal(
        (await verdict_of(ws, 'v2-pass', 2, { lines: [fail(0), fail(500), ok(2000, 'b')] }))
          .verdict,
        'PASS',
      );
      assert.equal(
        (await verdict_of(ws, 'v2-warn', 2, { lines: [fail(0), fail(10), fail(20), ok(30, 'b')] }))
          .verdict,
        'WARN',
      );
    },
  ],
  [
    'verdict 3 retry safety: FAIL, WARN, PASS and NEEDS EVIDENCE',
    async (ws) => {
      const lost = post(0, 'c', {
        fault: 'lost_response',
        forwarded: true,
        upstream_status: 202,
        status: null,
        outcome: 'reset',
        idempotent: false,
      });
      const stalled = post(0, 'c', {
        fault: 'no_response',
        status: null,
        outcome: 'no_response',
        idempotent: false,
      });
      assert.equal(
        (
          await verdict_of(ws, 'v3-fail', 3, {
            lines: [lost, post(2000, 'c', { idempotent: false })],
          })
        ).verdict,
        'FAIL',
      );
      assert.equal(
        (
          await verdict_of(ws, 'v3-warn', 3, {
            lines: [stalled, post(2000, 'c', { idempotent: false })],
          })
        ).verdict,
        'WARN',
      );
      assert.equal((await verdict_of(ws, 'v3-pass', 3, { lines: [lost] })).verdict, 'PASS');
      const legacy = post(0, 'c', {
        fault: 'lost_response',
        forwarded: true,
        upstream_status: 202,
        status: null,
        outcome: 'reset',
      });
      assert.equal(
        (await verdict_of(ws, 'v3-legacy', 3, { lines: [legacy, post(2000, 'c')] })).verdict,
        'NEEDS EVIDENCE',
      );
    },
  ],
  [
    'verdict 4 duplicate processing: PASS once, WARN when re-fetched',
    async (ws) => {
      assert.equal(
        (await verdict_of(ws, 'v4-pass', 4, { lines: [ok(0, 'd1'), ok(10, 'd2')] })).verdict,
        'PASS',
      );
      const warn = await verdict_of(ws, 'v4-warn', 4, {
        lines: [ok(0, 'd1', { kind: 'download' }), ok(900, 'd1', { kind: 'download' })],
      });
      assert.equal(warn.verdict, 'WARN');
      assert.equal(warn.evidence.download_refetches, 1);
    },
  ],
  [
    'verdict 5 checkpoint: PASS on same page or demanded restart, WARN on unprompted restart',
    async (ws) => {
      const page = (t, key, extra) =>
        rec({
          t,
          key,
          identity: 'folder',
          url: DELTA_URL,
          kind: 'delta',
          cursor: 'delta',
          ...extra,
        });
      const same = [page(0, 'p1', { fault: 'server_500', status: 500 }), page(500, 'p1')];
      assert.equal((await verdict_of(ws, 'v5-same', 5, { lines: same })).verdict, 'PASS');
      const restart = [
        page(0, 'p1', { fault: 'server_500', status: 500 }),
        page(500, 'p0', { cursor: null }),
      ];
      assert.equal((await verdict_of(ws, 'v5-restart', 5, { lines: restart })).verdict, 'WARN');
      const demanded = [
        page(0, 'p1', { fault: 'delta_resync_410', status: 410, graph_error: 'resyncRequired' }),
        page(500, 'p0', { cursor: null }),
      ];
      assert.equal((await verdict_of(ws, 'v5-demanded', 5, { lines: demanded })).verdict, 'PASS');
      assert.equal(
        (await verdict_of(ws, 'v5-legacy', 5, { lines: [ok(0, 'x')] })).verdict,
        'NEEDS EVIDENCE',
      );
    },
  ],
  [
    'verdict 6 corrupt answers: PASS when re-requested, FAIL when accepted, NEEDS EVIDENCE for invisible faults',
    async (ws) => {
      const corrupt = rec({ t: 0, key: 'm', fault: 'malformed_json', forwarded: true });
      assert.equal(
        (await verdict_of(ws, 'v6-pass', 6, { lines: [corrupt, ok(300, 'm')] })).verdict,
        'PASS',
      );
      assert.equal((await verdict_of(ws, 'v6-fail', 6, { lines: [corrupt] })).verdict, 'FAIL');
      const dropped = rec({ t: 0, key: 'n', fault: 'drop_next_link', forwarded: true });
      assert.equal(
        (await verdict_of(ws, 'v6-evidence', 6, { lines: [dropped] })).verdict,
        'NEEDS EVIDENCE',
      );
    },
  ],
  [
    'verdict 7 satisfied: PASS when recovered, FAIL when swallowed with exit 0',
    async (ws) => {
      const fail = (t) => rec({ t, key: 's', fault: 'unavailable_503', status: 503 });
      assert.equal(
        (await verdict_of(ws, 'v7-pass', 7, { lines: [fail(0), ok(800, 's')] })).verdict,
        'PASS',
      );
      const swallowed = await verdict_of(ws, 'v7-fail', 7, { lines: [fail(0), fail(800)] });
      assert.equal(swallowed.verdict, 'FAIL');
      assert.equal(swallowed.examples.length, 1);
      const surfaced = run_json({ child: { exit_code: 1, signal: null, duration_ms: 900 } });
      assert.equal(
        (await verdict_of(ws, 'v7-surfaced', 7, { run: surfaced, lines: [fail(0), fail(800)] }))
          .verdict,
        'PASS',
      );
    },
  ],
  [
    'verdict 8 completeness: PASS and FAIL from verify, NEEDS EVIDENCE without it',
    async (ws) => {
      const lines = [ok(0, 'v')];
      assert.equal(
        (
          await verdict_of(ws, 'v8-pass', 8, {
            run: run_json({ verify: { exit_code: 0, duration_ms: 4000 } }),
            lines,
          })
        ).verdict,
        'PASS',
      );
      assert.equal(
        (
          await verdict_of(ws, 'v8-fail', 8, {
            run: run_json({ verify: { exit_code: 2, duration_ms: 4000 } }),
            lines,
          })
        ).verdict,
        'FAIL',
      );
      const none = await verdict_of(ws, 'v8-none', 8, { lines });
      assert.equal(none.verdict, 'NEEDS EVIDENCE');
      assert.match(none.summary, /--verify-cmd/);
    },
  ],
  [
    'verdict 9 replay: PASS when faithful, WARN and a loud warning on divergence',
    async (ws) => {
      const lines = [
        rec({
          t: 0,
          key: 'r',
          fault: { id: 'server_500', source: 'replay', params: {} },
          status: 500,
        }),
        ok(400, 'r'),
      ];
      const faithful = run_json({
        replay: {
          of: '2026-11-13T10-00-00Z',
          scheduled: 1,
          applied: 1,
          not_encountered: 0,
          unscheduled_requests: 0,
        },
      });
      assert.equal((await verdict_of(ws, 'v9-pass', 9, { run: faithful, lines })).verdict, 'PASS');
      const diverged = run_json({
        replay: {
          of: '2026-11-13T10-00-00Z',
          scheduled: 4,
          applied: 1,
          not_encountered: 3,
          unscheduled_requests: 2,
        },
      });
      const { model, md, terminal } = await report_for(ws, 'v9-warn', { run: diverged, lines });
      assert.equal(verdict(model, 9).verdict, 'WARN');
      assert.ok(model.warnings.some((w) => w.code === 'replay_diverged' && w.level === 'loud'));
      assert.match(md, /\[!CAUTION\]\n> Replay of/);
      assert.match(terminal, /Replay of .* diverged/);
      assert.equal((await verdict_of(ws, 'v9-none', 9, { lines })).verdict, 'NOT OBSERVED');
    },
  ],
  [
    'every non-PASS verdict gets one terminal line',
    async (ws) => {
      const { model, terminal } = await report_for(ws, 'v-terminal', {
        lines: [
          rec({ t: 0, key: 'a', fault: 'throttle_429', status: 429, retry_after: 5, total: 0 }),
          ok(1000, 'a'),
        ],
      });
      const non_pass = model.verdicts.filter((v) => v.verdict !== 'PASS');
      assert.ok(non_pass.length > 0);
      for (const v of non_pass) assert.ok(terminal.includes(`${v.number} ${v.title}:`), v.title);
      for (const v of model.verdicts.filter((x) => x.verdict === 'PASS'))
        assert.ok(!terminal.includes(`${v.number} ${v.title}:`), v.title);
    },
  ],
];
