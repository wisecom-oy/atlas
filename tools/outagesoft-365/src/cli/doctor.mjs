/**
 * `outagesoft-365 doctor`: checks the runtime can do what `run` relies on.
 */
import { probe_reroutes } from './reroute-probe.mjs';

const MIN_NODE = [22, 22, 2];

/** True when this Node is at least MIN_NODE. */
function node_supported() {
  const parts = process.versions.node.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== MIN_NODE[i]) return parts[i] > MIN_NODE[i];
  }
  return true;
}

/** Checks, in this process, that fetch's global dispatcher appears and can be composed. */
function dispatcher_composable() {
  try {
    fetch('data:,warm').catch(() => {});
  } catch {
    /* checked below */
  }
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  return Boolean(dispatcher) && typeof dispatcher.compose === 'function';
}

/** Prints the doctor report; resolves 0 when everything `run` needs works, 1 otherwise. */
export async function run_doctor() {
  const lines = [];
  let ok = true;
  const check = (label, passed, text) => {
    ok &&= passed;
    lines.push(`${label.padEnd(18)}${text}${passed ? '' : '  (PROBLEM)'}`);
  };
  check('node', node_supported(), `${process.version} (needs >= v${MIN_NODE.join('.')})`);
  lines.push(`${'undici'.padEnd(18)}${process.versions.undici ?? 'unknown'} (bundled with node)`);
  check(
    'fetch dispatcher',
    dispatcher_composable(),
    dispatcher_composable() ? 'global dispatcher composable' : 'no composable global dispatcher',
  );
  const probe = await probe_reroutes();
  check(
    'fetch re-route',
    probe.fetch_ok,
    probe.fetch_ok
      ? 'works; response.url unchanged'
      : `failed ${JSON.stringify(probe.detail.output)}`,
  );
  check(
    'node:https',
    probe.https_ok,
    probe.https_ok ? 'identity re-route works' : `failed ${JSON.stringify(probe.detail.output)}`,
  );
  if (probe.detail.warnings) lines.push(`${'preload said'.padEnd(18)}${probe.detail.warnings}`);
  lines.push(
    `${'TLS'.padEnd(18)}${process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set; Atlas will refuse to start' : 'default validation (the relay never changes it)'}`,
  );
  console.log(lines.join('\n'));
  return ok ? 0 : 1;
}
