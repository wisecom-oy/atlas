/**
 * Self-check cases for how the report reads client behaviour: retry chains, Retry-After, backoff,
 * polling, timeouts, duplicate writes, content faults, skipped mutations and outage windows.
 */
import assert from 'node:assert/strict';
import {
  DRIVE_URL,
  MAIL_URL,
  SEND_URL,
  origin,
  rec,
  report_for,
  run_json,
} from './report-selfcheck-fixtures.mjs';

const ok = (t, key, extra = {}) => rec({ t, key, ...extra });

/** Behaviour checks as `[name, async (workspace) => void]`. */
export const behaviour_checks = [
  [
    'a 429 retried after its Retry-After is recovered and honoured',
    async (ws) => {
      const { model } = await report_for(ws, 'recovered', {
        lines: [
          rec({
            t: 0,
            key: 'a',
            fault: 'throttle_429',
            status: 429,
            retry_after: 2,
            total: 3,
            graph_error: 'ApplicationThrottled',
          }),
          ok(2100, 'a'),
        ],
      });
      const o = origin(model, 'throttle_429');
      assert.equal(o.recovered, 1);
      assert.equal(o.attempts_to_clean.max, 2);
      assert.equal(model.response.relations.retry_after.honoured, 1);
      assert.equal(model.response.relations.retry_after.early, 0);
    },
  ],
  [
    'a fault never requested again is not retried',
    async (ws) => {
      const { model } = await report_for(ws, 'not-retried', {
        lines: [rec({ t: 0, key: 'b', fault: 'server_500', status: 500 }), ok(50, 'other')],
      });
      const o = origin(model, 'server_500');
      assert.deepEqual([o.recovered, o.unrecovered, o.not_retried], [0, 0, 1]);
    },
  ],
  [
    'a chain failing to the end is unrecovered',
    async (ws) => {
      const fail = (t) => rec({ t, key: 'c', fault: 'unavailable_503', status: 503 });
      const { model } = await report_for(ws, 'unrecovered', {
        lines: [fail(0), fail(1000), fail(3000)],
      });
      const o = origin(model, 'unavailable_503');
      assert.deepEqual([o.chains, o.unrecovered], [1, 1]);
    },
  ],
  [
    'a retry before the advised wait counts as early',
    async (ws) => {
      const { model } = await report_for(ws, 'early', {
        lines: [
          rec({ t: 0, key: 'd', fault: 'throttle_429', status: 429, retry_after: 10, total: 5 }),
          ok(2005, 'd'),
        ],
      });
      const ra = model.response.relations.retry_after;
      assert.deepEqual([ra.honoured, ra.early], [0, 1]);
      assert.equal(ra.tightest.gap_ms, 2000);
    },
  ],
  [
    'backoff gaps are summarised per step',
    async (ws) => {
      const fail = (t) => rec({ t, key: 'e', fault: 'server_500', status: 500, total: 0 });
      const { model } = await report_for(ws, 'backoff', {
        lines: [fail(0), fail(100), fail(500), ok(2100, 'e')],
      });
      const b = model.response.chains.backoff;
      assert.deepEqual(
        [b.self_chosen_ms.min, b.self_chosen_ms.median, b.self_chosen_ms.max],
        [100, 400, 1600],
      );
      assert.deepEqual(
        b.by_step.map((s) => s.median_ms),
        [100, 400, 1600],
      );
      assert.equal(b.hammering_chains, 0);
    },
  ],
  [
    'unfaulted polling of one URL forms no retry chain',
    async (ws) => {
      const polls = [0, 1000, 2000, 3000, 4000].map((t) => ok(t, 'poll'));
      const recovered_then_polled = [
        rec({ t: 0, key: 'p2', fault: 'server_500', status: 500 }),
        ok(500, 'p2'),
        ok(1500, 'p2'),
        ok(2500, 'p2'),
      ];
      const { model } = await report_for(ws, 'polling', {
        lines: [...polls, ...recovered_then_polled],
      });
      assert.equal(model.response.chains.total, 1);
      assert.equal(model.response.chains.detail[0].attempt_count, 2);
    },
  ],
  [
    'client_closed is reported as a client timeout with its wait',
    async (ws) => {
      const { model, md } = await report_for(ws, 'client-closed', {
        lines: [
          rec({
            t: 0,
            key: 'f',
            fault: 'no_response',
            status: null,
            outcome: 'client_closed',
            total: 30000,
          }),
          ok(31000, 'f'),
        ],
      });
      const t = model.response.chains.timeouts.find((x) => x.fault_id === 'no_response');
      assert.equal(t.waits_ms.max, 30000);
      assert.match(md, /`no_response` \| 1 \| 30\.0s/);
    },
  ],
  [
    'a lost_response POST that was re-sent is a duplicate-write risk',
    async (ws) => {
      const { model, md } = await report_for(ws, 'lost-write', {
        lines: [
          rec({
            t: 0,
            key: 'g',
            method: 'POST',
            url: SEND_URL,
            fault: 'lost_response',
            forwarded: true,
            upstream_status: 202,
            status: null,
            outcome: 'reset',
            idempotent: false,
          }),
          rec({ t: 1500, key: 'g', method: 'POST', url: SEND_URL, status: 202, idempotent: false }),
        ],
      });
      const d = model.response.relations.duplicates;
      assert.equal(d.total, 1);
      assert.equal(d.list[0].reached_upstream, true);
      assert.match(md, /likely ran twice/);
    },
  ],
  [
    'drop_next_link is tracked with and without a re-request',
    async (ws) => {
      const dropped = (t, key) => rec({ t, key, fault: 'drop_next_link', forwarded: true });
      const { model } = await report_for(ws, 'content', {
        lines: [dropped(0, 'h1'), ok(400, 'h1'), dropped(100, 'h2')],
      });
      const c = model.response.relations.content.find((x) => x.fault_id === 'drop_next_link');
      assert.deepEqual([c.applied, c.re_requested, c.not_re_requested], [2, 1, 1]);
    },
  ],
  [
    'a skipped mutation is counted with its reason, not as injected',
    async (ws) => {
      const { model } = await report_for(ws, 'skipped', {
        lines: [
          rec({
            t: 0,
            key: 'i',
            fault: {
              id: 'malformed_json',
              source: 'profile',
              params: {},
              skipped: 'not application/json',
            },
            forwarded: true,
            url: DRIVE_URL,
            service: 'onedrive',
            kind: 'download',
          }),
        ],
      });
      assert.equal(model.injected.applied_total, 0);
      assert.deepEqual(model.injected.skipped, [
        { fault_id: 'malformed_json', reason: 'not application/json', count: 1 },
      ]);
      assert.equal(model.response.chains.total, 0);
    },
  ],
  [
    'an outage window has exact counts and recovery time',
    async (ws) => {
      const out = (t, key) =>
        rec({
          t,
          key,
          fault: { id: 'unavailable_503', source: 'outage', params: {} },
          status: 503,
        });
      const lines = [
        ok(1000, 'pre'),
        out(11000, 'A'),
        out(14000, 'A'),
        out(20000, 'A'),
        out(29000, 'A'),
        out(12000, 'B'),
        out(25000, 'B'),
        out(13000, 'C'),
        rec({ t: 15000, key: 'od', service: 'onedrive', url: DRIVE_URL, kind: 'download' }),
        rec({ t: 31500, key: 'A', total: 500 }),
      ];
      const run = run_json({
        first_request_at_ms: 1000,
        outages: [
          { service: 'outlook', start_ms: 10000, duration_ms: 20000, fault: 'unavailable_503' },
        ],
      });
      const { model, md } = await report_for(ws, 'outage', { run, lines });
      const w = model.outages[0];
      assert.deepEqual(
        [w.requests, w.outage_faulted, w.distinct_urls, w.attempts_per_url.max],
        [7, 7, 3, 4],
      );
      assert.deepEqual(
        [w.other_services.requests, w.first_attempt_after_ms, w.first_usable_after_ms],
        [1, 500, 1000],
      );
      assert.deepEqual([w.chains.recovered, w.chains.unrecovered, w.chains.not_retried], [1, 1, 1]);
      assert.equal(w.chains.recovered_after_end_ms.max, 500);
      assert.ok(model.timeline.buckets.some((b) => b.outages.includes('outlook')));
      assert.match(md, /## Outage windows/);
    },
  ],
  [
    'an outage window is inferred from the journal when run.json lacks it',
    async (ws) => {
      const out = (t) =>
        rec({
          t,
          key: 'z',
          fault: { id: 'no_response', source: 'outage', params: {} },
          status: null,
          outcome: 'no_response',
          total: 100,
        });
      const { model } = await report_for(ws, 'inferred-outage', {
        run: null,
        lines: [out(5000), out(9000)],
      });
      assert.equal(model.outages[0].source, 'inferred from journal');
      assert.equal(model.outages[0].requests, 2);
    },
  ],
  [
    'url_key without identity groups retries, ids stay templated',
    async (ws) => {
      const { md } = await report_for(ws, 'templated', { lines: [ok(0, 'q', { url: MAIL_URL })] });
      assert.ok(md.includes('users/{upn}/messages/{id}'));
      assert.ok(!md.includes('user@example.com'));
    },
  ],
];
