/** Narrows an unknown JSON value to a plain object. */
export function is_record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
