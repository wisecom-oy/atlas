import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { handle_fatal_error } from '@/fatal-error';

/**
 * Issues #867 and #868: a Graph 408, a 509, and a 200 whose JSON body did not parse are transient.
 * Once the retry budget is spent, the command they end before any item exits 3, never 1. A 423 and
 * a 507 are not retried and keep exit 1; 400, 401, 403 and 404 keep their own codes.
 */

/** `with_graph_retry` sends the first attempt and 12 retries. */
const MAX_ATTEMPTS = 13;

let previous_exit_code: typeof process.exitCode;
let diagnostics: string[];

/** What `with_graph_retry` throws for a call that fails with `err` on every attempt. */
async function exhausted(err: unknown): Promise<unknown> {
  const promise = with_graph_retry(() => Promise.reject(err)).catch((e: unknown) => e);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await vi.advanceTimersByTimeAsync(300_000);
  }
  return await promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  previous_exit_code = process.exitCode;
  process.exitCode = undefined;
  diagnostics = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    diagnostics.push(args.join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = previous_exit_code;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('exit code of a Graph failure that outlasted the retry budget', () => {
  it('exits 3 with ATLAS_GRAPH_UNAVAILABLE for a 408', async () => {
    handle_fatal_error(await exhausted({ statusCode: 408, code: null, message: '' }));

    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_GRAPH_UNAVAILABLE');
  });

  it('exits 3 with ATLAS_THROTTLED for a 509', async () => {
    handle_fatal_error(await exhausted({ statusCode: 509, code: null, message: '' }));

    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_THROTTLED');
  });

  it('exits 3 with ATLAS_GRAPH_UNAVAILABLE for a 200 whose JSON body did not parse', async () => {
    const parse_failure = Object.assign(new Error('Unexpected end of JSON input'), {
      statusCode: 200,
      code: 'SyntaxError',
    });

    handle_fatal_error(await exhausted(parse_failure));

    expect(process.exitCode).toBe(3);
    const output = diagnostics.join('\n');
    expect(output).toContain('Atlas code: ATLAS_GRAPH_UNAVAILABLE');
    expect(output).toContain('HTTP status: 200');
  });
});

describe('exit code of a Graph status thrown without retries', () => {
  it('exits 3 for a 408 a write sent once rethrew unchanged', () => {
    handle_fatal_error({ statusCode: 408 });

    expect(process.exitCode).toBe(3);
  });

  it('exits 3 with ATLAS_THROTTLED for an unwrapped 509', () => {
    handle_fatal_error({ statusCode: 509 });

    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('Atlas code: ATLAS_THROTTLED');
  });

  it.each([
    [400, 1],
    [401, 4],
    [403, 4],
    [404, 7],
    [423, 1],
    [507, 1],
  ])('keeps exit code for a %i at %i', async (status, exit_code) => {
    handle_fatal_error(await exhausted({ statusCode: status, code: null, message: '' }));

    expect(process.exitCode).toBe(exit_code);
  });
});
