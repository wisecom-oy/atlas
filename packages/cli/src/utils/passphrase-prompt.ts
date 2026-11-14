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

/** The passphrases a key command asked for. Each is present only when its flag was given. */
export interface KeyCommandPassphrases {
  readonly old?: string;
  readonly new?: string;
}

/**
 * Reads the old passphrase, the new one, or both, without echo.
 *
 * A terminal asks for each in turn: the old one once, since a typo there only fails to open
 * anything, and the new one twice. Piped stdin with one flag is read whole, as
 * {@link prompt_new_passphrase} does. Piped stdin with both flags must hold exactly two lines,
 * the old passphrase first.
 *
 * @throws Error when an answer is empty, the two new answers differ, or piped stdin does not
 *   hold one line per requested passphrase.
 */
export async function prompt_key_passphrases(wanted: {
  readonly old: boolean;
  readonly new: boolean;
}): Promise<KeyCommandPassphrases> {
  if (!wanted.old && !wanted.new) return {};
  if (!process.stdin.isTTY && wanted.old && wanted.new) return read_two_piped_passphrases();
  const old_passphrase = wanted.old ? await prompt_old_passphrase() : undefined;
  const new_passphrase = wanted.new ? await prompt_new_passphrase() : undefined;
  return {
    ...(old_passphrase !== undefined ? { old: old_passphrase } : {}),
    ...(new_passphrase !== undefined ? { new: new_passphrase } : {}),
  };
}

/** Reads the passphrase the stored keys are still wrapped under, once. */
async function prompt_old_passphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, 'utf-8').replace(/\r?\n$/, '');
    if (piped.length === 0) {
      throw new Error('No old passphrase on stdin. Pipe one in, or run the command interactively.');
    }
    return piped;
  }
  const answer = await ask_hidden('Old passphrase: ');
  if (answer.length === 0) throw new Error('The old passphrase cannot be empty.');
  return answer;
}

/** Splits piped stdin into the old passphrase and the new one, one per line. */
function read_two_piped_passphrases(): KeyCommandPassphrases {
  const lines = readFileSync(0, 'utf-8')
    .replace(/\r?\n$/, '')
    .split(/\r?\n/);
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
    throw new Error(
      'With --old-passphrase and --new-passphrase, stdin must hold exactly two non-empty lines: ' +
        'the old passphrase, then the new one. Nothing was changed.',
    );
  }
  return { old: lines[0]!, new: lines[1]! };
}

/** Prompts on a TTY with echo suppressed. */
async function ask_hidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  suppress_echo(rl, prompt);
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    process.stdout.write('\n');
    // Not trimmed. readline already excludes the newline, so what is left is what was typed, and
    // a passphrase with a leading or trailing space is a passphrase. Trimming it here would wrap
    // the key with a value the operator cannot reproduce from their password manager.
    return answer;
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
