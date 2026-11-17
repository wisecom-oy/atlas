/** Property under which a failed operation carries the damaged keys it had already found. */
const UNREADABLE_KEYS = Symbol.for('atlas.unreadable_keys');

/**
 * Records on a thrown error the damaged stored objects the operation had skipped before it failed,
 * so the caller can still name them (issue #694). The error itself is rethrown unchanged: its class,
 * code and message decide the exit code, and wrapping it would hide them. A non-object throw, or an
 * empty key list, is returned as is.
 */
export function attach_unreadable_keys<T>(thrown: T, unreadable_keys: readonly string[]): T {
  if (unreadable_keys.length === 0 || typeof thrown !== 'object' || thrown === null) return thrown;
  if (!Object.isExtensible(thrown)) return thrown;
  Object.defineProperty(thrown, UNREADABLE_KEYS, {
    value: [...unreadable_keys],
    enumerable: false,
    configurable: true,
  });
  return thrown;
}

/** The damaged keys a failed operation recorded with `attach_unreadable_keys`, or none. */
export function attached_unreadable_keys(thrown: unknown): readonly string[] {
  if (typeof thrown !== 'object' || thrown === null) return [];
  const keys = (thrown as Record<symbol, unknown>)[UNREADABLE_KEYS];
  return Array.isArray(keys) ? (keys as string[]) : [];
}
