/**
 * A confirmation prompt ended without an answer: stdin reached EOF, or the operator pressed
 * Ctrl+C or Ctrl+D at the prompt.
 *
 * Thrown rather than read as "no" so the command fails instead of exiting 0 with its work skipped.
 * Under cron or systemd stdin is often `/dev/null`, and a silent success there is a scheduled job
 * that reports done and did nothing (issue #706). Every prompt runs before the work it guards, so
 * nothing has changed when this is thrown.
 */
export class PromptUnansweredError extends Error {
  constructor() {
    super(
      'No answer was read at the confirmation prompt, so nothing was changed. ' +
        'Pass -y to run without the prompt.',
    );
    this.name = 'PromptUnansweredError';
  }
}
