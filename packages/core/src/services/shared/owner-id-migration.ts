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
      const segments = key.split('/');
      if (segments.length < 2) continue;

      const owner_segment = segments[1];
      if (!owner_segment || !EMAIL_PATTERN.test(owner_segment)) continue;

      const object_id = email_to_id.get(owner_segment.toLowerCase());
      if (!object_id) continue;

      const new_key = [segments[0], object_id, ...segments.slice(2)].join('/');

      if (dry_run) {
        logger.info(`[DRY RUN] Would migrate: ${key} -> ${new_key}`);
        keys_migrated++;
        continue;
      }

      try {
        await storage.copy(key, new_key);
        await storage.delete(key);
        keys_migrated++;
        logger.info(`Migrated: ${key} -> ${new_key}`);
      } catch (err) {
        keys_failed++;
        const msg = `Failed to migrate ${key}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error(msg);
      }
    }
  }

  return { keys_scanned, keys_migrated, keys_failed, errors };
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
