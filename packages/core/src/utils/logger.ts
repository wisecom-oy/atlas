import { styleText } from 'node:util';
import { active_log_scope } from './log-context';

/**
 * Atlas log output.
 *
 * With no log scope active this is the console writer it has always been, which
 * is what the CLI wants. When a host installs a sink (`createAtlasInstance({
 * logger })`), every line below is routed there instead and nothing reaches the
 * host's stdout. See `log-context.ts` and issue #41.
 */
export const logger = {
  info(message: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.info(message, scope.fields);
    console.log(styleText('blue', '[*]', { stream: process.stdout }), message);
  },

  success(message: string): void {
    const scope = active_log_scope();
    // A sink has no notion of success; it is an info line that the terminal
    // happens to render in green.
    if (scope) return scope.sink.info(message, scope.fields);
    console.log(styleText('green', '[+]', { stream: process.stdout }), message);
  },

  warn(message: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.warn(message, scope.fields);
    console.warn(styleText('yellow', '[!]', { stream: process.stderr }), message);
  },

  error(message: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.error(message, scope.fields);
    console.error(styleText('red', '[x]', { stream: process.stderr }), message);
  },

  debug(message: string): void {
    const scope = active_log_scope();
    // The sink decides its own level. Gating on DEBUG here would hide debug
    // lines from a host that asked for them.
    if (scope) return scope.sink.debug(message, scope.fields);
    if (process.env['DEBUG']) {
      console.debug(
        styleText('gray', '[.]', { stream: process.stdout }),
        styleText('gray', message, { stream: process.stdout }),
      );
    }
  },

  banner(text: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.info(text, scope.fields);
    const rule = styleText('cyan', '---' + '-'.repeat(text.length) + '---', {
      stream: process.stdout,
    });
    console.log(rule);
    console.log(
      styleText('cyan', '-- ', { stream: process.stdout }) +
        styleText(['bold', 'white'], text, { stream: process.stdout }) +
        styleText('cyan', ' --', { stream: process.stdout }),
    );
    console.log(rule);
  },

  /**
   * Overwrites the current terminal line in-place (no newline).
   *
   * Dropped entirely when a sink is installed: this writes raw cursor control
   * (`\r`, `\x1b[K`) and a progress line has no meaning as a log record. A host
   * that wants progress reads the typed progress events instead.
   */
  progress(message: string): void {
    if (active_log_scope()) return;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${message}\x1b[K`);
    }
  },

  /** Clears the progress line and moves to a new line. */
  progress_done(): void {
    if (active_log_scope()) return;
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  },
};
