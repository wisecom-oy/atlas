import { afterEach, describe, it, expect, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { pipe_stdin } from '@wisecom/atlas-types/testing/piped-stdin';
import { ConfirmPrompt, ask_confirmation, ask_exact_match } from '@/ui/components/confirm-prompt';
import { PromptUnansweredError } from '@/ui/prompt-unanswered-error';

describe('ConfirmPrompt', () => {
  it('shows the default marker in the hint', () => {
    const { lastFrame } = render(
      <ConfirmPrompt message="Continue?" default_yes={false} on_answer={() => {}} />,
    );
    expect(lastFrame()).toContain('Continue? [y/N]');
  });

  it.each([
    ['y', true],
    ['n', false],
  ])('resolves %s keypress to %s', async (key, expected) => {
    const on_answer = vi.fn();
    const { stdin } = render(
      <ConfirmPrompt message="Overwrite?" default_yes={true} on_answer={on_answer} />,
    );
    await sleep(0);
    stdin.write(key);
    expect(on_answer).toHaveBeenCalledWith(expected);
  });

  it('resolves Enter to the default', async () => {
    const on_answer = vi.fn();
    const { stdin } = render(
      <ConfirmPrompt message="Overwrite?" default_yes={true} on_answer={on_answer} />,
    );
    await sleep(0);
    stdin.write('\r');
    expect(on_answer).toHaveBeenCalledWith(true);
  });

  it.each([
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
  ])('reports no answer on %s instead of ignoring it', async (_name, key) => {
    // Raw mode swallowed both, so the only way out of the prompt was to answer it (issue #706).
    const on_answer = vi.fn();
    const { stdin } = render(
      <ConfirmPrompt message="Continue?" default_yes={false} on_answer={on_answer} />,
    );
    await sleep(0);
    stdin.write(key);
    expect(on_answer).toHaveBeenCalledWith(undefined);
  });
});

describe('prompts on piped stdin', () => {
  let restore_stdin: () => void = () => {};

  afterEach(() => restore_stdin());

  it.each([
    ['y\n', true],
    ['n\n', false],
    ['\n', true],
  ])('ask_confirmation reads %j as %s', async (input, expected) => {
    restore_stdin = pipe_stdin(input);
    await expect(ask_confirmation('Overwrite?', true)).resolves.toBe(expected);
  });

  it('ask_confirmation throws rather than settling on a default at EOF', async () => {
    restore_stdin = pipe_stdin('');
    await expect(ask_confirmation('Overwrite?', true)).rejects.toBeInstanceOf(
      PromptUnansweredError,
    );
  });

  it('ask_exact_match compares the typed value', async () => {
    restore_stdin = pipe_stdin('tenant-1 \n');
    await expect(ask_exact_match('Type it:', 'tenant-1')).resolves.toBe(true);
  });

  it('ask_exact_match throws at EOF', async () => {
    restore_stdin = pipe_stdin('');
    await expect(ask_exact_match('Type it:', 'tenant-1')).rejects.toBeInstanceOf(
      PromptUnansweredError,
    );
  });
});
