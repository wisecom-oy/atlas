/**
 * Content-encoding handling for the few places the relay must look inside a
 * response body: error code extraction and JSON mutations.
 */
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from 'node:zlib';

/**
 * Decodes a body by its content-encoding. Returns null for an encoding the
 * relay does not understand, so callers can skip rather than guess.
 *
 * `partial` decodes a prefix (an error body sniffed up to a cap) without
 * throwing on the truncated stream; a full decode stays strict, because a
 * mutation must never rewrite a body it only half understood.
 */
export function decode_content(buffer, encoding, partial = false) {
  const kind = String(encoding ?? 'identity')
    .trim()
    .toLowerCase();
  const gzip_flush = partial ? { finishFlush: constants.Z_SYNC_FLUSH } : {};
  const brotli_flush = partial ? { finishFlush: constants.BROTLI_OPERATION_FLUSH } : {};
  if (kind === 'identity' || kind === '') return buffer;
  if (kind === 'gzip' || kind === 'x-gzip') return gunzipSync(buffer, gzip_flush);
  if (kind === 'deflate') return inflateSync(buffer, gzip_flush);
  if (kind === 'br') return brotliDecompressSync(buffer, brotli_flush);
  return null;
}

/** True when a content-type header names JSON (application/json or a +json type). */
export function is_json_content_type(content_type) {
  const type = String(content_type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}
