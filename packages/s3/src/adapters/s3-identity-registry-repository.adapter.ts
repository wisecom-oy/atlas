import { injectable } from 'inversify';
import type {
  IdentityRegistry,
  IdentityRegistryMutation,
  IdentityRegistryRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import {
  load_encrypted_json,
  load_encrypted_json_with_etag,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';

const REGISTRY_KEY = 'identity-registry.json';

/** Compare-and-swap attempts before giving up on a registry that keeps changing underneath. */
export const REGISTRY_UPDATE_ATTEMPTS = 8;
const RETRY_BASE_MS = 50;
const RETRY_JITTER_MS = 200;

/**
 * Stores the tenant identity registry as a single encrypted JSON object in S3.
 * Key layout: identity-registry.json (tenant-level, no owner prefix).
 *
 * Every write is conditional: on the ETag it was read at, or create-only when no registry exists
 * yet. Several backups of one tenant running at once each register the users they touch, and a
 * blind overwrite would keep only the last writer's list.
 */
@injectable()
export class S3IdentityRegistryRepository implements IdentityRegistryRepository {
  /** Loads the registry; undefined only if none exists, throws if it exists and cannot be read. */
  async load(ctx: TenantContext): Promise<IdentityRegistry | undefined> {
    return load_encrypted_json<IdentityRegistry>(ctx, REGISTRY_KEY);
  }

  /** Applies `mutate` to the stored registry, re-reading and re-applying when a writer races it. */
  async update(
    ctx: TenantContext,
    mutate: IdentityRegistryMutation,
  ): Promise<IdentityRegistry | undefined> {
    for (let attempt = 1; attempt <= REGISTRY_UPDATE_ATTEMPTS; attempt++) {
      const stored = await load_encrypted_json_with_etag<IdentityRegistry>(ctx, REGISTRY_KEY);
      const next = mutate(stored?.value);
      if (next === undefined) return stored?.value;

      try {
        await this.write_conditionally(ctx, next, stored?.etag);
        return next;
      } catch (err) {
        if (!(err instanceof PreconditionFailedError)) throw err;
        if (attempt < REGISTRY_UPDATE_ATTEMPTS) await pause_before_retry(attempt);
      }
    }
    throw new StorageError(
      `The identity registry at ${REGISTRY_KEY} changed on every one of ` +
        `${REGISTRY_UPDATE_ATTEMPTS} write attempts; too many writers are registering at once`,
    );
  }

  /** Writes against `etag`, or create-only when there was nothing stored to compare against. */
  private async write_conditionally(
    ctx: TenantContext,
    registry: IdentityRegistry,
    etag: string | undefined,
  ): Promise<void> {
    const encrypted = ctx.encrypt(Buffer.from(JSON.stringify(registry)), REGISTRY_KEY);
    await ctx.storage.put(REGISTRY_KEY, encrypted, undefined, undefined, etag, etag === undefined);
  }
}

/** Waits a jittered, linearly growing delay so racing writers stop colliding in lockstep. */
async function pause_before_retry(attempt: number): Promise<void> {
  const delay_ms = RETRY_BASE_MS * attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
  await new Promise((resolve) => setTimeout(resolve, delay_ms));
}
