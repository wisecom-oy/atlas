import { logger } from '@wisecom/atlas-core';

/** A general failure: the command did not finish, and nothing says a rerun is safe to skip. */
const UNSETTLED_COMMAND_EXIT_CODE = 1;

/**
 * Turns an exit with `command` still pending into a failure instead of exit 0.
 *
 * Node exits once nothing is left to wait on, and a pending promise is not something it waits on.
 * A command parked on a promise that only an unref'd timer would resolve ends right there, with no
 * output and nothing committed, and `process.exitCode` still unset (issue #859). A scheduler would
 * record that as a successful backup. `beforeExit` fires exactly when that happens, so this fails
 * the process loudly whatever left the command parked.
 */
export function fail_exit_while_command_pending(command: Promise<unknown>): void {
  let settled = false;
  const mark_settled = (): void => {
    settled = true;
  };
  command.then(mark_settled, mark_settled);
  process.once('beforeExit', () => {
    if (settled) return;
    process.exitCode = UNSETTLED_COMMAND_EXIT_CODE;
    logger.error(
      'Atlas stopped before the command finished: it was waiting on something nothing would ' +
        'complete. Work not yet committed was not saved. This is an Atlas defect; please report it.',
    );
  });
}
