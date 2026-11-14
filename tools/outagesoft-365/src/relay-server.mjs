/**
 * The relay: a plain HTTP server on 127.0.0.1 that receives re-routed
 * Microsoft 365 requests, decides a fault for each, executes it, and journals
 * the exchange.
 *
 * Security boundaries:
 *   - Listens on 127.0.0.1 only, on an ephemeral port.
 *   - The first path segment must be the per-run token (compared in constant
 *     time); anything else gets 404 and is never forwarded.
 *   - Only https origins on the Microsoft 365 allowlist are accepted, so the
 *     relay cannot be used to reach an arbitrary host.
 *
 * Robustness: a bug while planning, executing or journaling an exchange turns
 * into a journaled `relay_error` and a 502 `outagesoftRelayError` (or a
 * dropped connection once headers are out), never a hung socket or a crashed
 * relay, because the relay runs in the same process that must still write the
 * journal and report after the child exits.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { format_exchange_line } from './exchange-line.mjs';
import { create_exchange, drop_connection, read_request_body, send_response } from './exchange.mjs';
import { FAULT_IDS } from './fault-catalog.mjs';
import { execute_exchange } from './fault-executor.mjs';
import { plan_fault } from './fault-planner.mjs';
import { create_reorder_gate } from './faults/response-reorder.mjs';
import { build_journal_entry } from './journal.mjs';
import { is_m365_host } from './m365-hosts.mjs';
import { decode_relay_path } from './relay-route.mjs';
import { attempt_key } from './replay-schedule.mjs';
import { create_identity_ordinals } from './identity-ordinals.mjs';
import { assign_identity, describe_request, should_preread_body } from './request-facts.mjs';
import { request_rng } from './seeded-random.mjs';
import { create_upstream_agents, FORCE_HEADER } from './upstream-forwarder.mjs';

/** Longest the relay waits at shutdown for in-flight exchanges to journal themselves. */
const SHUTDOWN_GRACE_MS = 2000;

/** A data-free description of an internal error: its name and code, never request content. */
export function describe_error(error) {
  const name = error?.name ?? 'Error';
  const code = error?.code ? ` ${error.code}` : '';
  // The first stack frame locates the bug; directories are dropped because they carry a username.
  const where =
    String(error?.stack ?? '')
      .split('\n')[1]
      ?.trim()
      .replace(/\S*[\\/]/g, '') ?? '';
  return `${name}${code}${where ? ` ${where}` : ''}`.slice(0, 200);
}

