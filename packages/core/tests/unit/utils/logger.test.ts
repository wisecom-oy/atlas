import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../src/utils/logger';
describe('logger', () => {
  describe('piped output (non-TTY)', () => {
    let originalStdoutWrite: typeof process.stdout.write;
    let originalStderrWrite: typeof process.stderr.write;
    let stdoutOutput: string = '';
    let stderrOutput: string = '';

    beforeEach(() => {
      stdoutOutput = '';
      stderrOutput = '';

      // Mock process.stdout and process.stderr for non-TTY
      originalStdoutWrite = process.stdout.write;
      originalStderrWrite = process.stderr.write;

      // Simulate piped output by setting isTTY to false and capturing writes
      Object.defineProperty(process.stdout, 'isTTY', {
        writable: true,
        configurable: true,
        value: false,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        writable: true,
        configurable: true,
        value: false,
      });

      process.stdout.write = ((text: string) => {
        stdoutOutput += text;
        return true;
      }) as any;

      process.stderr.write = ((text: string) => {
        stderrOutput += text;
        return true;
      }) as any;

      // Mock console methods
      vi.spyOn(console, 'log').mockImplementation((args: any) => {
        if (typeof args === 'string') {
          stdoutOutput += args;
        }
      });
      vi.spyOn(console, 'warn').mockImplementation((args: any) => {
        if (typeof args === 'string') {
          stderrOutput += args;
        }
      });
      vi.spyOn(console, 'error').mockImplementation((args: any) => {
        if (typeof args === 'string') {
          stderrOutput += args;
        }
      });
      vi.spyOn(console, 'debug').mockImplementation((args: any) => {
        if (typeof args === 'string') {
          stdoutOutput += args;
        }
      });
    });

    afterEach(() => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      vi.restoreAllMocks();
    });

    it('logs without ANSI codes when piped', () => {
      logger.info('test message');
      expect(console.log).toHaveBeenCalled();

      // Verify no ANSI escape sequences in the logged content
      const logCall = vi.mocked(console.log).mock.calls[0];
      const loggedText = logCall.join('');
      expect(loggedText).not.toMatch(/\x1b\[/);
    });

    it('respects NO_COLOR environment variable', () => {
      const originalNoColor = process.env['NO_COLOR'];
      process.env['NO_COLOR'] = '1';

      try {
        logger.info('test message');
        const logCall = vi.mocked(console.log).mock.calls[0];
        const loggedText = logCall.join('');
        expect(loggedText).not.toMatch(/\x1b\[/);
      } finally {
        if (originalNoColor === undefined) {
          delete process.env['NO_COLOR'];
        } else {
          process.env['NO_COLOR'] = originalNoColor;
        }
      }
    });
  });
});
