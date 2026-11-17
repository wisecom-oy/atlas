import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { ConcurrencySemaphore } from '@wisecom/atlas-core/services/shared/concurrency-semaphore';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  ContactManifestEntry,
  ContactsManifestRepository,
  ContactsVerificationUseCase,
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
  VerificationResult,
} from '@wisecom/atlas-types';
import {
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

interface ObjectCheck {
  readonly key: string;
  readonly checksum: string;
}

interface CheckedObject {
  readonly key: string;
  readonly intact: boolean;
}

/** The contact body and, when present, its photo, each with the checksum recorded at backup. */
function objects_of(entry: ContactManifestEntry): ObjectCheck[] {
  const checks: ObjectCheck[] = [{ key: entry.storage_key, checksum: entry.checksum }];
  if (entry.photo_storage_key !== undefined) {
    checks.push({ key: entry.photo_storage_key, checksum: entry.photo_checksum ?? '' });
  }
  return checks;
}

/** The stored ciphertext, or undefined when the bucket reports the key absent. Other storage errors propagate. */
async function read_stored_object(ctx: TenantContext, key: string): Promise<Buffer | undefined> {
  try {
    return await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw err;
  }
}

/**
 * Whether the ciphertext decrypts and hashes to the recorded checksum. A failed GCM tag or a
 * truncated payload is a damaged object, not a run error: decryption is local, so its failure
 * describes this object alone. A wrong passphrase never reaches here, it fails the DEK unwrap
 * when the tenant context is created.
 */
function decrypts_to_checksum(ctx: TenantContext, ciphertext: Buffer, check: ObjectCheck): boolean {
  let plaintext: Buffer;
  try {
    plaintext = ctx.decrypt(ciphertext, check.key);
  } catch {
    return false;
  }
  return compute_content_digests(ctx, plaintext).checksum === check.checksum;
}

/**
 * Fast mode confirms the object exists. Full mode decrypts it and recomputes the plaintext
 * SHA-256. An absent, undecryptable, or mismatched object is a failed check; other storage
 * errors propagate.
 */
async function object_intact(
  ctx: TenantContext,
  check: ObjectCheck,
  fast: boolean,
): Promise<boolean> {
  if (fast) return ctx.storage.exists(check.key);
  const ciphertext = await read_stored_object(ctx, check.key);
  if (ciphertext === undefined) return false;
  return decrypts_to_checksum(ctx, ciphertext, check);
}

/** Checks every object referenced by a contacts snapshot manifest. */
@injectable()
export class ContactsVerificationService implements ContactsVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: ContactsManifestRepository,
  ) {}

  /** Verifies a snapshot's stored objects against the checksums in its manifest. */
  async verify_contacts_snapshot(
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    if (begin_operation_progress(options, 'verify', 'contacts')) {
      finish_operation_progress(options, 'verify', 'contacts', 0, 0);
      return {
        snapshot_id,
        total_checked: 0,
        passed: 0,
        failed: [],
        interrupted: true,
        unverifiable: [],
        manifests_in_chain: 1,
      };
    }

    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(tenant_ctx, mailbox, snapshot_id);
      if (manifest === undefined) {
        throw new NotFoundError(`No contacts snapshot ${snapshot_id} found for this mailbox`);
      }
      return await this.check_all_objects(tenant_ctx, manifest.entries, snapshot_id, options);
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async check_all_objects(
    ctx: TenantContext,
    entries: readonly ContactManifestEntry[],
    snapshot_id: string,
    options: VerificationOptions,
  ): Promise<VerificationResult> {
    const checks = entries.flatMap(objects_of);
    const semaphore = new ConcurrencySemaphore();
    let processed = 0;
    let interrupted = false;

    const outcomes = await Promise.all(
      checks.map(async (check): Promise<CheckedObject | undefined> => {
        await semaphore.acquire();
        try {
          if (options.should_interrupt?.() === true || options.abort_signal?.aborted === true) {
            interrupted = true;
            return undefined;
          }
          const intact = await object_intact(ctx, check, options.fast === true);
          processed += 1;
          emit_operation_progress(options, {
            operation: 'verify',
            workload: 'contacts',
            phase: 'processing',
            processed,
            total: checks.length,
          });
          return { key: check.key, intact };
        } finally {
          semaphore.release();
        }
      }),
    );

    const checked = outcomes.filter((outcome): outcome is CheckedObject => outcome !== undefined);
    const failed = checked.filter((outcome) => !outcome.intact).map((outcome) => outcome.key);
    const final_interrupted = finish_operation_progress(
      options,
      'verify',
      'contacts',
      processed,
      checks.length,
      interrupted,
    );

    return {
      snapshot_id,
      total_checked: checked.length,
      passed: checked.length - failed.length,
      failed,
      interrupted: final_interrupted,
      unverifiable: [],
      manifests_in_chain: 1,
    };
  }
}
