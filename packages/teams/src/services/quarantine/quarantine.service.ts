import { inject, injectable } from 'inversify';
import type {
  QuarantinedObjectKind,
  QuarantineResult,
  QuarantineUseCase,
  TeamsIndexRepository,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TEAMS_INDEX_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

/** A Teams snapshot index: `teams/manifests/{team}/{snapshot}.json`. */
const INDEX_KEY = /^teams\/manifests\/([^/]+)\/([^/]+)\.json$/;

/** Whether Atlas would write a snapshot index at exactly this key. */
export function is_teams_index_key(storage_key: string): boolean {
  const match = INDEX_KEY.exec(storage_key);
  if (!match) return false;
  const [, team_id = '', snapshot_id = ''] = match;
  try {
    return TEAMS_KEYS.manifest_key(team_id, snapshot_id) === storage_key;
  } catch {
    return false;
  }
}

/**
 * Moves an unreadable Teams snapshot index aside (issue #694).
 *
 * Channel cursors are left alone. Each cursor is bound to the shard key of the index entry it was
 * saved against, and the next backup trusts a delta link only while that shard is still the
 * channel's entry in the newest readable index. A channel whose cursor pointed at the moved index's
 * shard is therefore read in full, and one whose shard is unchanged resumes safely.
 */
@injectable()
export class TeamsQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
  ) {}

  /** Moves the index at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Teams',
      accepts: 'Teams snapshot indexes',
      kind_of: (key): QuarantinedObjectKind | undefined =>
        is_teams_index_key(key) ? 'manifest' : undefined,
      read: (ctx, key) => this._indexes.read_index_at(ctx, key),
    };
    return quarantine_unreadable_object(this._tenant_factory, target, tenant_id, storage_key);
  }
}
