import { readFileSync } from 'node:fs';

/** Option value that means "read the real value from stdin". */
const STDIN_SENTINEL = '-';

/**
 * Resolves a credential option, reading stdin when the value is `-`.
 *
 * A secret passed inline is written to the shell history file and is readable in
 * the process table by any other local user for as long as the command runs,
 * which for a replication run over a large tenant is not a short window. `-`
 * keeps it out of both. Mirrors the `-` form `atlas config` already accepts.
 *
 * Only one option per invocation can read stdin, which is why `-` is offered on
 * the secret key rather than on the access key ID, which is not a secret.
 */
export function resolve_secret_option(
  value: string | undefined,
  option: string,
): string | undefined {
  if (value !== STDIN_SENTINEL) return value;

  const from_stdin = read_stdin_or_throw(option);
  if (from_stdin.length === 0) {
    throw new Error(
      `${option} was given "-", which reads the value from stdin, but stdin was empty. ` +
        `Pipe the secret in, for example: ${option} - < secret.txt`,
    );
  }
  return from_stdin;
}

/** Reads all of stdin, failing loudly rather than yielding an empty secret. */
function read_stdin_or_throw(option: string): string {
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch (err) {
    // Closed or unreadable stdin lands here (EBADF, EAGAIN). Silently treating it
    // as an empty value would authenticate with an empty secret.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${option} was given "-", which reads the value from stdin, but stdin could not be read: ${reason}`,
    );
  }
}
