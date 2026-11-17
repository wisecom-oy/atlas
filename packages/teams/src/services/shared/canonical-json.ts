/**
 * Serializes a value as JSON with object keys sorted at every depth. Graph does not promise a key
 * order, so two equal payloads must hash and store identically. Undefined members are dropped, as
 * JSON.stringify drops them.
 */
export function canonical_json(value: unknown): string {
  return JSON.stringify(sort_keys(value));
}

function sort_keys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sort_keys(item)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, sort_keys(member)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
