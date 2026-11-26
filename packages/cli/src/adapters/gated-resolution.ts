import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type { InterruptGate } from '@/adapters/interrupt-gate';

/**
 * Runs the lookup a backup makes before its run starts (the owner, the site, or the teams to back
 * up) under the command's interrupt gate, so a first Ctrl+C there is the same soft stop as during
 * the run (issue #876).
 *
 * The gate's signal is published to the Graph calls inside `resolve`, so a token request, a request
 * in flight, or a retry wait ends at once. The lookup is also raced against the signal, so a step
 * that does not listen to it, such as the identity registry read from storage, cannot hold the
 * command. A Ctrl+C that lands just after the lookup finished still stops the command here, before
 * the run takes the owner's lease.
 *
 * @throws the gate's abort reason once the first Ctrl+C has fired.
 */
export async function resolve_under_gate<T>(
  gate: InterruptGate,
  resolve: () => Promise<T>,
): Promise<T> {
  throw_if_interrupted(gate.abort_signal);
  const resolved = await race_interrupt(
    run_with_abort_signal(gate.abort_signal, resolve),
    gate.abort_signal,
  );
  throw_if_interrupted(gate.abort_signal);
  return resolved;
}

/** Settles like `lookup`, or rejects with the signal's reason as soon as it fires. */
async function race_interrupt<T>(lookup: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  const on_abort = (): void => reject(signal.reason);
  signal.addEventListener('abort', on_abort, { once: true });
  try {
    return await Promise.race([lookup, interrupted]);
  } finally {
    signal.removeEventListener('abort', on_abort);
  }
}

/** Throws the signal's reason when the first Ctrl+C has already fired. */
function throw_if_interrupted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
