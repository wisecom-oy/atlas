import chalk from 'chalk';

export const logger = {
  info(message: string): void {
    console.log(chalk.blue('[*]'), message);
  },

  success(message: string): void {
    console.log(chalk.green('[+]'), message);
  },

  warn(message: string): void {
    console.warn(chalk.yellow('[!]'), message);
  },

  error(message: string): void {
    console.error(chalk.red('[x]'), message);
  },

  debug(message: string): void {
    if (process.env['DEBUG']) {
      console.debug(chalk.gray('[.]'), chalk.gray(message));
    }
  },

  banner(text: string): void {
    const rule = chalk.cyan('---' + '-'.repeat(text.length) + '---');
    console.log(rule);
    console.log(chalk.cyan('-- ') + chalk.bold.white(text) + chalk.cyan(' --'));
    console.log(rule);
  },

  /** Overwrites the current terminal line in-place (no newline). */
  progress(message: string): void {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${message}\x1b[K`);
    }
  },

  /** Clears the progress line and moves to a new line. */
  progress_done(): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  },
};
