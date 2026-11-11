import { Readable } from 'node:stream';
import type { ObjectStorage } from '@/index';

/**
 * Builds an `ObjectStorage.get_stream` that serves whatever `get` resolves to, as one chunk.
 *
 * `get` is called on every read rather than captured once, so a test that re-mocks it later still
 * controls what the stream yields, and a rejected `get` rejects the stream the same way.
 */
export function stream_from_get(
  get: (key: string) => Promise<Buffer>,
): ObjectStorage['get_stream'] {
  return async (key: string) => Readable.from([await get(key)]);
}
