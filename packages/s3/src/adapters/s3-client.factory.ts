import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { DEFAULT_S3_TRANSPORT, type S3Config, type S3TransportSettings } from '@wisecom/atlas-core';
import { warn_if_plaintext_endpoint } from '@/adapters/plaintext-endpoint-warning';
import { create_s3_retry_strategy } from '@/adapters/s3-retry-strategy';
import { translate_unanswered_requests } from '@/adapters/storage-unavailable-translation';

export const S3_CLIENT_TOKEN = Symbol.for('S3Client');

/**
 * Creates an S3Client configured for the endpoint and credentials in S3Config, with bounded
 * connection and idle timeouts, per-request retries, and unanswered requests raised as
 * `StorageUnavailableError`.
 */
export function create_s3_client(config: S3Config): S3Client {
  warn_if_plaintext_endpoint(config.s3_endpoint);
  const client = new S3Client(build_s3_client_config(config));
  translate_unanswered_requests(client);
  return client;
}

/** The S3Client constructor options for `config`, with transport defaults filled in. */
export function build_s3_client_config(config: S3Config): S3ClientConfig {
  const transport = config.s3_transport ?? DEFAULT_S3_TRANSPORT;
  return {
    endpoint: config.s3_endpoint,
    region: config.s3_region,
    credentials: {
      accessKeyId: config.s3_access_key,
      secretAccessKey: config.s3_secret_key,
    },
    forcePathStyle: true,
    requestHandler: build_request_handler_options(transport),
    maxAttempts: transport.max_attempts,
    retryStrategy: create_s3_retry_strategy(transport.max_attempts),
  };
}

/**
 * Options for the SDK's Node HTTP handler.
 *
 * `socketTimeout` is the idle timeout: the handler calls `socket.setTimeout`, which fires only after
 * that long with no byte sent or received, and destroys the request with a `TimeoutError`. It is
 * the right bound for a part upload or a download on a slow link, which keeps moving bytes.
 *
 * `requestTimeout` stays unset on purpose. In `@smithy/node-http-handler` 4.x it is one wall-clock
 * timer from the start of the request until the response headers arrive, which includes sending
 * the whole body, so it would cap an 8 MiB part upload on a slow link. Without
 * `throwOnRequestTimeout` it only logs a warning anyway.
 */
function build_request_handler_options(
  transport: S3TransportSettings,
): NonNullable<S3ClientConfig['requestHandler']> {
  return {
    connectionTimeout: transport.connection_timeout_ms,
    socketTimeout: transport.idle_timeout_ms,
  };
}
