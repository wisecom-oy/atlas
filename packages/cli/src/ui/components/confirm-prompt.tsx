import { createInterface } from 'node:readline';
import { Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { mount_live_view } from '@/ui/render';

interface ConfirmPromptProps {
  message: string;
  default_yes: boolean;
  on_answer: (confirmed: boolean) => void;
}

/** Single-keypress Y/n prompt; Enter accepts the default. */
export function ConfirmPrompt({
  message,
  default_yes,
  on_answer,
}: ConfirmPromptProps): ReactElement {
  useInput((input, key) => {
    if (key.return) on_answer(default_yes);
    else if (input.toLowerCase() === 'y') on_answer(true);
    else if (input.toLowerCase() === 'n') on_answer(false);
  });

  return (
    <Text color="yellow">
      {message} {default_yes ? '[Y/n]' : '[y/N]'}{' '}
    </Text>
  );
}

/**
 * Asks a yes/no question. Interactive terminals get a single-keypress Ink
 * prompt; piped stdin falls back to readline so scripted `echo y |` flows
 * keep working. Non-'y'/'n' answers resolve to the default.
 */
export async function ask_confirmation(message: string, default_yes = false): Promise<boolean> {
  if (!process.stdin.isTTY) {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} ${default_yes ? '[Y/n]' : '[y/N]'} `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y') resolve(true);
      else if (normalized === 'n') resolve(false);
      else resolve(default_yes);
    });
    return promise;
  }

  const { promise, resolve } = Promise.withResolvers<boolean>();
  const instance = mount_live_view(
    <ConfirmPrompt message={message} default_yes={default_yes} on_answer={resolve} />,
  );
  const confirmed = await promise;
  instance.unmount();
  return confirmed;
}
