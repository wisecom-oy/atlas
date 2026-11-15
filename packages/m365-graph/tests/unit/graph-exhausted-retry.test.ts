import { describe, expect, it } from 'vitest';
import {
  GraphAccessRefusedError,
  GraphUnavailableError,
  ThrottledError,
} from '@wisecom/atlas-types';
import { is_exhausted_retry, rethrow_if_retry_exhausted } from '@/graph-exhausted-retry';

describe('rethrow_if_retry_exhausted', () => {
  const unavailable = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 });
  const throttled = new ThrottledError('throttled', 1000);

  it.each([
    ['GraphUnavailableError', unavailable],
    ['ThrottledError', throttled],
  ])('rethrows %s', (_, err) => {
    expect(is_exhausted_retry(err)).toBe(true);
    expect(() => rethrow_if_retry_exhausted(err)).toThrow(err);
  });

  it.each([
    ['a 403', { statusCode: 403 }],
    ['a 404', { statusCode: 404 }],
    ['a raw 503 still inside its budget', { statusCode: 503 }],
    ['a refused resource', new GraphAccessRefusedError('refused', {}, 'access_refused')],
    ['undefined', undefined],
  ])('leaves %s to the caller', (_, err) => {
    expect(is_exhausted_retry(err)).toBe(false);
    expect(() => rethrow_if_retry_exhausted(err)).not.toThrow();
  });
});
