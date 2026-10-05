import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageRequestEvent, StorageRequestObserver } from '@wisecom/atlas-types';
import { active_log_scope } from '@wisecom/atlas-core/utils/log-context';
import { classify_storage_key } from '@/adapters/storage-key-classifier';
import {
  supports_attempt_timing,
  time_attempt,
  type RequestTiming,
} from '@/adapters/s3-attempt-timing';

/** The command input and output fields an event reads; everything else is ignored. */
interface ObservedInput {
  readonly Key?: unknown;
  readonly Prefix?: unknown;
  readonly Body?: unknown;
  readonly CopySourceRange?: unknown;
}

interface ObservedResponse {
  readonly ContentLength?: unknown;
  readonly name?: unknown;
  readonly $metadata?: {
    readonly attempts?: number;
    readonly totalRetryDelay?: number;
    readonly httpStatusCode?: number;
  };
}

const _request_timing = new AsyncLocalStorage<RequestTiming>();

/**
 * Reports every request `client` sends to `observer`.
 *
 * The outer middleware sits at the start of the `initialize` step, so its clock covers the SDK
 * retry loop and the sleeps inside it. The inner one sits innermost at the `deserialize` step,
 * wrapping only the HTTP exchange, so it runs once per attempt and splits socket queueing from
 * network time. The inner one is skipped on Node releases that cannot measure the split.
 */
export function observe_storage_requests(
  client: S3Client,
  observer: StorageRequestObserver,
  target: string,
): void {
  const timed_attempts = supports_attempt_timing();

  client.middlewareStack.add(
    (next, context) => async (args) => {
      const input = args.input as ObservedInput;
      const timing: RequestTiming = { socket_wait_ms: 0, network_ms: 0, connection_reused: false };
      const pending: PendingEvent = {
        command: String(context['commandName'] ?? 'Unknown').replace(/Command$/, ''),
        operation: active_log_scope()?.fields?.['operation'],
        key: typeof input.Key === 'string' ? input.Key : input.Prefix,
        start_time: Date.now(),
        started: performance.now(),
        request_bytes: request_body_bytes(input),
        target,
      };
      const result = await _request_timing
        .run(timing, () => next(args))
        .catch((err: unknown) => {
          notify(observer, () =>
            build_event(pending, err as ObservedResponse, timed_attempts && timing, err),
          );
          throw err;
        });
      notify(observer, () =>
        build_event(pending, result.output as ObservedResponse, timed_attempts && timing),
      );
      return result;
    },
    { step: 'initialize', priority: 'high', name: 'atlasStorageRequestObserver' },
  );

  if (!timed_attempts) return;
  client.middlewareStack.add(
    (next) => async (args) => {
      const timing = _request_timing.getStore();
      return timing ? time_attempt(timing, () => next(args)) : next(args);
    },
    { step: 'deserialize', priority: 'low', name: 'atlasStorageAttemptTiming' },
  );
}

interface PendingEvent {
  readonly command: string;
  readonly operation: unknown;
  readonly key: unknown;
  readonly start_time: number;
  readonly started: number;
  readonly request_bytes: number | undefined;
  readonly target: string;
}

/** Assembles the event once the request settled, from either its output or its error. */
function build_event(
  pending: PendingEvent,
  response: ObservedResponse | undefined,
  timing: RequestTiming | false,
  err?: unknown,
): StorageRequestEvent {
  const metadata = response?.$metadata;
  const { workload, key_class } = classify_storage_key(
    typeof pending.key === 'string' ? pending.key : undefined,
  );
  const bytes =
    pending.request_bytes ??
    (typeof response?.ContentLength === 'number' ? response.ContentLength : undefined);
  return {
    command: pending.command,
    ...(typeof pending.operation === 'string' ? { operation: pending.operation } : {}),
    workload,
    keyClass: key_class,
    target: pending.target,
    startTime: pending.start_time,
    durationMs: performance.now() - pending.started,
    attempts: metadata?.attempts ?? 1,
    retryDelayMs: metadata?.totalRetryDelay ?? 0,
    ...(timing
      ? {
          socketWaitMs: timing.socket_wait_ms,
          networkMs: timing.network_ms,
          connectionReused: timing.connection_reused,
        }
      : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(metadata?.httpStatusCode !== undefined ? { statusCode: metadata.httpStatusCode } : {}),
    // The S3 error code for service errors (`SlowDown`), the error class name otherwise.
    ...(err !== undefined
      ? { errorType: err instanceof Error && err.name ? err.name : 'Error' }
      : {}),
  };
}

/**
 * Payload size of an upload: the body for PutObject and UploadPart, the copied range for
 * UploadPartCopy. A streamed body has no length up front and reports none.
 */
function request_body_bytes(input: ObservedInput): number | undefined {
  const body = input.Body;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  const range = typeof input.CopySourceRange === 'string' ? input.CopySourceRange : undefined;
  const bounds = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
  return bounds ? Number(bounds[2]) - Number(bounds[1]) + 1 : undefined;
}

/**
 * Builds the event and hands it to the host. Both happen on Atlas's storage path: a throw while
 * building or observing must not fail the request, and a rejected promise from the host's
 * observer must not become an unhandled rejection.
 */
function notify(observer: StorageRequestObserver, build: () => StorageRequestEvent): void {
  try {
    const returned: unknown = observer(build());
    if (returned instanceof Promise) returned.catch(() => undefined);
  } catch {
    // Ignored by contract: observation never changes the outcome of a storage request.
  }
}
