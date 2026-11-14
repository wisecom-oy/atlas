/**
 * Re-routes Entra ID token traffic made with `node:https`.
 *
 * `@azure/identity` does not use fetch: its HTTP client
 * (`@typespec/ts-http-runtime` createNodeHttpClient) calls `https.request`.
 * This wraps `https.request` and `https.get` so a call for the identity host
 * is sent with `http.request` to the relay, path-prefixed exactly like the
 * fetch re-route. Every other host goes to the original function untouched.
 *
 * The caller's `agent` is dropped for re-routed calls (it is an https.Agent
 * and cannot carry plain HTTP), and so are TLS options, which mean nothing on
 * a loopback hop; the relay applies normal TLS validation upstream.
 * `syncBuiltinESMExports` makes named ESM imports (`import { request } from
 * 'node:https'`) see the wrapper, not only the default export object.
 */
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { is_identity_host } from '../request/m365-hosts.mjs';
import { encode_relay_path } from '../request/relay-route.mjs';

/** Request options carried over to the relay hop; everything TLS- or agent-related is left behind. */
const CARRIED_OPTIONS = [
  'method',
  'headers',
  'timeout',
  'signal',
  'maxHeaderSize',
  'joinDuplicateHeaders',
  'setHost',
];

/** Normalises the (url, options, cb), (options, cb) and (url, cb) signatures. */
function split_arguments(args) {
  const [first, second, third] = args;
  if (typeof first === 'string' || first instanceof URL) {
    const url = new URL(first);
    if (typeof second === 'function') return { url, options: {}, callback: second };
    return { url, options: second ?? {}, callback: third };
  }
  return { url: null, options: first ?? {}, callback: second };
}

/** Resolves hostname, port and path the way https.request would, options overriding the URL. */
function resolve_target({ url, options }) {
  const host_option =
    options.hostname ?? (options.host ? String(options.host).replace(/:\d+$/, '') : undefined);
  const hostname = String(host_option ?? url?.hostname ?? 'localhost').toLowerCase();
  const port = Number(options.port ?? (url?.port || 443));
  const path = options.path ?? (url ? `${url.pathname}${url.search}` : '/');
  return { hostname, port, path };
}

/** Builds the http.request options that send this call to the relay instead. */
function relay_options(call, target, relay_url, token) {
  const origin = `https://${target.hostname}${target.port === 443 ? '' : `:${target.port}`}`;
  const options = {};
  for (const name of CARRIED_OPTIONS)
    if (call.options[name] !== undefined) options[name] = call.options[name];
  return {
    ...options,
    method: options.method ?? 'GET',
    protocol: 'http:',
    hostname: relay_url.hostname,
    port: relay_url.port,
    path: encode_relay_path(token, origin, target.path),
  };
}

/** Wraps https.request and https.get so identity-host calls go to the relay. */
export function install_node_https_reroute(relay_url, token) {
  const original_request = https.request;

  function request(...args) {
    let rerouted;
    try {
      const call = split_arguments(args);
      const target = resolve_target(call);
      if (is_identity_host(target.hostname)) {
        rerouted = {
          options: relay_options(call, target, relay_url, token),
          callback: call.callback,
        };
      }
    } catch {
      rerouted = undefined; // anything unexpected goes out exactly as the caller asked
    }
    if (!rerouted) return original_request.apply(this, args);
    return http.request(rerouted.options, rerouted.callback);
  }

  function get(...args) {
    const req = request(...args);
    req.end();
    return req;
  }

  https.request = request;
  https.get = get;
  syncBuiltinESMExports();
}
