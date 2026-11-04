/**
 * Sync: a first run on an empty store, an unchanged rerun on the same store, then a mutated run
 * after new replies (with images), an edit, and a deletion. The first run downloads every reachable
 * hosted image once. The unchanged rerun downloads none and reads each channel with one delta
 * request. The mutated run reads its changes through delta, downloads only the new images, and
 * live content converges with a fresh backup of the mutated tenant. Deleted roots are compared
 * for being deleted, not for their deletion time or replies (see live-content-diff.mjs).
 */
import { expected_hosted_downloads } from '../fixture/generate-tenant.mjs';
import { mutate_for_sync } from '../fixture/mutate-tenant.mjs';
import { diff_live_content } from '../runner/live-content-diff.mjs';
import { open_session } from '../runner/rig-session.mjs';
import {
  build_tenant,
  check,
  fresh_dir,
  measured_run,
  read_store_snapshot,
  start_server,
} from './shared.mjs';

/** Requests served under one route name during a measured run. */
function route_count(run, name) {
  return run.server.routes.get(name) ?? 0;
}

/**
 * @param {{args: object, store: string, passphrase: string}} run
 * @returns {Promise<{runs: object[], checks: object[]}>}
 */
export async function run_sync({ args, store, passphrase }) {
  const tenant = build_tenant(args);
  const team_ids = tenant.teams.map((t) => t.id);
  const server = await start_server(tenant, args.time_scale);
  try {
    const options = { concurrency: args.concurrency };
    const run_pass = (container) =>
      measured_run({
        container,
        server,
        team_ids,
        options,
        time_scale: args.time_scale,
        parallel_teams: args.parallel_teams,
      });
    const dir = fresh_dir(store, 'sync');
    const { container } = open_session({
      url: server.url,
      store_root: dir,
      passphrase,
      time_scale: args.time_scale,
    });
    const first = await run_pass(container);
    const unchanged = await run_pass(container);
    const expected = expected_hosted_downloads(tenant);
    const mutation = mutate_for_sync(tenant);
    const mutated = await run_pass(container);

    const control_dir = fresh_dir(store, 'sync-control');
    const control_session = open_session({
      url: server.url,
      store_root: control_dir,
      passphrase,
      time_scale: args.time_scale,
    });
    const control = await run_pass(control_session.container);

    const mutated_read = await read_store_snapshot(args, server, dir, passphrase, team_ids);
    const control_read = await read_store_snapshot(args, server, control_dir, passphrase, team_ids);
    const problems = diff_live_content(control_read.teams, mutated_read.teams);
    const delta_requests = route_count(unchanged, 'messages_delta');
    return {
      runs: [
        { name: 'first sync', ...first },
        { name: 'unchanged rerun', ...unchanged },
        { name: 'mutated rerun', ...mutated },
        { name: 'control (fresh store, mutated tenant)', ...control },
      ],
      checks: [
        check(
          'first sync downloads every reachable hosted image',
          first.server.hosted_downloads === expected,
          `${first.server.hosted_downloads} of ${expected}`,
        ),
        check(
          'unchanged rerun downloads no hosted image',
          unchanged.server.hosted_downloads === 0,
          `${unchanged.server.hosted_downloads} downloaded`,
        ),
        check(
          'unchanged rerun reports the same channel count',
          unchanged.channels === first.channels,
          `${unchanged.channels} vs ${first.channels} channels`,
        ),
        check(
          'unchanged rerun reads each channel with one delta request',
          delta_requests === unchanged.channels &&
            route_count(unchanged, 'list_messages') === 0 &&
            unchanged.server.classes.messages.attempts === unchanged.channels,
          `${delta_requests} delta, ${unchanged.server.classes.messages.attempts} messages requests, ${unchanged.channels} channels`,
        ),
        check(
          'mutated run downloads exactly the new hosted images',
          mutated.server.hosted_downloads === mutation.new_images,
          `${mutated.server.hosted_downloads} of ${mutation.new_images} (${mutation.replies} replies, ${mutation.edits} edit, ${mutation.deletions} deletion applied)`,
        ),
        check(
          'mutated run reads its changes through delta, with no full listing',
          route_count(mutated, 'messages_delta') >= mutated.channels &&
            route_count(mutated, 'list_messages') === 0,
          `${route_count(mutated, 'messages_delta')} delta requests, ${route_count(mutated, 'list_messages')} listings, ${mutated.channels} channels`,
        ),
        check(
          'live content converges with control (fresh backup of the mutated tenant)',
          problems.length === 0,
          problems.join('; ') || 'converged',
        ),
      ],
    };
  } finally {
    await server.close();
  }
}
