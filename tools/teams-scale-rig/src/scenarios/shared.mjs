/**
 * Helpers shared by the scenarios: fixture and store setup, and a measured backup pass that
 * reports server-side counters, wall time, and process memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { generate_tenant, TENANT_ID } from '../fixture/generate-tenant.mjs';
import { start_fake_graph_server } from '../server/fake-graph-server.mjs';
import { backup_teams } from '../runner/backup-run.mjs';
import { start_process_sampler } from '../runner/process-sampler.mjs';
import { open_session } from '../runner/rig-session.mjs';
import { read_converged_snapshot } from '../runner/convergence.mjs';

/**
 * Opens a store read-only and reads the converged snapshot of every team.
 * @param {{time_scale: number}} args
 * @param {{url: string}} server running fake server
 * @returns {Promise<object>} canonical teams plus hosted keys, from read_converged_snapshot
 */
export function read_store_snapshot(args, server, store_dir, passphrase, team_ids) {
  const { container, tenant_factory } = open_session({
    url: server.url,
    store_root: store_dir,
    passphrase,
    time_scale: args.time_scale,
  });
  return read_converged_snapshot({ container, tenant_factory, tenant_id: TENANT_ID, team_ids });
}

/**
 * Generates the synthetic tenant for the given CLI options.
 * @param {{teams: number, channels_per_team: number, seed: number}} args
 */
export function build_tenant(args) {
  return generate_tenant({
    teams: args.teams,
    channels_per_team: args.channels_per_team,
    seed: args.seed,
  });
}

/** Creates an empty directory, removing anything left from an earlier run. */
export function fresh_dir(root, name) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Starts the fake Graph server for the tenant at the given time scale. */
export function start_server(tenant, time_scale) {
  return start_fake_graph_server({ tenant, time_scale });
}

/**
 * Rejects as soon as the server reports a request it has no route for, so a broken route fails
 * the run at once instead of leaving the backup waiting on 404s.
 * @template T
 * @param {{unrouted: Promise<never>}} server fake server from start_server
 * @param {Promise<T>} work the run to race
 * @returns {Promise<T>}
 */
export function race_unrouted(server, work) {
  return Promise.race([work, server.unrouted]);
}

/**
 * Runs one backup pass over `team_ids`, measuring wall time, server counters, and memory.
 * @returns {Promise<{wall_ms: number, server: object, channels: number, interrupted_teams: number, mem: object, time_scale: number}>}
 */
export async function measured_run({
  container,
  server,
  team_ids,
  options,
  time_scale,
  parallel_teams = 1,
}) {
  server.stats.reset();
  const sampler = start_process_sampler();
  const started = performance.now();
  let results;
  try {
    results = await race_unrouted(
      server,
      backup_teams({ container, tenant_id: TENANT_ID, team_ids, options, parallel_teams }),
    );
  } catch (err) {
    sampler.stop();
    throw err;
  }
  const wall_ms = performance.now() - started;
  return {
    wall_ms,
    server: server.stats.snapshot(),
    channels: results.reduce((sum, r) => sum + r.summary.channels_scanned, 0),
    interrupted_teams: results.filter((r) => r.interrupted).length,
    mem: sampler.stop(),
    time_scale,
  };
}

/** One named pass/fail check for the report. */
export function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}
