/** Returns the message of an unknown thrown value. */
export function error_message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
