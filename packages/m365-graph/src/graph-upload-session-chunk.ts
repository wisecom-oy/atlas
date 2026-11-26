/**
 * The send policy for one chunk PUT into a Graph upload session, shared by OneDrive and SharePoint
 * file uploads and by Outlook and Calendar attachment uploads (issues #878, #891, #892).
 *
 * An intermediate chunk is addressed by its `Content-Range`, so sending it again rewrites the same
 * bytes and creates nothing. The committing chunk, the last one, is the request that creates the
 * file or attachment. Microsoft 365 can commit it and still answer `5xx`, or answer after the
 * deadline, so it is sent again only after a throttle response, which Graph sends instead of
 * processing the request. A committing chunk that ended any other ambiguous way is reported as an
 * unknown outcome rather than as a refused upload, so the operator checks the target before a
 * rerun leaves a second copy beside the first.
 */
import { ThrottledError, UploadCommitUnknownError } from '@wisecom/atlas-types';
import {
  describe_graph_error,
  is_retryable_error,
  is_throttle_response,
  with_graph_retry,
  type GraphRetryOptions,
} from '@/graph-request-error-handler';
import { is_transient_token_request_error } from '@/graph-token-failure';

/** Which chunk of a session a PUT carries. The committing chunk is the last, and creates the item. */
export type UploadChunkRole = 'intermediate' | 'commit';

/** One chunk PUT, as the send policy needs to know it. */
export interface UploadChunk {
  readonly role: UploadChunkRole;
  /** The `Content-Range` value, which names the chunk in a failure. */
  readonly range: string;
  readonly bytes: number;
  /** What the session creates, for the failure text: `file` or `attachment`. */
  readonly item: string;
}

/** The shortest per-attempt deadline of a chunk PUT. */
const MIN_CHUNK_TIMEOUT_MS = 60_000;
/** The slowest upload a chunk deadline allows for: 128 bytes per ms, about 1 Mbit/s. */
const MIN_UPLOAD_BYTES_PER_MS = 128;

/**
 * Per-attempt deadline of one chunk PUT, from sending the first byte to reading the answer:
 * `max(60 s, chunk bytes / 128)` ms, so 60 s for a 4 MiB attachment chunk and about 82 s for a
 * 10 MiB drive chunk. It bounds the committing chunk too, which Ctrl+C lets finish.
 */
export function upload_chunk_timeout_ms(chunk_bytes: number): number {
  return Math.max(MIN_CHUNK_TIMEOUT_MS, Math.ceil(chunk_bytes / MIN_UPLOAD_BYTES_PER_MS));
}

/** A chunk PUT that got no HTTP answer: the connection failed, or the attempt's deadline passed. */
export class UploadChunkTransportError extends Error {
  override readonly name = 'UploadChunkTransportError';
}

/**
 * Whether a failed chunk PUT may be sent again. An intermediate chunk is repeated after a transient
 * status or a transport failure; the committing chunk only after a `429`, or a `503` carrying
 * `Retry-After`. A `4xx` other than `408` and `429` is never repeated.
 */
export function is_upload_chunk_retry_safe(err: unknown, role: UploadChunkRole): boolean {
  if (role === 'commit') return is_throttle_response(err);
  return err instanceof UploadChunkTransportError || is_retryable_error(err);
}

/**
 * Whether a committing chunk's last failure leaves it unknown whether the item was created. A
 * throttle response or a failed token request created nothing. Any other failure after the chunk
 * was sent more than once may follow an earlier send that landed; on the first send, a timeout, a
 * transport failure, an unreadable `2xx`, or a `408`, `5xx` or `509` may follow a commit.
 */
export function leaves_commit_unknown(failure: unknown, sends: number): boolean {
  if (is_throttle_response(failure) || failure instanceof ThrottledError) return false;
  if (is_transient_token_request_error(failure)) return false;
  if (sends > 1) return true;
  return failure instanceof UploadChunkTransportError || is_retryable_error(failure);
}

/** Retry options for one chunk PUT sent through `with_graph_retry`. */
export function upload_chunk_retry_options(chunk: UploadChunk): GraphRetryOptions {
  const timeout_ms = upload_chunk_timeout_ms(chunk.bytes);
  if (chunk.role === 'intermediate') return { timeout_ms };
  // Sent once, and once sent finished: a commit cut off by Ctrl+C may still have landed (#682).
  return { timeout_ms, idempotent: false, complete_in_flight: true };
}

/** Runs a Graph call under a retry policy; `with_graph_retry` unless the caller maps its errors. */
export type UploadChunkRunner = <T>(
  call: (attempt_signal: AbortSignal) => Promise<T>,
  options: GraphRetryOptions,
) => Promise<T>;

/**
 * Sends one chunk through the Graph client under the chunk send policy, and throws
 * `UploadCommitUnknownError` when the committing chunk ended ambiguously. `send` must hand the
 * attempt signal to the request, so a timed-out PUT is aborted before its retry is sent.
 */
export async function send_upload_chunk<T>(
  chunk: UploadChunk,
  send: (attempt_signal: AbortSignal) => Promise<T>,
  run: UploadChunkRunner = with_graph_retry,
): Promise<T> {
  const attempts = new ChunkAttemptLog();
  try {
    return await run((signal) => attempts.track(send(signal)), upload_chunk_retry_options(chunk));
  } catch (err) {
    if (chunk.role !== 'commit' || attempts.sends === 0) throw err;
    const failure = attempts.last_failure(err);
    if (leaves_commit_unknown(failure, attempts.sends)) {
      throw new UploadCommitUnknownError(chunk, describe_graph_error(failure), { cause: failure });
    }
    throw err;
  }
}

/**
 * Counts the sends of one chunk and keeps how the last one ended. The retry loop rethrows a
 * cancelled run's reason in place of the failure a committing chunk met after Ctrl+C, and the
 * failure is what decides whether the item may exist.
 */
class ChunkAttemptLog {
  sends = 0;
  private _in_flight = false;
  private _failure: unknown = undefined;

  /** Records one send and how it settled. */
  async track<T>(request: Promise<T>): Promise<T> {
    this.sends += 1;
    this._in_flight = true;
    this._failure = undefined;
    try {
      return await request;
    } catch (err) {
      this._failure = err;
      throw err;
    } finally {
      this._in_flight = false;
    }
  }

  /**
   * The failure that ended the last send. A send still in flight when the loop gave up was cut off
   * by its deadline, which `thrown` then reports.
   */
  last_failure(thrown: unknown): unknown {
    return this._in_flight || this._failure === undefined ? thrown : this._failure;
  }
}
