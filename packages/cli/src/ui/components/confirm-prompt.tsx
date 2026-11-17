import { Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { PromptUnansweredError } from '@/ui/prompt-unanswered-error';
import { read_prompt_line } from '@/ui/prompt-line-reader';
import { mount_live_view } from '@/ui/render';

interface ConfirmPromptProps {
  message: string;
  default_yes: boolean;
  /** Receives the answer, or `undefined` when the operator pressed Ctrl+C or Ctrl+D. */
  on_answer: (confirmed: boolean | undefined) => void;
}

/** Single-keypress Y/n prompt; Enter accepts the default, Ctrl+C or Ctrl+D gives no answer. */
export function ConfirmPrompt({
  message,
  default_yes,
  on_answer,
}: ConfirmPromptProps): ReactElement {
  useInput((input, key) => {
    // Raw mode turns Ctrl+C and Ctrl+D into keypresses, so without this neither leaves the prompt.
    if (key.ctrl && (input === 'c' || input === 'd')) on_answer(undefined);
    else if (key.return) on_answer(default_yes);
    else if (input.toLowerCase() === 'y') on_answer(true);
    else if (input.toLowerCase() === 'n') on_answer(false);
  });

  return (
    <Text color="yellow">
      {message} {yes_no_hint(default_yes)}{' '}
    </Text>
  );
}

/**
 * Asks a yes/no question. Interactive terminals get a single-keypress Ink
 * prompt; piped stdin falls back to readline so scripted `echo y |` flows
 * keep working. Non-'y'/'n' answers resolve to the default.
 *
 * @throws PromptUnansweredError when stdin ends, or Ctrl+C or Ctrl+D is pressed, before an answer.
 */
export async function ask_confirmation(message: string, default_yes = false): Promise<boolean> {
  const confirmed = process.stdin.isTTY
    ? await read_keypress_answer(message, default_yes)
    : await read_line_answer(message, default_yes);
  if (confirmed === undefined) throw new PromptUnansweredError();
  return confirmed;
}

/**
 * Asks the operator to type a value back and reports whether it matched exactly.
 *
 * Readline on a TTY as well as on piped stdin: a typed answer needs echo and line editing, which
 * the single-keypress Ink prompt above deliberately does not provide. Trailing whitespace is
 * forgiven because terminals and `echo` add it; nothing else is.
 *
 * @throws PromptUnansweredError when stdin ends, or Ctrl+C or Ctrl+D is pressed, before an answer.
 */
export async function ask_exact_match(message: string, expected: string): Promise<boolean> {
  const answer = await read_prompt_line(`${message} `);
  if (answer === undefined) throw new PromptUnansweredError();
  return answer.trim() === expected;
}

async function read_keypress_answer(
  message: string,
  default_yes: boolean,
): Promise<boolean | undefined> {
  const { promise, resolve } = Promise.withResolvers<boolean | undefined>();
  const instance = mount_live_view(
    <ConfirmPrompt message={message} default_yes={default_yes} on_answer={resolve} />,
  );
  const confirmed = await promise;
  instance.unmount();
  return confirmed;
}

async function read_line_answer(
  message: string,
  default_yes: boolean,
): Promise<boolean | undefined> {
  const answer = await read_prompt_line(`${message} ${yes_no_hint(default_yes)} `);
  if (answer === undefined) return undefined;
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'y') return true;
  if (normalized === 'n') return false;
  return default_yes;
}

function yes_no_hint(default_yes: boolean): string {
  return default_yes ? '[Y/n]' : '[y/N]';
}
