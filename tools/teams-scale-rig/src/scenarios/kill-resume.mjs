/**
 * Kill-resume: SIGKILLs a backup child once a quarter of the hosted images are downloaded, reruns
 * it on the same store, and checks the resumed run against the store at the kill. A blob the store
 * held at the kill must not be downloaded again. Every blob the converged snapshot references must
 * be stored at the kill or downloaded on resume. The converged snapshot must equal a control run on
 * a fresh store.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENANT_ID, expected_hosted_downloads } from '../fixture/generate-tenant.mjs';
import { tenant_store_dir } from '../runner/rig-session.mjs';
import { expire_dead_team_leases } from '../runner/dead-owner-leases.mjs';
import {
  diff_snapshots,
  list_hosted_blob_keys,
  resume_blob_problems,
} from '../runner/convergence.mjs';
import {
  build_tenant,
  check,
  fresh_dir,
  race_unrouted,
  read_store_snapshot,
  start_server,
} from './shared.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kill-resume-child.mjs');
const KILL_FRACTION = 0.25;

/**
 * @param {{args: object, store: string, passphrase: string}} run
 * @returns {Promise<{runs: object[], checks: object[]}>}
 */
export async function run_kill_resume({ args, store, passphrase }) {
  const tenant = build_tenant(args);
  const team_ids = tenant.teams.map((t) => t.id);
  const expected = expected_hosted_downloads(tenant);
  const server = await start_server(tenant, args.time_scale);
  const config = {
    url: server.url,
    time_scale: args.time_scale,
    concurrency: args.concurrency,
    parallel_teams: args.parallel_teams,
    team_ids,
  };
  try {
    const resume_dir = fresh_dir(store, 'kill-resume');
    const kill_at = Math.max(1, Math.floor(expected * KILL_FRACTION));
    server.stats.reset();
    const killed = await run_child_until_kill(
      server,
      { ...config, store_root: resume_dir },
      kill_at,
    );
    const keys_at_kill = new Set(
      await list_hosted_blob_keys(tenant_store_dir(resume_dir, TENANT_ID)),
    );
    // The killed child could not release its lease. Expire it as the TTL would, so the resume
    // takes it over (see dead-owner-leases.mjs) instead of waiting five minutes for it to run out.
    const dead_leases = await expire_dead_team_leases(tenant_store_dir(resume_dir, TENANT_ID));

    server.stats.reset();
    const resumed = await run_child(server, { ...config, store_root: resume_dir });
    const resume_stats = server.stats.snapshot();

    const control_dir = fresh_dir(store, 'kill-resume-control');
    server.stats.reset();
    const control = await run_child(server, { ...config, store_root: control_dir });
    const control_downloads = server.stats.snapshot().hosted_downloads;

    const resumed_read = await read_store_snapshot(args, server, resume_dir, passphrase, team_ids);
    const control_read = await read_store_snapshot(args, server, control_dir, passphrase, team_ids);
    const problems = diff_snapshots(control_read.teams, resumed_read.teams);
    const blobs = resume_blob_problems({
      keys_at_kill,
      served_ids: resume_stats.hosted_ids,
      hosted_keys: resumed_read.hosted_keys,
    });
    const unread = team_ids.filter((id) => !control_read.teams[id] || !resumed_read.teams[id]);

    return {
      runs: [
        {
          name: 'killed child',
          wall_ms: killed.wall_ms,
          blobs_at_kill: keys_at_kill.size,
          kill_at,
        },
        {
          name: 'resumed child',
          wall_ms: resumed.wall_ms,
          hosted_downloads: resume_stats.hosted_downloads,
        },
        { name: 'control run', wall_ms: control.wall_ms, hosted_downloads: control_downloads },
      ],
      checks: [
        check(
          'child was killed before completing',
          killed.exit_code === null,
          `exit ${killed.exit_code}`,
        ),
        check(
          'killed child left a live lease for the resume to take over',
          dead_leases.length > 0,
          `${dead_leases.length} team lease(s) expired`,
        ),
        check(
          'control run downloads every reachable hosted image',
          control_downloads === expected,
          `${control_downloads} of ${expected}`,
        ),
        check(
          'every team has a readable snapshot on both stores',
          unread.length === 0,
          unread.length ? unread.join(', ') : 'all teams',
        ),
        check(
          'resume downloads no blob stored at the kill',
          blobs.reused.length === 0,
          `${blobs.reused.length} stored blobs downloaded again; ${resume_stats.hosted_downloads} downloaded on resume, ${keys_at_kill.size} stored at kill`,
        ),
        check(
          'every blob in the snapshot is stored at the kill or downloaded on resume',
          blobs.unaccounted.length === 0,
          `${blobs.unaccounted.length} blobs unaccounted for`,
        ),
        check(
          'every resumed download is referenced by the snapshot',
          blobs.unmapped.length === 0,
          `${blobs.unmapped.length} downloads with no referencing snapshot`,
        ),
        check(
          'resumed snapshot equals control snapshot',
          problems.length === 0,
          problems.join('; ') || 'converged',
        ),
      ],
    };
  } finally {
    await server.close();
  }
}

/**
 * Starts a child and SIGKILLs it once the server has served `kill_at` hosted downloads.
 * @returns {Promise<{exit_code: number|null, wall_ms: number}>}
 */
function run_child_until_kill(server, config, kill_at) {
  const child = spawn_child(config);
  const started = Date.now();
  const work = new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (server.stats.snapshot().hosted_downloads >= kill_at) child.kill('SIGKILL');
    }, 50);
    child.on('error', (err) => {
      clearInterval(poll);
      reject(err);
    });
    child.on('exit', (code) => {
      clearInterval(poll);
      if (code === 0)
        reject(new Error('child finished before the kill point; increase the fixture size'));
      else resolve({ exit_code: code, wall_ms: Date.now() - started });
    });
  });
  return fail_fast(server, child, work);
}

/**
 * Runs a child to completion and returns its result line.
 * @returns {Promise<{wall_ms: number, channels: number, hosted_downloads: number}>}
 */
function run_child(server, config) {
  const child = spawn_child(config, 'pipe');
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const work = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child exited with ${code}`));
      const line = stdout.trim().split('\n').pop();
      resolve(JSON.parse(line));
    });
  });
  return fail_fast(server, child, work);
}

/** Races a child's run against the server's no-route signal, killing the child on failure. */
function fail_fast(server, child, work) {
  return race_unrouted(server, work).catch((err) => {
    child.kill('SIGKILL');
    throw err;
  });
}

function spawn_child(config, stdio = 'ignore') {
  return spawn(process.execPath, [CHILD, JSON.stringify(config)], {
    stdio: ['ignore', stdio, 'inherit'],
    env: process.env,
  });
}
