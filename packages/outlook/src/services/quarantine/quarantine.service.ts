import { inject, injectable } from 'inversify';
import type {
  ManifestRepository,
  QuarantineResult,
  QuarantineUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { MANIFEST_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';

/** An Outlook snapshot manifest: `manifests/{owner}/{snapshot}.json`. */
const MANIFEST_KEY = /^manifests\/([^/]+)\/([^/]+)\.json$/;

/**
 * Whether Atlas would write this key: two plain segments after `manifests/`. The quarantine
 * executor already rejects `.` and `..` path segments; this also rejects them as a snapshot id.
 */
function is_outlook_manifest_key(storage_key: string): boolean {
  const [, owner = '', snapshot_id = ''] = MANIFEST_KEY.exec(storage_key) ?? [];
  return [owner, snapshot_id].every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  );
}

/** Moves an unreadable Outlook manifest aside (issue #631). Outlook keeps no version index. */
@injectable()
export class OutlookQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /** Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Outlook',
      accepts: 'Outlook manifests',
      kind_of: (key) => (is_outlook_manifest_key(key) ? 'manifest' : undefined),
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
    };
    return quarantine_unreadable_object(this._tenant_factory, target, tenant_id, storage_key);
  }
}
