import type { ObjectStorage } from '@atlas/types';
import { logger } from '@/utils/logger';

const EMAIL_PATTERN = /^[^@]+@[^@]+\.[^@]+$/;

const PREFIXES_TO_MIGRATE = ['manifests', 'data', 'attachments'] as const;

/** Email → Entra object ID mapping for a single tenant owner. */
export interface MigrationMapping {
  readonly email: string;
  readonly object_id: string;
}

/** Options for {@link migrate_owner_id_prefixes}. */
export interface MigrationOptions {
  readonly dry_run?: boolean;
}

/** Aggregate outcome of an owner-ID prefix migration run. */
export interface MigrationResult {
  readonly keys_scanned: number;
  readonly keys_migrated: number;
  readonly keys_failed: number;
  readonly errors: string[];
}

/**
 * Migrates S3 keys from email-based owner paths to object-ID-based paths.
 * Uses copy+delete since S3 does not support rename.
 */
export async function migrate_owner_id_prefixes(
  storage: ObjectStorage,
  mappings: MigrationMapping[],
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const dry_run = options.dry_run ?? false;
  let keys_scanned = 0;
  let keys_migrated = 0;
  let keys_failed = 0;
  const errors: string[] = [];

  const email_to_id = new Map(mappings.map((m) => [m.email.toLowerCase(), m.object_id]));

  for (const prefix of PREFIXES_TO_MIGRATE) {
    const all_keys = await storage.list(`${prefix}/`);
    keys_scanned += all_keys.length;

    for (const key of all_keys) {
      const new_key = resolve_migration_key(key, email_to_id);
      if (!new_key) continue;

      const result = await migrate_single_key(storage, key, new_key, dry_run);
      if (result.error) {
        keys_failed++;
        errors.push(result.error);
      } else {
        keys_migrated++;
      }
    }
  }

  return { keys_scanned, keys_migrated, keys_failed, errors };
}

function resolve_migration_key(key: string, email_to_id: Map<string, string>): string | undefined {
  const segments = key.split('/');
  if (segments.length < 2) return undefined;

  const owner_segment = segments[1];
  if (!owner_segment || !EMAIL_PATTERN.test(owner_segment)) return undefined;

  const object_id = email_to_id.get(owner_segment.toLowerCase());
  if (!object_id) return undefined;

  return [segments[0], object_id, ...segments.slice(2)].join('/');
}

async function migrate_single_key(
  storage: ObjectStorage,
  old_key: string,
  new_key: string,
  dry_run: boolean,
): Promise<{ error?: string }> {
  if (dry_run) {
    logger.info(`[DRY RUN] Would migrate: ${old_key} -> ${new_key}`);
    return {};
  }

  try {
    await storage.copy(old_key, new_key);
    await storage.delete(old_key);
    logger.info(`Migrated: ${old_key} -> ${new_key}`);
    return {};
  } catch (err) {
    const msg = `Failed to migrate ${old_key}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(msg);
    return { error: msg };
  }
}

/**
 * Checks if any legacy email-based paths still exist under the storage prefixes.
 * Useful for determining if migration is needed.
 */
export async function detect_legacy_email_paths(storage: ObjectStorage): Promise<string[]> {
  const legacy_emails: Set<string> = new Set();

  for (const prefix of PREFIXES_TO_MIGRATE) {
    const keys = await storage.list(`${prefix}/`);
    for (const key of keys) {
      const segments = key.split('/');
      const owner_segment = segments[1];
      if (segments.length >= 2 && owner_segment && EMAIL_PATTERN.test(owner_segment)) {
        legacy_emails.add(owner_segment.toLowerCase());
      }
    }
  }

  return [...legacy_emails];
}

/**
 * Fallback resolver: checks both object-ID and email-based paths.
 * Returns the key that actually exists, preferring the new object-ID path.
 */
export async function resolve_key_with_fallback(
  storage: ObjectStorage,
  new_key: string,
  legacy_key: string,
): Promise<string | undefined> {
  if (await storage.exists(new_key)) return new_key;
  if (await storage.exists(legacy_key)) return legacy_key;
  return undefined;
}
