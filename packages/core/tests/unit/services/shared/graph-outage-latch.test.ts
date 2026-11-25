import { describe, expect, it } from 'vitest';
import { GraphUnavailableError, NotFoundError, ThrottledError } from '@wisecom/atlas-types';
import {
  GraphOutageLatch,
  get_active_graph_outage_signal,
  is_graph_outage,
  record_graph_outage,
  run_stopping_on_graph_outage,
} from '@/services/shared/graph-outage-latch';

function unavailable(label: string): GraphUnavailableError {
  return new GraphUnavailableError(`Microsoft Graph was unavailable: ${label}`, {
    retries: 12,
    elapsed_ms: 1_411_000,
  });
}

describe('GraphOutageLatch', () => {
  it('keeps the first outage and fires its signal with it', () => {
    const latch = new GraphOutageLatch();
    const first = unavailable('first');

    latch.trip(first);
    latch.trip(unavailable('second'));

    expect(latch.outage).toBe(first);
    expect(latch.signal.aborted).toBe(true);
    expect(latch.signal.reason).toBe(first);
  });

  it('reports no outage until tripped', () => {
    const latch = new GraphOutageLatch();

    expect(latch.outage).toBeUndefined();
    expect(latch.signal.aborted).toBe(false);
  });
});

describe('is_graph_outage', () => {
  it('matches the two errors an exhausted retry budget becomes', () => {
    expect(is_graph_outage(unavailable('x'))).toBe(true);
    expect(is_graph_outage(new ThrottledError('kept throttling'))).toBe(true);
    expect(is_graph_outage(new NotFoundError('gone'))).toBe(false);
    expect(is_graph_outage(Object.assign(new Error(''), { statusCode: 503 }))).toBe(false);
  });
});

describe('run_stopping_on_graph_outage', () => {
  it('returns the run result when no Graph call spent its budget', async () => {
    await expect(run_stopping_on_graph_outage(undefined, async () => 'done')).resolves.toBe('done');
  });

  it('lets the run finish and commit, then rejects with the first outage', async () => {
    const first = unavailable('first');
    const committed: string[] = [];

    const result = run_stopping_on_graph_outage(undefined, async () => {
      record_graph_outage(first);
      record_graph_outage(unavailable('second'));
      committed.push('snapshot');
      return 'partial';
    });

    await expect(result).rejects.toBe(first);
    expect(committed).toEqual(['snapshot']);
  });

  it('publishes the latch signal to the run, and only to the run', async () => {
    expect(get_active_graph_outage_signal()).toBeUndefined();
    let inside: AbortSignal | undefined;

    await run_stopping_on_graph_outage(undefined, async () => {
      inside = get_active_graph_outage_signal();
    });

    expect(inside).toBeInstanceOf(AbortSignal);
    expect(get_active_graph_outage_signal()).toBeUndefined();
  });

  it('ignores errors that are not an exhausted budget', async () => {
    const result = run_stopping_on_graph_outage(undefined, async () => {
      record_graph_outage(new NotFoundError('one message is gone'));
      record_graph_outage(Object.assign(new Error(''), { statusCode: 503 }));
      return 'complete';
    });

    await expect(result).resolves.toBe('complete');
  });

  it('keeps the interrupted result of a run the operator cancelled', async () => {
    const controller = new AbortController();

    const result = run_stopping_on_graph_outage(controller.signal, async () => {
      record_graph_outage(unavailable('during cancel'));
      controller.abort(new Error('cancelled'));
      return 'interrupted';
    });

    await expect(result).resolves.toBe('interrupted');
  });

  it('rejects with its own error when the run rejects', async () => {
    const own = new NotFoundError('mailbox not found');

    const result = run_stopping_on_graph_outage(undefined, async () => {
      record_graph_outage(unavailable('earlier'));
      throw own;
    });

    await expect(result).rejects.toBe(own);
  });

  it('records nothing outside a run', () => {
    expect(() => record_graph_outage(unavailable('no run'))).not.toThrow();
  });
});
