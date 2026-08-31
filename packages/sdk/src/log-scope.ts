import {
  run_with_log_scope,
  SILENT_LOG_SINK,
  type LogScope,
} from '@wisecom/atlas-core/utils/log-context';
import type { LogSink } from '@wisecom/atlas-types';

/**
 * Wraps every method of an SDK namespace so its log output is routed and tagged.
 *
 * Applied once per namespace at construction rather than per method, so a new
 * SDK method is covered by existing code instead of needing to remember this.
 * Methods are closures over their factory, never `this`, so rebinding them is
 * safe (issue #41).
 */
export function scope_api_logging<T extends object>(api: T, tenant_id: string, sink: LogSink): T {
  const scoped: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      scoped[name] = value;
      continue;
    }
    const scope: LogScope = { sink, fields: { tenant_id, operation: name } };
    scoped[name] = (...args: unknown[]): unknown =>
      run_with_log_scope(scope, () => (value as (...a: unknown[]) => unknown)(...args));
  }

  return scoped as T;
}

/** The sink an instance uses: the host's, or silence. */
export function resolve_log_sink(logger: LogSink | undefined): LogSink {
  return logger ?? SILENT_LOG_SINK;
}
