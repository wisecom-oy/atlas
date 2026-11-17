import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { camelize } from '@wisecom/atlas-types/public/case-convert';

/**
 * Runs a listing whose `UnreadableObjectsError` carries the rows it could read, and camelises those
 * rows the way a successful result is camelised, so a caller reads the same shape either way.
 */
export async function with_camelized_partial_result<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof UnreadableObjectsError && err.partial_result !== undefined) {
      Object.defineProperty(err, 'partial_result', {
        value: camelize(err.partial_result),
        enumerable: true,
      });
    }
    throw err;
  }
}
