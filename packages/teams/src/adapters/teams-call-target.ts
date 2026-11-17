/**
 * The team a Teams connector call targets. Calls pass the team id as the second argument, or inside
 * a message locator (`{ team_id, channel_id }`) when they address a message or hosted content.
 */
export function team_id_of_call(args: readonly unknown[]): string | undefined {
  const second = args[1];
  return typeof second === 'string' ? second : locator_field(second, 'team_id');
}

/**
 * The channel a connector call targets: a message locator's channel when the second argument is a
 * locator, otherwise the third argument. A locator call's third argument is a hosted content id.
 */
export function channel_id_of_call(args: readonly unknown[]): string | undefined {
  if (typeof args[1] !== 'string') return locator_field(args[1], 'channel_id');
  return typeof args[2] === 'string' ? args[2] : undefined;
}

/** Reads one string field of a locator object, or undefined when the value is not a locator. */
function locator_field(value: unknown, field: 'team_id' | 'channel_id'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'string' ? found : undefined;
}
