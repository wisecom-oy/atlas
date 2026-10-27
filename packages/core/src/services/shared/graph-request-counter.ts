/**
 * Lightweight per-operation Graph API request counter.
 *
 * Tracks requests by service pool and operation type within a single SDK
 * method call. No timers, no sliding windows — just a mutable accumulator
 * scoped via AsyncLocalStorage (see graph-request-context.ts).
 */

import type { GraphServicePool, OperationCost, ServicePoolCost } from '@wisecom/atlas-types';

interface PoolAccumulator {
  requests: number;
  resource_units: number;
  upload_bytes: number;
}

/** Records Graph API requests during a single SDK operation. */
export class GraphRequestCounter {
  private readonly _by_pool = new Map<GraphServicePool, PoolAccumulator>();
  private readonly _by_type: Record<string, number> = {};
  private readonly _started_at = Date.now();

  /**
   * Records Graph API requests.
   *
   * @param pool - The service pool the requests are charged against.
   * @param request_type - Stable label identifying the operation (e.g. `delta_sync`).
   * @param opts.requests - Requests Graph charges. Defaults to 1; a `$batch` charges one per
   *   sub-request.
   * @param opts.resource_units - RU cost of all of them. Defaults to `requests`.
   * @param opts.upload_bytes - Bytes sent in the request body.
   */
  record(
    pool: GraphServicePool,
    request_type: string,
    opts: { requests?: number; resource_units?: number; upload_bytes?: number } = {},
  ): void {
    const count = opts.requests ?? 1;
    const ru = opts.resource_units ?? count;
    const bytes = opts.upload_bytes ?? 0;

    const acc = this._by_pool.get(pool);
    if (acc) {
      acc.requests += count;
      acc.resource_units += ru;
      acc.upload_bytes += bytes;
    } else {
      this._by_pool.set(pool, { requests: count, resource_units: ru, upload_bytes: bytes });
    }

    this._by_type[request_type] = (this._by_type[request_type] ?? 0) + count;
  }

  /** Returns an immutable snapshot of the current counters as an OperationCost. */
  snapshot(): OperationCost {
    const by_service: Partial<Record<GraphServicePool, ServicePoolCost>> = {};
    let requests_total = 0;

    for (const [pool, acc] of this._by_pool) {
      by_service[pool] = {
        requests: acc.requests,
        resource_units: acc.resource_units,
        upload_bytes: acc.upload_bytes,
      };
      requests_total += acc.requests;
    }

    return {
      requests_total,
      by_service,
      requests_by_type: { ...this._by_type },
      elapsed_ms: Date.now() - this._started_at,
    };
  }
}
