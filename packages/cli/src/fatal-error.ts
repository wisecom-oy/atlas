import { inspect } from 'node:util';
import { logger } from '@wisecom/atlas-core';
import { AtlasError, type AtlasErrorCode } from '@wisecom/atlas-types';

const ATLAS_EXIT_CODES = {
  ATLAS_AUTH_DENIED: 4,
  ATLAS_MAILBOX_NOT_LICENSED: 4,
  ATLAS_NOT_FOUND: 7,
  ATLAS_THROTTLED: 3,
  ATLAS_WRONG_PASSPHRASE: 5,
  ATLAS_OBJECT_LOCK_RETAINED: 8,
  ATLAS_STORAGE_FAILURE: 1,
  ATLAS_CONFIG_INVALID: 6,
} satisfies Record<AtlasErrorCode, number>;

const NETWORK_CODES: Readonly<Record<string, true>> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  ETIMEDOUT: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  EPIPE: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
};
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

type ErrorFields = Record<string, unknown>;

/** Reports a fatal command failure and selects its v5 exit category without parsing prose. */
export function handle_fatal_error(err: unknown): void {
  const chain = error_chain(err);
  const atlas_error = chain.find((error) => error instanceof AtlasError);
  const statuses = chain.map(http_status);
  const atlas_code = atlas_error?.code ?? transport_atlas_code(statuses);
  const network_error = chain.some(
    (error) => typeof error.code === 'string' && NETWORK_CODES[error.code] === true,
  );
  process.exitCode = failure_exit_code(statuses, atlas_code, network_error);

  logger.error(err instanceof Error ? err.message : String(err));
  if (atlas_code) logger.error(`  Atlas code: ${atlas_code}`);
  if (atlas_error) log_remediation(atlas_error);
  for (const [index, error] of chain.entries()) {
    if (index > 0 && typeof error.message === 'string') {
      logger.error(`  Cause: ${error.message}`);
    }
    log_transport_details(error);
  }
  if (network_error) log_connection_hint(chain);
  if (process.env.DEBUG && chain[0]?.stack) logger.error(String(chain[0].stack));
}

function error_chain(err: unknown): ErrorFields[] {
  const chain: ErrorFields[] = [];
  const seen = new Set<object>();
  while (err !== null && typeof err === 'object' && !seen.has(err)) {
    seen.add(err);
    const fields = err as ErrorFields;
    chain.push(fields);
    err = fields.cause;
  }
  return chain;
}

function failure_exit_code(
  statuses: number[],
  atlas_code: AtlasErrorCode | undefined,
  network_error: boolean,
): number {
  // A specific Atlas classification wins over incidental transport details. StorageError is
  // deliberately broad, so its cause can still identify a permission or transient failure.
  if (atlas_code && atlas_code !== 'ATLAS_STORAGE_FAILURE') {
    return ATLAS_EXIT_CODES[atlas_code];
  }
  if (statuses.some((status) => status === 401 || status === 403)) return 4;
  if (statuses.includes(404)) return 7;
  if (network_error || statuses.some((status) => RETRYABLE_STATUS_CODES.has(status))) {
    return 3;
  }
  return 1;
}

function transport_atlas_code(statuses: number[]): AtlasErrorCode | undefined {
  if (statuses.some((status) => status === 401 || status === 403)) return 'ATLAS_AUTH_DENIED';
  if (statuses.includes(404)) return 'ATLAS_NOT_FOUND';
  if (statuses.includes(429)) return 'ATLAS_THROTTLED';
  return undefined;
}

function http_status(error: ErrorFields): number {
  const metadata = error.$metadata;
  const status =
    error.statusCode ??
    error.status ??
    (metadata !== null && typeof metadata === 'object'
      ? (metadata as ErrorFields).httpStatusCode
      : undefined);
  return typeof status === 'number' ? status : 0;
}

function log_transport_details(error: ErrorFields): void {
  const status = http_status(error);
  if (status) logger.error(`  HTTP status: ${status}`);
  if (!(error instanceof AtlasError) && typeof error.code === 'string') {
    logger.error(`  Transport code: ${error.code}`);
  }
  if (!(error instanceof AtlasError) && typeof error.name === 'string') {
    logger.error(`  Error name: ${error.name}`);
  }
  if (error.body !== undefined) {
    logger.error(`  Body: ${inspect(error.body, { depth: 4, colors: false })}`);
  }
}

function log_remediation(error: AtlasError): void {
  if (error.code === 'ATLAS_WRONG_PASSPHRASE') {
    logger.error(
      'Use the original encryption passphrase for this tenant. Do not replace or pad it, or ' +
        'delete the wrapped data key. If the passphrase is correct, investigate possible corruption.',
    );
  }
  if (error.code === 'ATLAS_THROTTLED') {
    const retry_after_ms = (error as AtlasError & { retry_after_ms?: unknown }).retry_after_ms;
    if (typeof retry_after_ms === 'number' && Number.isFinite(retry_after_ms)) {
      logger.error(`  Retry after: ${retry_after_ms} ms`);
    }
  }
}

function log_connection_hint(chain: ErrorFields[]): void {
  const is_storage = chain.some(
    (error) =>
      (error instanceof AtlasError && error.code === 'ATLAS_STORAGE_FAILURE') ||
      (error.$metadata !== null && typeof error.$metadata === 'object'),
  );
  if (is_storage) {
    logger.error('Cannot connect to S3. Check the configured endpoint and S3/MinIO service.');
    logger.error('  If using local MinIO: cd docker && docker compose up -d');
  } else {
    logger.error('Cannot reach the remote service. Check DNS, network connectivity and endpoints.');
  }
}
