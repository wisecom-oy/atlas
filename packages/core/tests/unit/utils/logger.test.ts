import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/logger';

const ANSI = /\x1b\[/;

/** Colour env vars `styleText` reads, which turbo and CI both set. */
const COLOUR_ENV = ['FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS'] as const;

describe('logger colour handling', () => {
  let stdout: string[];
  let stderr: string[];

  let colour_env: Record<string, string | undefined>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    colour_env = Object.fromEntries(COLOUR_ENV.map((key) => [key, process.env[key]]));

    const to_stdout = (...args: unknown[]): void => {
      stdout.push(args.join(' '));
    };
    const to_stderr = (...args: unknown[]): void => {
      stderr.push(args.join(' '));
    };

    vi.spyOn(console, 'log').mockImplementation(to_stdout);
    vi.spyOn(console, 'debug').mockImplementation(to_stdout);
    vi.spyOn(console, 'warn').mockImplementation(to_stderr);
    vi.spyOn(console, 'error').mockImplementation(to_stderr);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(colour_env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env['DEBUG'];
  });

  // Vitest pipes stdout and stderr, so this is the redirected-output case: it
  // pins the contract that a redirected log file gets plain text and the same
  // visible glyphs as before. It cannot isolate a dropped `stream` option,
  // because `styleText` defaults that option to `process.stdout`, which is also
  // piped here. The `out`/`err` helpers in logger.ts are what make omitting the
  // stream unrepresentable.
  describe('piped output', () => {
    beforeEach(() => {
      // Turbo sets NO_COLOR. Clearing it leaves the non-TTY stream as the only
      // reason colour is dropped, so these assertions describe piping.
      delete process.env['NO_COLOR'];
      delete process.env['NODE_DISABLE_COLORS'];
    });

    it('emits no ANSI on any level', () => {
      process.env['DEBUG'] = '1';

      logger.info('info line');
      logger.success('success line');
      logger.warn('warn line');
      logger.error('error line');
      logger.debug('debug line');
      logger.banner('Atlas');

      expect(stdout.join('\n')).not.toMatch(ANSI);
      expect(stderr.join('\n')).not.toMatch(ANSI);
    });

    it('keeps the visible text intact', () => {
      logger.info('hello');
      logger.success('done');
      logger.warn('careful');
      logger.error('broken');

      expect(stdout).toEqual(['[*] hello', '[+] done']);
      expect(stderr).toEqual(['[!] careful', '[x] broken']);
    });

    it('renders the banner rule to match the text width', () => {
      logger.banner('Atlas');
      expect(stdout).toEqual(['-----------', '-- Atlas --', '-----------']);
    });
  });

  // Positive control. Without this, the assertions above would still pass if
  // the swap had disabled colour everywhere.
  describe('forced colour', () => {
    beforeEach(() => {
      // FORCE_COLOR overrides NO_COLOR but warns when both are set, so clear it.
      delete process.env['NO_COLOR'];
      delete process.env['NODE_DISABLE_COLORS'];
      process.env['FORCE_COLOR'] = '1';
    });

    it('colours stdout levels', () => {
      logger.info('info line');
      logger.success('success line');
      expect(stdout.join('\n')).toMatch(ANSI);
    });

    it('colours stderr levels', () => {
      logger.warn('warn line');
      logger.error('error line');
      expect(stderr.join('\n')).toMatch(ANSI);
    });

    it('applies both bold and white to the banner text', () => {
      logger.banner('Atlas');
      expect(stdout.join('\n')).toContain('\x1b[1m');
      expect(stdout.join('\n')).toContain('\x1b[37m');
    });
  });
});
