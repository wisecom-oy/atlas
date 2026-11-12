import { PassThrough } from 'node:stream';

/**
 * Swaps `process.stdin` for a non-TTY stream that delivers `input` and then ends, as a cron job,
 * a pipe, or `< /dev/null` would, and silences stdout so prompt text stays out of the test
 * output. Returns the function that puts both back, for `afterEach`.
 */
export function pipe_stdin(input: string): () => void {
  const original_stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const original_write = process.stdout.write;
  const stream = new PassThrough();
  stream.end(input);
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  // Ink waits for the write callback before a render settles, so it must still be called.
  process.stdout.write = (_chunk: unknown, ...rest: unknown[]): boolean => {
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  };

  return () => {
    process.stdout.write = original_write;
    if (original_stdin) Object.defineProperty(process, 'stdin', original_stdin);
  };
}