/** Constant-time comparison of the presented token with the run token. */
function token_matches(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers a request the relay refuses to handle, and notes it in the journal. */
function refuse(res, status, journal, note) {
  journal.write_relay_error(note);
  res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
  res.end(status === 404 ? 'Not Found' : 'Forbidden');
}

/** Starts the relay. Resolves with { url, stats, replay_stats(), close() } once listening. */
export async function start_relay(config) {
  const {
    token,
    identity_secret,
    seed,
    plan,
    journal,
    upstream_base,
    quiet,
    allow_force,
    replay_source,
  } = config;
  const started = performance.now();
  const ordinals = create_identity_ordinals();
  const stats = { relayed: 0, rejected: 0, relay_errors: 0, first_request_at_ms: null };
  const replay = { applied: new Set(), encountered: new Set(), unscheduled_requests: 0 };
  const deps = {
    agents: create_upstream_agents(),
    upstream_base,
    reorder_gate: create_reorder_gate(),
  };
  let open_exchanges = 0;
  let drained = () => {};

  /** Journals a finished exchange and prints its line; never throws. */
  function on_exchange_finished(ex) {
    open_exchanges -= 1;
    try {
      // The client left while its body was being pre-read: identify it without the body.
      if (!ex.identity_key) assign_identity(ex, identity_secret, ordinals);
      if (
        !ex.graph_error &&
        ex.delivered.status >= 400 &&
        ex.delivered.status === ex.upstream?.status
      ) {
        ex.graph_error = ex.upstream_error_code;
      }
      journal.write_entry(build_journal_entry(ex));
      if (replay_source) {
        const key = attempt_key(ex.identity_key, ex.occurrence);
        if (!replay_source.seen.has(key)) replay.unscheduled_requests += 1;
        if (replay_source.schedule.has(key)) replay.encountered.add(key);
        if (ex.fault?.source === 'replay' && !ex.fault.skipped) replay.applied.add(key);
      }
      if (ex.delivered.outcome === 'complete') deps.reorder_gate.note_delivered();
      if (!quiet) process.stderr.write(`${format_exchange_line(ex)}\n`);
    } catch (error) {
      stats.relay_errors += 1;
      journal.write_relay_error(`journaling failed: ${describe_error(error)}`);
    }
    if (open_exchanges === 0) drained();
  }

  /** Plans the fault for an exchange from its facts. */
  function decide(ex, req) {
    const forced = allow_force ? req.headers[FORCE_HEADER] : undefined;
    return plan_fault({
      request: { service: ex.service, kind: ex.kind, method: ex.method },
      elapsed_ms: ex.t - stats.first_request_at_ms,
      plan,
      rng: request_rng(seed, ex.identity_key, ex.occurrence),
      forced_id: FAULT_IDS.includes(forced) ? forced : undefined,
      replay_entry: replay_source?.schedule.get(attempt_key(ex.identity_key, ex.occurrence)),
    });
  }

  /** Turns an internal failure into a journaled relay_error and a 502 (or a drop). */
  function fail_exchange(ex, error) {
    stats.relay_errors += 1;
    ex.relay_error = describe_error(error);
    if (ex.client_gone) return;
    if (ex.res.headersSent)
      return drop_connection(
        ex,
        'relay_error',
        'close',
        'socket destroyed by relay after a relay error',
      );
    ex.forced_outcome = 'relay_error';
    const body = JSON.stringify({
      error: { code: 'outagesoftRelayError', message: 'outagesoft-365 relay error' },
    });
    send_response(ex, 502, { 'content-type': 'application/json' }, body);
  }

  async function handle(req, res) {
    // Errors on either stream surface through the exchange's close handling; unhandled they would crash.
    req.on('error', () => {});
    res.on('error', () => {});
    const route = decode_relay_path(req.url);
    if (!route || !token_matches(route.token, token)) {
      stats.rejected += 1;
      return refuse(res, 404, journal, 'rejected a request without the run token');
    }
    const target = new URL(route.origin);
    if (target.protocol !== 'https:' || !is_m365_host(target.hostname)) {
      stats.rejected += 1;
      return refuse(
        res,
        403,
        journal,
        'rejected a request for a host outside the Microsoft 365 allowlist',
      );
    }
    const t = Math.round(performance.now() - started);
    stats.first_request_at_ms ??= t;
    stats.relayed += 1;
    const facts = describe_request({
      route,
      req,
      identity_secret,
      ordinals,
      seq: stats.relayed,
      t,
    });
    const ex = create_exchange(req, res, facts, on_exchange_finished);
    open_exchanges += 1;
    try {
      // A small JSON body is part of the identity, so it is read before planning.
      if (should_preread_body(ex) && !(await read_request_body(ex))) return;
      assign_identity(ex, identity_secret, ordinals);
      ex.fault = decide(ex, req);
      await execute_exchange(ex, deps);
    } catch (error) {
      fail_exchange(ex, error);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      // Only reachable when the request failed before it became an exchange.
      stats.relay_errors += 1;
      journal.write_relay_error(`request setup failed: ${describe_error(error)}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'outagesoftRelayError', message: 'outagesoft-365 relay error' },
        }),
      );
    });
  });
  // Uploads may legitimately take longer than Node's default 5 minute request timeout.
  server.requestTimeout = 0;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    /** Divergence counters for a replay run, or null for a fresh run. */
    replay_stats: () =>
      replay_source
        ? {
            of: replay_source.name,
            scheduled: replay_source.schedule.size,
            applied: replay.applied.size,
            not_encountered: replay_source.schedule.size - replay.encountered.size,
            unscheduled_requests: replay.unscheduled_requests,
          }
        : null,
    /** Stops listening, drops every connection (held ones included) and waits for journaling. */
    async close() {
      server.close();
      server.closeAllConnections();
      deps.agents.destroy();
      if (open_exchanges > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          drained = () => (clearTimeout(timer), resolve());
        });
      }
    },
  };
}
