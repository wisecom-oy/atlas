import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import { camelize } from '@wisecom/atlas-types/public/case-convert';

/**
 * Runs a backup whose Graph outage rejection carries the result of the run up to the outage, and
 * camelises that result the way a resolved backup is camelised, so a caller reads the same shape
 * either way (issue #869).
 */
export async function with_camelized_outage_result<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (is_outage_with_partial_result(err)) {
      Object.defineProperty(err, 'partial_result', {
        value: camelize(err.partial_result),
        enumerable: false,
        configurable: true,
      });
    }
    throw err;
  }
}

function is_outage_with_partial_result(
  err: unknown,
): err is GraphUnavailableError | ThrottledError {
  return (
    (err instanceof GraphUnavailableError || err instanceof ThrottledError) &&
    err.partial_result !== undefined
  );
}
