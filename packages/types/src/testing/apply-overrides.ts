/**
 * Fixture overrides that may blank an optional field.
 *
 * `Partial<T>` is not enough under `exactOptionalPropertyTypes`: passing
 * `{ checksum: undefined }` is rejected, even though "this fixture has no
 * checksum" is exactly what a test needs to express.
 */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

/** Applies fixture overrides, where an explicit `undefined` drops the key entirely. */
export function apply_overrides<T extends object>(base: T, overrides: Overrides<T>): T {
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
  }
  return merged as T;
}
