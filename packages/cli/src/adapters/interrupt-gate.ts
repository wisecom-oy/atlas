import { logger } from '@wisecom/atlas-core';

export interface InterruptGate {
  /** Passed to a use case as `should_interrupt`. */
  readonly should_interrupt: () => boolean;
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
 * A second Ctrl+C is left to the default handler, so an operator can always force the issue.
 */
export function install_interrupt_gate(message: string): InterruptGate {
  let interrupted = false;

  const on_sigint = (): void => {
    if (interrupted) return;
    interrupted = true;
    logger.warn(message);
  };

  process.on('SIGINT', on_sigint);

  return {
    should_interrupt: () => interrupted,
    dispose: () => process.removeListener('SIGINT', on_sigint),
  };
}
