/**
 * Team-throttle isolation: team A is held to a fraction of its budget on the fake server while
 * team B backs up on the same container. B's wall time must stay close to its solo baseline.
 */
import { performance } from 'node:perf_hooks';
import { TENANT_ID } from '../fixture/generate-tenant.mjs';
import { open_session } from '../runner/rig-session.mjs';
import { backup_teams } from '../runner/backup-run.mjs';
import { start_process_sampler } from '../runner/process-sampler.mjs';
import {
  build_tenant,
  check,
  fresh_dir,
  measured_run,
  race_unrouted,
  start_server,
} from './shared.mjs';

const A_BUDGET_FRACTION = 0.5;
const SLOWDOWN_FACTOR = 1.5;
const SLOWDOWN_SLACK_MS = 2000;

/**
 * @param {{args: object, store: string, passphrase: string}} run
 * @returns {Promise<{runs: object[], checks: object[]}>}
 */
export async function run_throttle_isolation({ args, store, passphrase }) {
  const tenant = build_tenant(args);
  if (tenant.teams.length < 2)
    throw new Error('throttle-isolation needs at least 2 teams (--teams 2)');
  const [team_a, team_b] = tenant.teams.map((t) => t.id);
  const options = { concurrency: args.concurrency };
  const server = await start_server(tenant, args.time_scale);
  try {
    const alone = await measured_run({
      container: open_session({
        url: server.url,
        store_root: fresh_dir(store, 'throttle-solo'),
        passphrase,
        time_scale: args.time_scale,
      }).container,
      server,
      team_ids: [team_b],
      options,
      time_scale: args.time_scale,
    });

    server.limiter.set_team_rate(team_a, A_BUDGET_FRACTION * args.time_scale);
    const { container } = open_session({
      url: server.url,
      store_root: fresh_dir(store, 'throttle-concurrent'),
      passphrase,
      time_scale: args.time_scale,
    });
    server.stats.reset();
    const sampler = start_process_sampler();
    const started = performance.now();
    let b_wall_ms = 0;
    const timed_b = async () => {
      const t0 = performance.now();
      const results = await backup_teams({
        container,
        tenant_id: TENANT_ID,
        team_ids: [team_b],
        options,
      });
      b_wall_ms = performance.now() - t0;
      return results;
    };
    const [a_results, b_results] = await race_unrouted(
      server,
      Promise.all([
        backup_teams({ container, tenant_id: TENANT_ID, team_ids: [team_a], options }),
        timed_b(),
      ]),
    ).catch((err) => {
      sampler.stop();
      throw err;
    });
    const channels = [...a_results, ...b_results].reduce(
      (n, r) => n + r.summary.channels_scanned,
      0,
    );
    const concurrent_wall_ms = performance.now() - started;
    const server_stats = server.stats.snapshot();
    const a_throttled = server_stats.throttled_by_team.get(team_a) ?? 0;
    const allowed_ms = alone.wall_ms * SLOWDOWN_FACTOR + SLOWDOWN_SLACK_MS;

    return {
      runs: [
        { name: 'team B alone', ...alone },
        {
          name: 'team A throttled, team B concurrent',
          wall_ms: concurrent_wall_ms,
          server: server_stats,
          channels,
          mem: sampler.stop(),
          time_scale: args.time_scale,
        },
      ],
      b_wall_ms,
      checks: [
        check('team A was actually throttled', a_throttled > 0, `${a_throttled} 429 for team A`),
        check(
          'team B is not slowed beyond the isolation bound',
          b_wall_ms <= allowed_ms,
          `B ${(b_wall_ms / 1000).toFixed(1)} s vs allowed ${(allowed_ms / 1000).toFixed(1)} s (solo ${(alone.wall_ms / 1000).toFixed(1)} s)`,
        ),
      ],
    };
  } finally {
    await server.close();
  }
}
