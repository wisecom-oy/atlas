import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { read_prompt_line } from '@/ui/prompt-line-reader';
import { pipe_stdin } from '@wisecom/atlas-types/testing/piped-stdin';

describe('read_prompt_line (issue #706)', () => {
  let restore_stdin: () => void = () => {};

  afterEach(() => restore_stdin());

  it('returns undefined when stdin is at EOF, instead of never settling', async () => {
    restore_stdin = pipe_stdin('');
    await expect(read_prompt_line('Continue? ')).resolves.toBeUndefined();
  });

  it('returns undefined when stdin already ended before the prompt', async () => {
    restore_stdin = pipe_stdin('');
    process.stdin.resume();
    await once(process.stdin, 'end');
    await expect(read_prompt_line('Continue? ')).resolves.toBeUndefined();
  });

  it('returns the answered line', async () => {
    restore_stdin = pipe_stdin('y\n');
    await expect(read_prompt_line('Continue? ')).resolves.toBe('y');
  });

  it('accepts a final line without a trailing newline', async () => {
    restore_stdin = pipe_stdin('y');
    await expect(read_prompt_line('Continue? ')).resolves.toBe('y');
  });

  it('returns an empty answer for a bare Enter, which is not the same as no answer', async () => {
    restore_stdin = pipe_stdin('\n');
    await expect(read_prompt_line('Continue? ')).resolves.toBe('');
  });
});
