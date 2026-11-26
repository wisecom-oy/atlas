import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import {
  outage_with_partial_result,
  record_graph_outage,
  run_stopping_on_graph_outage,
} from '@/services/shared/graph-outage-latch';

/**
 * Issue #869: a backup an outage stopped rejects, so its caller got no result object although the
 * run committed a snapshot. The rejection now carries that result as `partial_result`.
 */

const UNAVAILABLE = new GraphUnavailableError(
  'Microsoft Graph was unavailable after 12 retries over 1411 s: HTTP 503',
  { retries: 12, elapsed_ms: 1_411_000 },
  { status_code: 503, graph_code: 'ServiceUnavailable', cause: new Error('HTTP 503') },
);

describe('run_stopping_on_graph_outage partial result', () => {
  it('rejects with the outage carrying the result the run committed', async () => {
    const committed = { snapshot: { id: 'snapshot-1' }, summary: { folder_failures: [] } };

    const rejection = await run_stopping_on_graph_outage(undefined, async () => {
      record_graph_outage(UNAVAILABLE);
      return committed;
    }).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(GraphUnavailableError);
    expect((rejection as GraphUnavailableError).partial_result).toBe(committed);
  });

  it('gives each run its own copy when one outage reaches two runs', async () => {
    const run = (label: string): Promise<GraphUnavailableError> =>
      run_stopping_on_graph_outage(undefined, async () => {
        record_graph_outage(UNAVAILABLE);
        return label;
      }).then(
        () => {
          throw new Error('expected the run to reject');
        },
        (err: unknown) => err as GraphUnavailableError,
      );

    const [first, second] = await Promise.all([run('first'), run('second')]);

    expect(first.partial_result).toBe('first');
    expect(second.partial_result).toBe('second');
    expect(UNAVAILABLE.partial_result).toBeUndefined();
  });
});

describe('outage_with_partial_result', () => {
  it('keeps every field, the cause and the stack of an unavailable error', () => {
    const copy = outage_with_partial_result(UNAVAILABLE, 'result') as GraphUnavailableError;

    expect(copy).toBeInstanceOf(GraphUnavailableError);
    expect(copy).toMatchObject({
      code: 'ATLAS_GRAPH_UNAVAILABLE',
      message: UNAVAILABLE.message,
      status_code: 503,
      graph_code: 'ServiceUnavailable',
      retries: 12,
      elapsed_ms: 1_411_000,
    });
    expect(copy.cause).toBe(UNAVAILABLE.cause);
    expect(copy.stack).toBe(UNAVAILABLE.stack);
  });

  it('keeps the Retry-After of a throttle', () => {
    const throttled = new ThrottledError('kept throttling', 30_000, { cause: 'HTTP 429' });

    const copy = outage_with_partial_result(throttled, 'result') as ThrottledError;

    expect(copy).toBeInstanceOf(ThrottledError);
    expect(copy).toMatchObject({ code: 'ATLAS_THROTTLED', retry_after_ms: 30_000 });
    expect(copy.cause).toBe('HTTP 429');
    expect(copy.partial_result).toBe('result');
  });

  it('keeps the result out of what logging the error prints', () => {
    const copy = outage_with_partial_result(UNAVAILABLE, { manifest: 'entry-list' });

    expect(Object.keys(copy)).not.toContain('partial_result');
    expect(inspect(copy)).not.toContain('entry-list');
  });
});
