import { timingSafeEqual } from 'node:crypto';
import type {
  ObjectStorage,
  OldWrapperVersionOutcome,
  StorageObjectVersion,
  TenantWrapperPurgeOutcome,
} from '@wisecom/atlas-types';
import { ObjectLockRetainedError, WrongPassphraseError } from '@wisecom/atlas-types';
import type { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DEK_KEY } from '@/services/keys/dek-wrapper-rewrite';

/** The configured passphrase first, then any previous ones the operator supplied. */
export interface PurgeKeys {
  readonly configured: EnvelopeKeyService;
  readonly previous: readonly EnvelopeKeyService[];
}

/** Reads one object version. `ObjectStorage.get_version`, once proven present. */
type VersionReader = (key: string, version_id: string) => Promise<Buffer>;

/** What every version of one tenant is checked against. */
interface CurrentKey {
  readonly tenant_id: string;
  readonly keys: PurgeKeys;
  /** The data key the current wrapper holds. */
  readonly dek: Buffer;
}

/**
 * Deletes the noncurrent versions of one tenant's wrapped key that hold the current data key.
 * The caller holds the tenant lease.
 *
 * The current wrapper must open with the configured passphrase first. That proves the re-wrap
 * finished and the configuration was switched, so deleting the older wrappers cannot leave the
 * tenant without a wrapper anyone can open. Only versions the listing marks noncurrent are
 * considered, and each must unwrap to the same data key before it is deleted: a version holding
 * another key may still protect data an Object Lock retains, and is kept.
 */
export async function purge_tenant_old_wrappers(
  storage: ObjectStorage,
  tenant_id: string,
  keys: PurgeKeys,
): Promise<TenantWrapperPurgeOutcome> {
  if (!(await storage.exists(DEK_KEY))) return { tenant_id, status: 'no_key', versions: [] };
  const read_version = storage.get_version?.bind(storage);
  if (read_version === undefined) {
    const detail = 'this storage adapter cannot read object versions; nothing was deleted';
    return { tenant_id, status: 'failed', versions: [], detail };
  }

  const current_dek = await unwrap_current(storage, keys.configured, tenant_id);
  if (current_dek === undefined) return { tenant_id, status: 'current_unopenable', versions: [] };
  try {
    const noncurrent = await list_noncurrent_wrappers(storage);
    if (noncurrent === undefined) {
      const detail =
        'the version listing does not say which version is current; nothing was deleted';
      return { tenant_id, status: 'failed', versions: [], detail };
    }
    const versions: OldWrapperVersionOutcome[] = [];
    const current: CurrentKey = { tenant_id, keys, dek: current_dek };
    for (const version of noncurrent) {
      versions.push(await purge_one_version(storage, read_version, version, current));
    }
    const all_gone = versions.every((v) => v.status === 'deleted');
    return { tenant_id, status: all_gone ? 'purged' : 'versions_left', versions };
  } finally {
    current_dek.fill(0);
  }
}

/** Unwraps the current wrapper with the configured passphrase, or undefined if it will not open. */
async function unwrap_current(
  storage: ObjectStorage,
  configured: EnvelopeKeyService,
  tenant_id: string,
): Promise<Buffer | undefined> {
  try {
    return await configured.unwrap_dek(await storage.get(DEK_KEY), tenant_id);
  } catch (err) {
    if (err instanceof WrongPassphraseError) return undefined;
    throw err;
  }
}

/**
 * The versions of exactly `_meta/dek.enc` that the listing marks noncurrent, or undefined when
 * the listing leaves the currency of any version unstated: then no version is provably old, and
 * reporting the bucket clean would be false.
 */
async function list_noncurrent_wrappers(
  storage: ObjectStorage,
): Promise<StorageObjectVersion[] | undefined> {
  const listed = await storage.list_versions(DEK_KEY);
  const wrappers = listed.filter((v) => v.key === DEK_KEY && !v.is_delete_marker);
  if (wrappers.some((v) => v.is_latest === undefined)) return undefined;
  return wrappers.filter((v) => v.is_latest === false);
}

/** Proves one noncurrent version holds the current data key, then deletes it. */
async function purge_one_version(
  storage: ObjectStorage,
  read_version: VersionReader,
  version: StorageObjectVersion,
  current: CurrentKey,
): Promise<OldWrapperVersionOutcome> {
  const version_id = version.version_id;
  let verdict: VersionKeyVerdict;
  try {
    verdict = await compare_version_key(await read_version(DEK_KEY, version_id), current);
  } catch (err) {
    return { version_id, status: 'failed', detail: message_of(err) };
  }
  if (verdict !== 'same_key') return { version_id, status: verdict };

  try {
    await storage.delete_version(DEK_KEY, version_id);
    return { version_id, status: 'deleted' };
  } catch (err) {
    const status = err instanceof ObjectLockRetainedError ? 'retained' : 'failed';
    return { version_id, status, detail: message_of(err) };
  }
}

type VersionKeyVerdict = 'same_key' | 'different_key' | 'unverified';

/**
 * Unwraps an old version with each supplied passphrase in turn and compares what it holds with
 * the current data key. A version none of them opens is `unverified`: nothing proves it is safe
 * to delete.
 */
async function compare_version_key(blob: Buffer, current: CurrentKey): Promise<VersionKeyVerdict> {
  for (const keys of [current.keys.configured, ...current.keys.previous]) {
    const dek = await unwrap_or_undefined(blob, keys, current.tenant_id);
    if (dek === undefined) continue;
    try {
      const same = dek.length === current.dek.length && timingSafeEqual(dek, current.dek);
      return same ? 'same_key' : 'different_key';
    } finally {
      dek.fill(0);
    }
  }
  return 'unverified';
}

/** The unwrapped key, or undefined when this passphrase does not open the blob. */
async function unwrap_or_undefined(
  blob: Buffer,
  keys: EnvelopeKeyService,
  tenant_id: string,
): Promise<Buffer | undefined> {
  try {
    return await keys.unwrap_dek(blob, tenant_id);
  } catch (err) {
    if (err instanceof WrongPassphraseError) return undefined;
    throw err;
  }
}

function message_of(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
