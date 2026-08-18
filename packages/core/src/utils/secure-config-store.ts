import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { AtlasConfig } from '@/utils/config';
import { logger } from '@/utils/logger';

const CONFIG_FILE = 'config.enc';
const FALLBACK_KEY_FILE = 'config.key';
const KEYRING_SERVICE = 'atlas-cli';
const KEYRING_ACCOUNT = 'config-key';
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export type KeyringBackend = 'keychain' | 'secret-tool' | 'file';

export interface SecureStoreOptions {
  /** Directory holding config.enc; defaults to ~/.atlas. */
  readonly base_dir?: string;
  /** Forces a key backend; defaults to platform auto-detection. */
  readonly keyring?: KeyringBackend;
}

/** Resolves the directory that holds the encrypted config store. */
export function secure_config_dir(options: SecureStoreOptions = {}): string {
  return options.base_dir ?? join(homedir(), '.atlas');
}

/**
 * Reads the encrypted config store and returns its values.
 * Returns an empty object when no store exists (never touches the keyring
 * in that case, so read-only CLI runs stay exec-free).
 */
export function read_secure_config(options: SecureStoreOptions = {}): Partial<AtlasConfig> {
  const file_path = join(secure_config_dir(options), CONFIG_FILE);
  if (!existsSync(file_path)) return {};

  const key = load_store_key(options, false);
  if (key === undefined) {
    throw new Error(
      `Secure config store ${file_path} exists but its encryption key was not found ` +
        `in the OS keyring. Restore the key or delete the store and re-run "atlas config".`,
    );
  }

  const plaintext = decrypt_store(readFileSync(file_path), key, file_path);
  return JSON.parse(plaintext.toString('utf-8')) as Partial<AtlasConfig>;
}

/** Encrypts and persists the full set of stored config values. */
export function write_secure_config(
  values: Partial<AtlasConfig>,
  options: SecureStoreOptions = {},
): void {
  const dir = secure_config_dir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const key = load_store_key(options, true);
  if (key === undefined) {
    throw new Error('Failed to obtain an encryption key for the secure config store.');
  }

  const file_path = join(dir, CONFIG_FILE);
  if (Object.keys(values).length === 0) {
    if (existsSync(file_path)) unlinkSync(file_path);
    return;
  }

  const ciphertext = encrypt_store(Buffer.from(JSON.stringify(values), 'utf-8'), key);
  writeFileSync(file_path, ciphertext, { mode: 0o600 });
  chmodSync(file_path, 0o600); // mode above only applies on create; enforce on rewrite
}

/** Detects which key backend this platform supports. */
export function detect_keyring_backend(): KeyringBackend {
  if (platform() === 'darwin') return 'keychain';
  if (platform() === 'linux' && has_binary('secret-tool')) return 'secret-tool';
  return 'file';
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/** Loads the 32-byte store key, generating and persisting one when allowed. */
function load_store_key(options: SecureStoreOptions, create: boolean): Buffer | undefined {
  const backend = options.keyring ?? detect_keyring_backend();
  const existing = keyring_get(backend, options);
  if (existing !== undefined) return existing;
  if (!create) return undefined;

  const key = randomBytes(32);
  keyring_set(backend, key, options);
  return key;
}

/** Reads the store key from the given backend, or undefined when absent. */
function keyring_get(backend: KeyringBackend, options: SecureStoreOptions): Buffer | undefined {
  switch (backend) {
    case 'keychain':
      return exec_keyring([
        'security',
        'find-generic-password',
        '-s',
        KEYRING_SERVICE,
        '-a',
        KEYRING_ACCOUNT,
        '-w',
      ]);
    case 'secret-tool':
      return exec_keyring([
        'secret-tool',
        'lookup',
        'service',
        KEYRING_SERVICE,
        'account',
        KEYRING_ACCOUNT,
      ]);
    case 'file': {
      const key_path = join(secure_config_dir(options), FALLBACK_KEY_FILE);
      return existsSync(key_path)
        ? Buffer.from(readFileSync(key_path, 'utf-8').trim(), 'hex')
        : undefined;
    }
  }
}

/** Persists the store key into the given backend. */
function keyring_set(backend: KeyringBackend, key: Buffer, options: SecureStoreOptions): void {
  const hex = key.toString('hex');
  switch (backend) {
    case 'keychain':
      // -U updates in place. The key transits argv for one exec; it is the
      // store key, not a stored secret, and only during one-time setup.
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w', hex],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      return;
    case 'secret-tool':
      execFileSync(
        'secret-tool',
        [
          'store',
          '--label=Atlas CLI config key',
          'service',
          KEYRING_SERVICE,
          'account',
          KEYRING_ACCOUNT,
        ],
        { input: hex, stdio: ['pipe', 'ignore', 'ignore'] },
      );
      return;
    case 'file': {
      const dir = secure_config_dir(options);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key_path = join(dir, FALLBACK_KEY_FILE);
      writeFileSync(key_path, hex, { mode: 0o600 });
      logger.warn(
        `No OS keyring available -- store key written to ${key_path} (mode 0600). ` +
          'Anything that can read this file can decrypt the config store.',
      );
      return;
    }
  }
}

/** Runs a keyring lookup command, returning undefined when the entry is absent. */
function exec_keyring(argv: string[]): Buffer | undefined {
  const [cmd, ...args] = argv;
  try {
    const output = execFileSync(cmd as string, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? Buffer.from(output, 'hex') : undefined;
  } catch {
    return undefined;
  }
}

/** Checks whether a binary is resolvable on PATH. */
function has_binary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM file layout: [iv(12)][auth_tag(16)][ciphertext]
// ---------------------------------------------------------------------------

/** Encrypts the store payload with AES-256-GCM. */
function encrypt_store(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts the store payload, failing loudly on tamper or key mismatch. */
function decrypt_store(data: Buffer, key: Buffer, file_path: string): Buffer {
  if (data.length < GCM_IV_LENGTH + GCM_TAG_LENGTH) {
    throw new Error(`Secure config store ${file_path} is truncated or corrupt.`);
  }
  const iv = data.subarray(0, GCM_IV_LENGTH);
  const tag = data.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = data.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      `Failed to decrypt ${file_path}: wrong key or tampered file. ` +
        'Delete the store and re-run "atlas config" to rebuild it.',
    );
  }
}
