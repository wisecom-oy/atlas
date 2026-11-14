/**
 * Self-check cases for paged listings with page-aware identities: `identity_key` includes the
 * page ordinal and `base_key` names the listing, as the engine writes them since its fix round.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { write_compare } from '../write-compare.mjs';
import {
  DELTA_URL,
  rec,
  report_for,
  verdict,
  write_run_dir,
} from './report-selfcheck-fixtures.mjs';

/** A page of the `inbox` listing: page 1 is the initial delta request, later pages carry a skip token. */
function page(t, n, extra = {}) {
  return rec({
    t,
    key: `u-${n}-${extra.key_suffix ?? ''}`,
    identity: `inbox#${n}`,
    base_key: 'inbox',
    page: n,
    url: DELTA_URL,
    kind: 'delta',
    cursor: n === 1 ? 'delta' : 'skip',
    ...extra,
  });
}

/** Paging checks as `[name, async (workspace) => void]`. */
export const paging_checks = [
  [
    'verdict 5 sees a restart through base_key, unprompted or demanded',
    async (ws) => {
      const faulted = page(100, 2, { fault: 'server_500', status: 500 });
      const restart = page(600, 1, { cursor: null, key_suffix: 'again' });
      const warn = await report_for(ws, 'base-restart', { lines: [page(0, 1), faulted, restart] });
      assert.equal(verdict(warn.model, 5).verdict, 'WARN');
      assert.equal(verdict(warn.model, 5).evidence.restart_undemanded, 1);
      assert.match(verdict(warn.model, 5).examples[0], /\(page 2\)$/);
      // The restart re-reads page 1 once, even though that re-read needed retries itself.
      const retried_restart = [
        page(0, 1),
        faulted,
        page(600, 1, { cursor: null, key_suffix: 'r', fault: 'throttle_503', status: 503 }),
        page(900, 1, { cursor: null, key_suffix: 'r' }),
      ];
      const again = await report_for(ws, 'base-restart-retried', { lines: retried_restart });
      assert.equal(verdict(again.model, 4).evidence.delta_refetches, 1);
      const resync = page(100, 2, {
        fault: 'delta_resync_410',
        status: 410,
        graph_error: 'resyncRequired',
      });
      const pass = await report_for(ws, 'base-restart-demanded', {
        lines: [page(0, 1), resync, restart],
      });
      assert.equal(verdict(pass.model, 5).verdict, 'PASS');
      assert.equal(verdict(pass.model, 5).evidence.restart_demanded, 1);
    },
  ],
  [
    'verdict 7: a failed page 2 is not satisfied by a successful page 3',
    async (ws) => {
      const failed = (t) => page(t, 2, { fault: 'unavailable_503', status: 503 });
      const { model } = await report_for(ws, 'page-unsatisfied', {
        lines: [page(0, 1), failed(100), failed(400), page(900, 3)],
      });
      const v = verdict(model, 7);
      assert.equal(v.verdict, 'FAIL');
      assert.equal(v.evidence.never_satisfied, 1);
      assert.match(v.examples[0], /\(page 2\)$/);
    },
  ],
  [
    'compare reports a page the faulted run never fetched',
    async (ws) => {
      const baseline = await write_run_dir(ws, 'pages-baseline', {
        lines: [page(0, 1), page(100, 2), page(200, 3)],
      });
      const faulted = await write_run_dir(ws, 'pages-run', { lines: [page(0, 1), page(100, 3)] });
      const { terminal_summary } = await write_compare(baseline, faulted);
      const json = JSON.parse(await readFile(join(faulted, 'compare.json'), 'utf8'));
      assert.deepEqual([json.lost.total, json.lost.never_requested], [1, 1]);
      assert.deepEqual(json.lost.by_shape[0].pages, [2]);
      assert.match(terminal_summary, /pages 2/);
    },
  ],
];
