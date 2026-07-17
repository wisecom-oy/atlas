import { describe, it, expect, vi } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import { ConfirmPrompt } from '@/ui/components/confirm-prompt';

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
});
