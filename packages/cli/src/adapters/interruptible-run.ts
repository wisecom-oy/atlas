import type { Container } from 'inversify';
import { report_run_outcome } from '@/command-run-outcome';
import { install_interrupt_gate, type InterruptGate } from '@/adapters/interrupt-gate';
import { release_throttle_cooldowns_if_cancelled } from '@/adapters/throttle-cooldown-release';

/**
 * Runs a use case under an interrupt gate: the first Ctrl+C aborts the gate's signal, which also
 * ends a Graph retry or throttle wait, and the second exits with 130.
 *
 * The backup and restore services resolve an interrupted result when cancelled. A use case that
 * rejects with the cancellation instead is still reported as an interrupted run with the partial
 * exit code, and resolves undefined, rather than surfacing as a failure. The gate is removed and any throttle
 * cooldown the cancelled run left behind is released in `finally`, so neither keeps the process
 * alive.
 */
export async function run_interruptible<T>(
  container: Container,
  message: string,
  run: (gate: InterruptGate) => Promise<T>,
): Promise<T | undefined> {
  const gate = install_interrupt_gate(message);
  try {
    return await run(gate);
  } catch (err) {
    if (!gate.abort_signal.aborted) throw err;
    report_run_outcome({ errors: [], warnings: [], interrupted: true }, 'item');
    return undefined;
  } finally {
    gate.dispose();
    await release_throttle_cooldowns_if_cancelled(container, gate.abort_signal);
  }
}
