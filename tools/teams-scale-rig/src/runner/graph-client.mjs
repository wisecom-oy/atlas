/**
 * Graph SDK client for the rig. Mirrors the chain in packages/m365-graph graph-client.factory.ts
 * (Authentication, Redirect, Telemetry, HTTP) with one addition: an origin rewrite that sends
 * `https://graph.microsoft.com` requests to the fake server. GraphCostMiddleware is not exported
 * by m365-graph and only does accounting, so it is omitted.
 */
import {
  AuthenticationHandler,
  Client,
  HTTPMessageHandler,
  RedirectHandler,
  RedirectHandlerOptions,
  TelemetryHandler,
} from '@microsoft/microsoft-graph-client';
import { GRAPH_BASE } from '../server/paging.mjs';

const GRAPH_ORIGIN = new URL(GRAPH_BASE).origin;

/** Rewrites the Graph origin of string URLs to the fake server origin. */
class OriginRewriteHandler {
  /** @param {string} target_origin e.g. http://127.0.0.1:4010 */
  constructor(target_origin) {
    this.target_origin = target_origin;
  }

  setNext(next) {
    this.next = next;
  }

  async execute(context) {
    if (typeof context.request !== 'string' || !context.request.startsWith(GRAPH_ORIGIN)) {
      throw new Error(`rig graph client: unexpected request target ${String(context.request)}`);
    }
    context.request = this.target_origin + context.request.slice(GRAPH_ORIGIN.length);
    await this.next.execute(context);
  }
}

/**
 * @param {{target_origin: string}} options fake server origin
 * @returns {Client} Graph client whose requests land on the fake server
 */
export function create_rig_graph_client({ target_origin }) {
  const auth_provider = { getAccessToken: async () => 'rig-token' };
  const chain = [
    new AuthenticationHandler(auth_provider),
    new RedirectHandler(new RedirectHandlerOptions()),
    new OriginRewriteHandler(target_origin),
    new TelemetryHandler(),
    new HTTPMessageHandler(),
  ];
  for (let i = 0; i < chain.length - 1; i++) chain[i].setNext(chain[i + 1]);
  // The SDK adds the API version itself, as in production, so the base is the bare origin.
  return Client.initWithMiddleware({ middleware: chain[0], baseUrl: GRAPH_ORIGIN });
}
