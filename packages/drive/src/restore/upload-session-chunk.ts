import {
  UploadChunkTransportError,
  cancellable_sleep,
  describe_graph_error,
  is_upload_chunk_retry_safe,
  leaves_commit_unknown,
  parse_retry_after_ms,
  report_transfer_throttle,
  upload_chunk_timeout_ms,
  wait_for_transfer_slot,
  type UploadChunkRole,
} from '@wisecom/atlas-m365-graph';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';

/** Sends of one chunk PUT, the first included. */
export const CHUNK_PUT_ATTEMPTS = 3;

/** The wait before a chunk is sent again when the answer named none. */
const DEFAULT_RETRY_WAIT_MS = 1_000;

/** How Graph answered one chunk: whether the item is complete, and its id when Graph said. */
export interface ChunkAnswer {
  readonly completed: boolean;
  readonly item_id?: string | undefined;
}

/** A chunk PUT answered with a status other than `200`, `201` or `202`. */
class ChunkStatusError extends Error {
  constructor(
    range: string,
    readonly status_code: number,
    readonly headers: Headers,
    readonly detail: string,
  ) {
    super(`Resumable upload failed at range ${range}: HTTP ${status_code} ${detail}`);
  }
}

/**
 * The failure in the shape the shared Graph classification reads: the status on `statusCode` and
 * `Retry-After` in `headers`. Anything other than a status answer passes through unchanged.
 */
function as_graph_failure(err: unknown): unknown {
  if (!(err instanceof ChunkStatusError)) return err;
  return Object.assign(new Error(err.detail.trim()), {
    statusCode: err.status_code,
    headers: err.headers,
  });
}

/**
 * Uploads one chunk, returning whether Graph reported the item as complete.
 *
 * Every send has its own deadline (`upload_chunk_timeout_ms`) and is aborted when it passes, so a
 * PUT the host never answers cannot sit beside its own retry. An intermediate chunk is sent up to
 * 3 times after a transient status, a dropped connection or a deadline (issue #878). The committing
 * chunk is sent again only after a throttle response, and one that ended ambiguously throws
 * `UploadCommitUnknownError`, because Microsoft 365 may have created the file (issue #892). Ctrl+C
 * ends an intermediate chunk and every wait, but lets a committing chunk already sent run to its
 * deadline (#682).
 */
export async function put_chunk_with_retry(
  upload_url: string,
  range: string,
  chunk: Buffer,
  abort_signal: AbortSignal | undefined,
  role: UploadChunkRole = 'intermediate',
): Promise<ChunkAnswer> {
  const request_signal = role === 'commit' ? undefined : abort_signal;
  for (let sends = 1; ; sends++) {
    await wait_for_transfer_slot(abort_signal);
    try {
      return await put_chunk_once(upload_url, range, chunk, request_signal);
    } catch (err) {
      const retry =
        sends < CHUNK_PUT_ATTEMPTS &&
        abort_signal?.aborted !== true &&
        is_upload_chunk_retry_safe(as_graph_failure(err), role);
      if (!retry) throw chunk_failure(err, range, role, sends);
      await cancellable_sleep(retry_wait_ms(err), abort_signal);
    }
  }
}

/**
 * The error a chunk's last failure ends the upload with: an unknown outcome for a committing chunk
 * that may have landed, a plain failure naming the range otherwise, and a cancelled run's reason
 * unchanged.
 */
function chunk_failure(err: unknown, range: string, role: UploadChunkRole, sends: number): unknown {
  const failure = as_graph_failure(err);
  if (role === 'commit' && leaves_commit_unknown(failure, sends)) {
    return new UploadCommitUnknownError({ range, item: 'file' }, describe_graph_error(failure), {
      cause: failure,
    });
  }
  if (err instanceof UploadChunkTransportError) {
    return new Error(
      `Resumable upload failed at range ${range} after ${sends} attempt(s): ` +
        describe_graph_error(err),
      { cause: err },
    );
  }
  return err;
}

/** The wait before a chunk is sent again: the answer's `Retry-After`, otherwise 1 s. */
function retry_wait_ms(err: unknown): number {
  if (!(err instanceof ChunkStatusError)) return DEFAULT_RETRY_WAIT_MS;
  // The shared parser: the private `parseInt` copy this replaces had no clamp, so a value above
  // 2^31-1 ms overflowed `setTimeout` and retried after about 1 ms (issue #628).
  return parse_retry_after_ms(err.headers.get('retry-after')) ?? DEFAULT_RETRY_WAIT_MS;
}

/**
 * Sends one chunk once, under its deadline. `run_signal` cuts the PUT off when the run is
 * cancelled, and is left out for the committing chunk.
 */
async function put_chunk_once(
  upload_url: string,
  range: string,
  chunk: Buffer,
  run_signal: AbortSignal | undefined,
): Promise<ChunkAnswer> {
  const deadline_ms = upload_chunk_timeout_ms(chunk.length);
  const attempt = new AbortController();
  const timer = setTimeout(() => {
    attempt.abort(new UploadChunkTransportError(`no answer within ${deadline_ms / 1000} s`));
  }, deadline_ms);
  const cancel = (): void => attempt.abort(run_signal?.reason);
  run_signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await send_chunk_put(upload_url, range, chunk, attempt.signal, run_signal);
    report_transfer_throttle(response);
    return await read_chunk_answer(response, range);
  } finally {
    clearTimeout(timer);
    run_signal?.removeEventListener('abort', cancel);
  }
}

/**
 * The chunk PUT. A rejected fetch is the run's cancellation when the run was cancelled, the
 * deadline's error when it passed, and otherwise a transport failure.
 */
async function send_chunk_put(
  upload_url: string,
  range: string,
  chunk: Buffer,
  attempt_signal: AbortSignal,
  run_signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Range': range, 'Content-Length': String(chunk.length) },
      body: chunk,
      signal: attempt_signal,
    });
  } catch (err) {
    if (run_signal?.aborted === true) throw run_signal.reason;
    if (attempt_signal.aborted) throw attempt_signal.reason;
    throw new UploadChunkTransportError(`connection failed: ${describe_graph_error(err)}`, {
      cause: err,
    });
  }
}

/**
 * Reads Graph's answer to a chunk. `200` and `201` carry the finished driveItem, `202` means the
 * session wants more bytes, and anything else throws `ChunkStatusError`.
 */
async function read_chunk_answer(response: Response, range: string): Promise<ChunkAnswer> {
  if (response.status === 200 || response.status === 201) {
    return { completed: true, item_id: await read_created_item_id(response) };
  }
  if (response.status === 202) return { completed: false };
  throw new ChunkStatusError(range, response.status, response.headers, await read_detail(response));
}

/** The body of a failed chunk for the error text, or nothing when it cannot be read in time. */
async function read_detail(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * The id of the item a completed session created, or undefined when the body does not say. Only a
 * permission restore needs it, so an unreadable body never fails an upload that succeeded.
 */
async function read_created_item_id(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { id?: unknown };
    return typeof body.id === 'string' ? body.id : undefined;
  } catch {
    return undefined;
  }
}
