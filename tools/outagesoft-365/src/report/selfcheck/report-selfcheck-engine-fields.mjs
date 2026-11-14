/**
 * Self-check cases for fields the engine records beyond the first contract: body_key, occurrence,
 * delivered.error, fault.category, the extra run.json counters, replay sources, and file modes.
 */
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SEND_URL,
  origin,
  rec,
  report_for,
  run_json,
  verdict,
} from './report-selfcheck-fixtures.mjs';

const BATCH_URL = 'graph.microsoft.com/v1.0/$batch';
const ok = (t, key, extra = {}) => rec({ t, key, ...extra });
const batch = (t, body_key, extra = {}) =>
  rec({
    t,
    key: 'batch',
    method: 'POST',
    url: BATCH_URL,
    service: 'directory',
    kind: 'batch',
    idempotent: false,
    body_key,
    ...extra,
  });

/** Engine-field checks as `[name, async (workspace) => void]`. */
export const engine_field_checks = [
  [
    'body_key keeps two different POSTs apart and groups a re-sent write',
    async (ws) => {
      const distinct = await report_for(ws, 'body-distinct', {
        lines: [
          batch(0, 'aaaaaaaaaaaaaaaa', { fault: 'server_500', status: 500 }),
          batch(800, 'bbbbbbbbbbbbbbbb'),
        ],
      });
      assert.equal(
        origin(distinct.model, 'server_500').not_retried,
        1,
        'a different $batch body was read as a retry',
      );
      const lost = {
        fault: 'lost_response',
        forwarded: true,
        upstream_status: 202,
        status: null,
        outcome: 'reset',
        idempotent: false,
        body_key: 'cccccccccccccccc',
      };
      const resent = await report_for(ws, 'body-resent', {
        lines: [
          rec({ t: 0, key: 's', method: 'POST', url: SEND_URL, ...lost }),
          rec({
            t: 900,
            key: 's',
            method: 'POST',
            url: SEND_URL,
            status: 202,
            idempotent: false,
            body_key: 'cccccccccccccccc',
          }),
        ],
      });
      assert.equal(resent.model.response.relations.duplicates.list[0].same_body, true);
      assert.equal(verdict(resent.model, 3).verdict, 'FAIL');
      assert.match(verdict(resent.model, 3).summary, /matched by URL and body digest/);
      assert.match(resent.md, /Non-GET requests are also matched by a digest of the request body/);
    },
  ],
  [
    'without body_key, re-sends are matched by URL only and say so',
    async (ws) => {
      const lost = {
        fault: 'lost_response',
        forwarded: true,
        upstream_status: 202,
        status: null,
        outcome: 'reset',
        idempotent: false,
      };
      const { model, md } = await report_for(ws, 'body-legacy', {
        lines: [
          rec({ t: 0, key: 's', method: 'POST', url: SEND_URL, ...lost }),
          rec({ t: 900, key: 's', method: 'POST', url: SEND_URL, status: 202, idempotent: false }),
        ],
      });
      assert.equal(verdict(model, 3).evidence.resent_matched_by_url_only, 1);
      assert.match(md, /look like a retry of each other/);
    },
  ],
  [
    'batch_inner_429 params never count as an advised Retry-After',
    async (ws) => {
      const inner = {
        id: 'batch_inner_429',
        category: 'throttle',
        source: 'profile',
        params: { retry_after_s: 9, count: 2 },
      };
      const { model } = await report_for(ws, 'batch-inner', {
        lines: [
          batch(0, 'dddddddddddddddd', { fault: inner, forwarded: true }),
          batch(1000, 'dddddddddddddddd'),
        ],
      });
      assert.equal(model.response.relations.retry_after.advised, 0);
      assert.equal(verdict(model, 1).verdict, 'NOT OBSERVED');
      assert.equal(
        model.response.relations.content.find((c) => c.fault_id === 'batch_inner_429').re_requested,
        1,
      );
    },
  ],
  [
    'occurrence turns a consecutive retry into a counted one',
    async (ws) => {
      const fail = (t, occurrence) =>
        rec({ t, key: 'o', fault: 'server_500', status: 500, occurrence });
      const counted = await report_for(ws, 'occurrence-counted', {
        lines: [fail(0, 1), ok(600, 'o', { occurrence: 2 })],
      });
      assert.equal(origin(counted.model, 'server_500').retried_counted_by_occurrence, 1);
      const gap = await report_for(ws, 'occurrence-gap', {
        lines: [fail(0, 1), ok(600, 'o', { occurrence: 3 })],
      });
      assert.equal(origin(gap.model, 'server_500').retried_counted_by_occurrence, 0);
    },
  ],
  [
    'delivered.error names transport failures and the journal category wins',
    async (ws) => {
      const reset = rec({
        t: 0,
        key: 'r',
        fault: 'connection_reset',
        category: 'transport',
        status: null,
        outcome: 'reset',
        error: 'other side closed',
      });
      const custom = rec({ t: 10, key: 'c', fault: 'server_500', category: 'custom', status: 500 });
      const { model, md } = await report_for(ws, 'delivered-error', { lines: [reset, custom] });
      assert.ok(model.compare.errors.some((e) => e.code === 'transport: other side closed'));
      assert.match(md, /transport: other side closed/);
      const entry = model.injected.by_fault.find((f) => f.fault_id === 'server_500');
      assert.deepEqual([entry.category, entry.category_source], ['custom', 'journal']);
    },
  ],
  [
    'a child that failed to start is reported as such',
    async (ws) => {
      const run = run_json({
        child: { exit_code: null, signal: null, duration_ms: 3, error: 'ENOENT' },
        relayed_requests: 0,
      });
      const { model, md, terminal } = await report_for(ws, 'spawn-failed', { run, lines: [] });
      assert.ok(
        model.warnings.some((w) => w.code === 'child_failed_to_start' && w.level === 'loud'),
      );
      assert.ok(
        model.warnings.some((w) => w.code === 'zero_relayed' && /failed to start/.test(w.text)),
      );
      assert.match(md, /The command failed to start \(ENOENT\)/);
      assert.match(md, /\| Child \| failed to start \(ENOENT\) \|/);
      assert.match(terminal, /failed to start/);
    },
  ],
  [
    'rejected requests, relay errors, max hold and interruption are shown',
    async (ws) => {
      const run = run_json({
        rejected_requests: 2,
        relay_errors: 1,
        max_hold_ms: 120000,
        child: { exit_code: 130, signal: null, duration_ms: 50, interrupted: true },
      });
      const { model, md } = await report_for(ws, 'relay-counters', {
        run,
        lines: ['{"relay_error":"journal write failed"}', ok(0, 'a')],
      });
      assert.ok(model.warnings.some((w) => w.code === 'rejected_requests'));
      assert.ok(model.warnings.some((w) => w.code === 'interrupted'));
      assert.match(md, /2 rejected for a wrong token, 1 relay errors/);
      assert.match(md, /\| Longest injected wait \(max hold\) \| 2m 00s \|/);
      assert.match(md, /after the run was interrupted/);
    },
  ],
  [
    'a replay with no outages reports replayed faults and no outage window',
    async (ws) => {
      const replayed = (t) =>
        rec({
          t,
          key: 'x',
          fault: { id: 'unavailable_503', category: 'server', source: 'replay', params: {} },
          status: 503,
        });
      const run = run_json({
        outages: [],
        replay: {
          of: 'source-run',
          scheduled: 2,
          applied: 2,
          not_encountered: 0,
          unscheduled_requests: 0,
        },
      });
      const { model } = await report_for(ws, 'replay-no-outage', {
        run,
        lines: [replayed(0), replayed(500), ok(900, 'x')],
      });
      assert.equal(model.outages.length, 0);
      assert.equal(model.injected.by_fault[0].from_replay, 2);
      assert.ok(model.timeline.buckets.every((b) => b.outage_faults === 0 && !b.outages.length));
    },
  ],
  [
    'successive pages of one enumeration are not counted as re-fetches',
    async (ws) => {
      const page = (t, key, cursor) =>
        rec({ t, key, identity: 'inbox-delta', kind: 'delta', cursor });
      const pages = [page(0, 'p0', 'delta'), page(100, 'p1', 'skip'), page(200, 'p2', 'skip')];
      const { model } = await report_for(ws, 'paging', { lines: pages });
      assert.equal(verdict(model, 4).verdict, 'PASS');
      const again = await report_for(ws, 'paging-again', {
        lines: [...pages, page(900, 'p1', 'skip')],
      });
      assert.equal(verdict(again.model, 4).evidence.delta_refetches, 1);
    },
  ],
  [
    'report files are written with mode 0600',
    async (ws) => {
      const { dir } = await report_for(ws, 'modes', { lines: [ok(0, 'a')] });
      if (process.platform === 'win32') return;
      for (const name of ['report.json', 'report.md']) {
        assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
      }
    },
  ],
];
