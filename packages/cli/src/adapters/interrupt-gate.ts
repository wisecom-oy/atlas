import { logger } from '@wisecom/atlas-core';

export interface InterruptGate {
  /** Passed to a use case as `should_interrupt`. */
  readonly should_interrupt: () => boolean;
  /** Aborts on the first Ctrl+C, so in-flight Graph waits stop rather than running to their timeout. */
  readonly abort_signal: AbortSignal;
  /** Removes the SIGINT listener. Always call it, in a `finally`. */
  readonly dispose: () => void;
}

/**
 * Turns Ctrl+C into a soft stop for a long-running command.
 *
 * Without one, the process dies wherever the signal lands, with exit 130 and no interrupted
 * state recorded. The drive backups had no interrupt flag at all, so a stopped run was
 * indistinguishable from a crash, while the Outlook backup has always stopped gracefully
 * (issue #367).
 *
 * A second Ctrl+C exits at once with 130, so an operator can always force the issue. The listener
 * stays installed for the whole run, which suppresses Node's default SIGINT exit, so the gate must
 * exit itself.
 *
 * `message` is plain text: the gate logs it with `logger.warn`, which adds the `[!]` marker, so a
 * message that carries its own prints it twice (issue #692).
 */
export function install_interrupt_gate(message: string): InterruptGate {
  let interrupted = false;
  const controller = new AbortController();

  const on_sigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    logger.warn(message);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
  };

  process.on('SIGINT', on_sigint);

  return {
    should_interrupt: () => interrupted,
    abort_signal: controller.signal,
    dispose: () => process.removeListener('SIGINT', on_sigint),
  };
}
