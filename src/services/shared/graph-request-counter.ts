/**
 * Lightweight per-operation Graph API request counter.
 *
 * Tracks requests by service pool and by operation type within a single SDK
 * method call. No timers, no sliding windows -- just a mutable accumulator
 * designed to be scoped via AsyncLocalStorage (see graph-request-context.ts).
 */

import type { GraphServicePool, OperationCost, ServicePoolCost } from '@/domain/graph-cost';

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
   * Records one Graph API request.
   *
   * @param pool - The service pool this request is charged against.
   * @param request_type - Stable label identifying the operation (e.g. `delta_sync`).
   * @param opts.resource_units - RU cost. Defaults to 1 (correct for Outlook flat model).
   *   Must be set explicitly for SharePoint/OneDrive (1-5 RU) and Identity (1-5 RU) calls.
   * @param opts.upload_bytes - Bytes sent in the request body (POST/PATCH/PUT).
   *   Relevant for Outlook upload window tracking.
   */
  record(
    pool: GraphServicePool,
    request_type: string,
    opts: { resource_units?: number; upload_bytes?: number } = {},
  ): void {
    const ru = opts.resource_units ?? 1;
    const bytes = opts.upload_bytes ?? 0;

    const acc = this._by_pool.get(pool);
    if (acc) {
      acc.requests += 1;
      acc.resource_units += ru;
      acc.upload_bytes += bytes;
    } else {
      this._by_pool.set(pool, { requests: 1, resource_units: ru, upload_bytes: bytes });
    }

    this._by_type[request_type] = (this._by_type[request_type] ?? 0) + 1;
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
