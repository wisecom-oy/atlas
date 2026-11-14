/**
 * outagesoft-365 preload: re-routes this process's Microsoft 365 traffic to
 * the run's local relay. Loaded with `node --import` through NODE_OPTIONS, so
 * it reaches every node process the command starts (pnpm, workers, the CLI).
 *
 * Global `fetch` is undici, and on Node 22 its global dispatcher sits behind
 * `Symbol.for('undici.globalDispatcher.1')`. It does not exist until fetch is
 * first used (reading `globalThis.fetch` is not enough), so one throwaway
 * `data:` fetch creates it. The dispatcher is then replaced by a composed one
 * that rewrites matching requests' origin to the relay and prefixes the path
 * with the run token and the original origin. Headers are untouched, the
 * client's `response.url` still reports the real URL, and redirects are
 * re-dispatched through the composed dispatcher, so they are re-routed too.
 *
 * This file runs inside someone else's process. It must never throw: any
 * setup failure prints one warning and leaves traffic going direct. The parent
 * `run` notices, because a relay that saw no requests says so in the report.
 * Even its own modules are imported dynamically inside a try, so a broken
 * install of this tool cannot stop the host process from starting.
 */
let is_m365_host;
let encode_relay_path;
let install_node_https_reroute;

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const INSTALLED = Symbol.for('outagesoft-365.preload.installed');

/** Prints one warning about a re-route that could not be installed. */
function warn(what) {
  try {
    process.stderr.write(
      `[outagesoft-365] ${what}; this process talks to Microsoft 365 directly\n`,
    );
  } catch {
    /* nothing else can be done from inside a preload */
  }
}

/** Returns the relay-bound dispatch options for an allowlisted https origin, or the options unchanged. */
function reroute(opts, relay_origin, token) {
  try {
    const target = new URL(String(opts.origin));
    if (target.protocol !== 'https:' || !is_m365_host(target.hostname)) return opts;
    return {
      ...opts,
      origin: relay_origin,
      path: encode_relay_path(token, target.origin, opts.path),
    };
  } catch {
    return opts;
  }
}

/** Replaces undici's global dispatcher with one that re-routes Microsoft 365 origins. */
function install_fetch_reroute(relay_origin, token) {
  try {
    fetch('data:,warm').catch(() => {});
  } catch {
    /* a fetch that throws synchronously still may have created the dispatcher */
  }
  const dispatcher = globalThis[DISPATCHER];
  if (!dispatcher || typeof dispatcher.compose !== 'function') {
    warn('fetch re-route unavailable (no composable undici global dispatcher)');
    return;
  }
  globalThis[DISPATCHER] = dispatcher.compose(
    (dispatch) => (opts, handler) => dispatch(reroute(opts, relay_origin, token), handler),
  );
}

/** Loads the modules the re-routes need; false (after a warning) if any fails to load. */
async function load_dependencies() {
  try {
    ({ is_m365_host } = await import('./m365-hosts.mjs'));
    ({ encode_relay_path } = await import('./relay-route.mjs'));
    ({ install_node_https_reroute } = await import('./preload-node-https.mjs'));
    return true;
  } catch (error) {
    warn(`preload modules failed to load (${error?.name ?? 'error'})`);
    return false;
  }
}

/** Installs both re-routes when OUTAGESOFT_RELAY and OUTAGESOFT_TOKEN are set; otherwise does nothing. */
async function install() {
  const relay = process.env.OUTAGESOFT_RELAY;
  const token = process.env.OUTAGESOFT_TOKEN;
  if (!relay || !token || globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  if (!(await load_dependencies())) return;
  let relay_url;
  try {
    relay_url = new URL(relay);
  } catch {
    warn('OUTAGESOFT_RELAY is not a URL');
    return;
  }
  try {
    install_fetch_reroute(relay_url.origin, token);
  } catch (error) {
    warn(`fetch re-route failed (${error?.name ?? 'error'})`);
  }
  try {
    install_node_https_reroute(relay_url, token);
  } catch (error) {
    warn(`node:https re-route failed (${error?.name ?? 'error'})`);
  }
}

await install().catch(() => {});
