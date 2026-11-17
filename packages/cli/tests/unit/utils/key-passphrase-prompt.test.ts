import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prompt_key_passphrases } from '@/utils/passphrase-prompt';

/** Issue #716: a scripted rotation pipes the old and the new passphrase, one per line. */

const mocks = vi.hoisted(() => ({ read_file_sync: vi.fn() }));
vi.mock('node:fs', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  readFileSync: mocks.read_file_sync,
}));

let tty: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
});

describe('prompt_key_passphrases on piped stdin', () => {
  it('reads the old passphrase then the new one', async () => {
    mocks.read_file_sync.mockReturnValue('FAKE-old-passphrase-one\nFAKE-new-passphrase-two\n');

    const typed = await prompt_key_passphrases({ old: true, new: true });

    expect(typed).toEqual({ old: 'FAKE-old-passphrase-one', new: 'FAKE-new-passphrase-two' });
  });

  it('refuses stdin that does not hold exactly two lines', async () => {
    mocks.read_file_sync.mockReturnValue('FAKE-only-one-line\n');

    await expect(prompt_key_passphrases({ old: true, new: true })).rejects.toThrow(
      /exactly two non-empty lines/,
    );
  });

  it('reads a single old passphrase whole', async () => {
    mocks.read_file_sync.mockReturnValue('FAKE old passphrase with spaces \n');

    const typed = await prompt_key_passphrases({ old: true, new: false });

    expect(typed).toEqual({ old: 'FAKE old passphrase with spaces ' });
  });

  it('asks for nothing when neither flag is given', async () => {
    expect(await prompt_key_passphrases({ old: false, new: false })).toEqual({});
    expect(mocks.read_file_sync).not.toHaveBeenCalled();
  });
});
