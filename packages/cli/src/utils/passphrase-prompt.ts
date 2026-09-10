import { createInterface, type Interface } from 'node:readline';
import { readFileSync } from 'node:fs';

/**
 * Reads a new passphrase without echoing it, asking twice.
 *
 * Never a flag value: an inline secret lands in the shell history file and is readable in the
 * process table by any other local user while the command runs. Non-interactive stdin is read
 * whole and used as-is, so `atlas keys rewrap --new-passphrase < secret.txt` works in a script
 * without a confirmation round the script cannot answer.
 *
 * @throws Error when the two answers differ, or when the value is empty.
 */
export async function prompt_new_passphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, 'utf-8').replace(/\r?\n$/, '');
    if (piped.length === 0) {
      throw new Error('No passphrase on stdin. Pipe one in, or run the command interactively.');
    }
    return piped;
  }

  const first = await ask_hidden('New passphrase: ');
  if (first.length === 0) throw new Error('The passphrase cannot be empty.');
  const second = await ask_hidden('Repeat the new passphrase: ');
  if (first !== second) throw new Error('The two passphrases do not match; nothing was changed.');
  return first;
}

/** Prompts on a TTY with echo suppressed. */
async function ask_hidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  suppress_echo(rl, prompt);
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    process.stdout.write('\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Swaps readline's writer for one that emits the prompt and nothing else.
 *
 * `terminal: true` echoes every keystroke, which for a passphrase means it is on screen and in
 * the scrollback. Node has no first-class hidden-input mode, and this is the documented way to
 * get one from readline.
 */
function suppress_echo(rl: Interface, prompt: string): void {
  const mutable = rl as unknown as {
    _writeToOutput: (text: string) => void;
    output: NodeJS.WriteStream;
  };
  const output = mutable.output;
  mutable._writeToOutput = (text: string): void => {
    if (text.includes(prompt)) output.write(prompt);
  };
}
