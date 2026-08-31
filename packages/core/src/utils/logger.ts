import chalk from 'chalk';
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
    console.log(chalk.blue('[*]'), message);
  },

  success(message: string): void {
    const scope = active_log_scope();
    // A sink has no notion of success; it is an info line that the terminal
    // happens to render in green.
    if (scope) return scope.sink.info(message, scope.fields);
    console.log(chalk.green('[+]'), message);
  },

  warn(message: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.warn(message, scope.fields);
    console.warn(chalk.yellow('[!]'), message);
  },

  error(message: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.error(message, scope.fields);
    console.error(chalk.red('[x]'), message);
  },

  debug(message: string): void {
    const scope = active_log_scope();
    // The sink decides its own level. Gating on DEBUG here would hide debug
    // lines from a host that asked for them.
    if (scope) return scope.sink.debug(message, scope.fields);
    if (process.env['DEBUG']) {
      console.debug(chalk.gray('[.]'), chalk.gray(message));
    }
  },

  banner(text: string): void {
    const scope = active_log_scope();
    if (scope) return scope.sink.info(text, scope.fields);
    const rule = chalk.cyan('---' + '-'.repeat(text.length) + '---');
    console.log(rule);
    console.log(chalk.cyan('-- ') + chalk.bold.white(text) + chalk.cyan(' --'));
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
