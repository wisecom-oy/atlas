/** Structured fields attached to one log line. */
export type LogFields = Record<string, unknown>;

/**
 * Where Atlas sends its log output.
 *
 * Deliberately the four levels every host logger already has, so a `pino` or
 * `winston` instance satisfies it as-is and an adapter is a few lines at most.
 * There is no `success` or `progress`: the first is an `info`, and the second is
 * terminal cursor control that means nothing to a structured logger.
 */
export interface LogSink {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
