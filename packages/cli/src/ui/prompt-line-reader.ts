import { createInterface } from 'node:readline';

/**
 * Writes `question` and reads one line from stdin, or `undefined` when no line arrives.
 *
 * `undefined` covers stdin at EOF, a stream that had already ended, and Ctrl+C or Ctrl+D on a
 * terminal. Without the `close` handler the pending question never settles, the event loop drains,
 * and the process exits 0 with the rest of the command skipped (issue #706). A final line without
 * a trailing newline still counts as an answer, so `printf y | atlas ...` works.
 */
export async function read_prompt_line(question: string): Promise<string | undefined> {
  if (process.stdin.readableEnded) return undefined;

  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answered = false;
  rl.once('close', () => {
    // Ends the prompt's line so the error that follows does not print after the question.
    if (!answered) process.stdout.write('\n');
    resolve(undefined);
  });
  // A terminal in raw mode delivers Ctrl+C here instead of as a process signal.
  rl.once('SIGINT', () => rl.close());
  // `line` rather than `rl.question`: at EOF readline emits the unterminated last line as a
  // `line` event and never hands it to a pending question callback.
  rl.once('line', (answer) => {
    answered = true;
    resolve(answer);
    rl.close();
  });
  rl.setPrompt(question);
  rl.prompt();
  return await promise;
}
