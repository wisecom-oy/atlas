/**
 * Counts Graph API cost where the requests actually happen: the transport.
 *
 * Recording at the connector-method boundary counted one request per method,
 * but a method routinely issues many: a delta sync follows `@odata.nextLink`
 * until the collection is exhausted, and a throttled call is retried by
 * `with_graph_retry` (up to 12 attempts), which this layer is the only place
 * able to see. Reported cost was therefore a floor, and consumers computing a
 * throttling cooldown from it got a number that was always too small, the
 * unsafe direction.
 *
 * Placed immediately before HTTPMessageHandler, this middleware is invoked once
 * per outgoing HTTP request, including every retry and every followed redirect,
 * because RedirectHandler re-executes the chain downstream of itself and the
 * retry wrapper re-enters the client entirely.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits
 */

import type { Context, Middleware } from '@microsoft/microsoft-graph-client';
import type { GraphServicePool } from '@wisecom/atlas-types';
import {
  get_active_counter,
  get_active_operation,
} from '@wisecom/atlas-core/services/shared/graph-request-context';

/** Records one Graph request against the active cost counter, then continues the chain. */
export class GraphCostMiddleware implements Middleware {
  private _next?: Middleware;

  async execute(context: Context): Promise<void> {
    // Recorded before the call: a request that leaves the process has already
    // been charged against the tenant's quota, whatever the response turns out
    // to be. Nothing is recorded when no SDK cost context is active (CLI runs).
    const counter = get_active_counter();
    if (counter) {
      const operation = get_active_operation();
      const url = request_url(context);
      counter.record(
        operation?.pool ?? pool_for_url(url),
        operation?.request_type ?? 'unlabelled',
        {
          resource_units: operation?.resource_units ?? 1,
          upload_bytes: request_body_bytes(context),
        },
      );
    }

    await this._next?.execute(context);
  }

  setNext(next: Middleware): void {
    this._next = next;
  }
}

/** Reads the target URL from a context whose request may be a string or a Request. */
function request_url(context: Context): string {
  return typeof context.request === 'string' ? context.request : context.request.url;
}

/**
 * Best-effort pool for a request made outside any declared operation.
 *
 * Every Graph call Atlas makes today runs inside a declared operation, so this
 * is a backstop for future callers rather than a routine path. Unrecognised
 * paths fall to `identity`: the request is real and must appear in the totals,
 * and the directory pool is where uncategorised Graph endpoints live.
 */
function pool_for_url(url: string): GraphServicePool {
  const path = url.replace(/^https?:\/\/[^/]+/, '').toLowerCase();
  if (/\/(drives?|sites|shares)\b/.test(path)) return 'sharepoint_onedrive';
  if (/\/(messages|mailfolders|mailboxsettings|sendmail|events|calendars?)\b/.test(path)) {
    return 'outlook';
  }
  return 'identity';
}

/**
 * Size of the request body in bytes, for the Outlook upload window. Streams and
 * form data report 0 -- their length is not knowable without consuming them,
 * and consuming them here would break the request.
 */
function request_body_bytes(context: Context): number {
  const body =
    typeof context.request === 'string' ? context.options?.body : (context.options?.body ?? null);
  if (!body) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}
