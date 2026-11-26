import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateOutcomeUnknownError } from '@wisecom/atlas-types';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { queued_graph_fetch } from '@wisecom/atlas-types/testing/queued-graph-fetch';
import { is_retryable_error, with_graph_retry } from '@/graph-request-error-handler';
import { is_unreadable_success_body } from '@/graph-unreadable-body';

/**
 * Issue #868: a 200 whose JSON body is empty or cut short on a clean close is answered, but
 * unusable. A repeated GET normally reads it whole, so it is retried like any transient answer and
 * ends as `GraphUnavailableError` once the budget is spent.
 */

/** `with_graph_retry` sends the first attempt and 12 retries. */
const MAX_ATTEMPTS = 13;
const FOLDERS_PATH = '/users/user-1/mailFolders';

/** A JSON response with the given status and raw body text. */
function json_response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

/** Reads the folder listing through a real Graph client, inside the retry loop. */
function list_folders(options = {}): Promise<unknown> {
  const client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
  return with_graph_retry(() => client.api(FOLDERS_PATH).get() as Promise<unknown>, options).catch(
    (e: unknown) => e,
  );
}

/** Lets every retry of the loop run, and returns what the call settled with. */
async function settle(promise: Promise<unknown>): Promise<unknown> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await vi.advanceTimersByTimeAsync(300_000);
  }
  return await promise;
}

/** The error the Graph SDK raises for a JSON response it could not parse. */
async function sdk_parse_failure(status: number, body: string): Promise<unknown> {
  vi.stubGlobal('fetch', queued_graph_fetch(json_response(status, body)).fetch);
  const client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
  return client
    .api(FOLDERS_PATH)
    .get()
    .catch((e: unknown) => e);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('is_unreadable_success_body', () => {
  it.each([
    ['empty', ''],
    ['cut short', '{"value":[{"id":"fol'],
  ])('recognises the SDK error for a 200 with a %s body', async (_label, body) => {
    const err = await sdk_parse_failure(200, body);

    expect(err).toMatchObject({ statusCode: 200, code: 'SyntaxError' });
    expect(is_unreadable_success_body(err)).toBe(true);
    expect(is_retryable_error(err)).toBe(true);
  });

  it.each([400, 404, 423])('leaves a %i with an unparseable body to its status', async (status) => {
    const err = await sdk_parse_failure(status, '');

    expect(is_unreadable_success_body(err)).toBe(false);
    expect(is_retryable_error(err)).toBe(false);
  });

  it('ignores a SyntaxError with no HTTP status', () => {
    expect(is_unreadable_success_body({ statusCode: -1, code: 'SyntaxError' })).toBe(false);
    expect(is_unreadable_success_body(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
  });
});

describe('with_graph_retry on a 200 with an unreadable JSON body', () => {
  it('reads the listing again and returns the second answer', async () => {
    const rig = queued_graph_fetch(
      json_response(200, ''),
      json_response(200, '{"value":[{"id":"folder-1"}]}'),
    );
    vi.stubGlobal('fetch', rig.fetch);

    const result = await settle(list_folders());

    expect(result).toEqual({ value: [{ id: 'folder-1' }] });
    expect(rig.urls).toHaveLength(2);
  });

  it('raises GraphUnavailableError once the budget is spent', async () => {
    const responses = Array.from({ length: MAX_ATTEMPTS }, () => json_response(200, ''));
    const rig = queued_graph_fetch(...responses);
    vi.stubGlobal('fetch', rig.fetch);

    const failure = await settle(list_folders());

    expect(rig.urls).toHaveLength(MAX_ATTEMPTS);
    expect(failure).toBeInstanceOf(GraphUnavailableError);
    const unavailable = failure as GraphUnavailableError;
    expect(unavailable.code).toBe('ATLAS_GRAPH_UNAVAILABLE');
    expect(unavailable.status_code).toBe(200);
    // SyntaxError is the SDK's, not a code Graph sent.
    expect(unavailable.graph_code).toBeUndefined();
    expect(unavailable.message).toContain('HTTP 200');
  });

  it('does not send a write marked idempotent: false again', async () => {
    const rig = queued_graph_fetch(json_response(201, ''), json_response(201, '{"id":"m-1"}'));
    vi.stubGlobal('fetch', rig.fetch);

    const failure = await settle(list_folders({ idempotent: false }));

    expect(rig.urls).toHaveLength(1);
    expect(failure).toBeInstanceOf(CreateOutcomeUnknownError);
    expect((failure as Error).cause).toMatchObject({ statusCode: 201, code: 'SyntaxError' });
  });

  it('still retries a body cut off mid-stream (terminated)', async () => {
    const terminated = Object.assign(new TypeError('terminated'), { statusCode: 200 });
    const sdk_shape = Object.assign(new Error('terminated'), {
      statusCode: 200,
      code: 'TypeError',
      cause: terminated,
    });
    let calls = 0;
    const fn = (): Promise<string> =>
      ++calls === 1 ? Promise.reject(sdk_shape) : Promise.resolve('ok');

    expect(await settle(with_graph_retry(fn))).toBe('ok');
    expect(calls).toBe(2);
  });
});
