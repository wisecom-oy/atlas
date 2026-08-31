/**
 * AsyncLocalStorage-based routing for Atlas log output.
 *
 * The core `logger` is imported as a module global by roughly 70 files and
 * called from over 700 sites. Threading a logger parameter through all of them
 * would be a rewrite; publishing the sink on the async context reaches every one
 * of those call sites without touching any of them, and matches how Graph cost
 * tracking already carries per-operation state (`graph-request-context.ts`).
 *
 * No scope active means no host has asked for anything, which is the CLI: the
 * logger keeps writing chalk lines to the console exactly as before.
 *
 * @see issue #41
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogFields, LogSink } from '@wisecom/atlas-types';

export interface LogScope {
  readonly sink: LogSink;
  /** Attached to every line, so one process can serve many tenants readably. */
  readonly fields?: LogFields;
}

const _scope = new AsyncLocalStorage<LogScope>();

/** Runs `fn` with every Atlas log line inside it routed to `scope.sink`. */
export function run_with_log_scope<T>(scope: LogScope, fn: () => T): T {
  return _scope.run(scope, fn);
}

/** The log scope active in the current async context, if a host installed one. */
export function active_log_scope(): LogScope | undefined {
  return _scope.getStore();
}

/**
 * Discards everything. The SDK default, so an embedded Atlas writes nothing to
 * the host's stdout unless the host asks for output.
 */
export const SILENT_LOG_SINK: LogSink = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};
