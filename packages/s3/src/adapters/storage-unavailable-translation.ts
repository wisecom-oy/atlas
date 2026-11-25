import type { S3Client } from '@aws-sdk/client-s3';
import { StorageUnavailableError } from '@wisecom/atlas-types';

/** Node socket codes for a connection that failed or broke before any HTTP answer arrived. */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

interface TransportErrorFields {
  readonly code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: number; readonly attempts?: number };
}

/**
 * Rethrows a request the backend never answered, once the SDK has spent its attempts, as
 * `StorageUnavailableError` with the SDK error as its cause (issue #924).
 *
 * Registered first at the `initialize` step, so it wraps the retry loop and every middleware added
 * after it, including the storage request observer, which still sees the SDK's own error. An HTTP
 * answer of any status and a cancelled request pass through unchanged: callers branch on those.
 */
export function translate_unanswered_requests(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) =>
      async (args): ReturnType<typeof next> => {
        try {
          return await next(args);
        } catch (err) {
          if (!is_unanswered_request(err)) throw err;
          const command = String(context['commandName'] ?? 'request').replace(/Command$/, '');
          const attempts = (err as TransportErrorFields).$metadata?.attempts ?? 1;
          throw new StorageUnavailableError(
            `S3 ${command} got no answer from the storage endpoint after ${attempts} ` +
              `attempt(s): ${err.message}`,
            attempts,
            { cause: err },
          );
        }
      },
    { step: 'initialize', priority: 'high', name: 'atlasStorageUnavailable' },
  );
}

/** A timeout or socket failure with no HTTP status: the backend never answered the request. */
export function is_unanswered_request(err: unknown): err is Error {
  if (!(err instanceof Error) || err.name === 'AbortError') return false;
  const fields = err as TransportErrorFields;
  if (fields.$metadata?.httpStatusCode !== undefined) return false;
  if (err.name === 'TimeoutError') return true;
  return typeof fields.code === 'string' && TRANSPORT_FAILURE_CODES.has(fields.code);
}
