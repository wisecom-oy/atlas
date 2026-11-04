/** Returns the message of an error, or its string form when the thrown value is not an Error. */
export function error_message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
