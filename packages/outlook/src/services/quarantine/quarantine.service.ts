import { inject, injectable } from 'inversify';
import type {
  HeldOwnerLease,
  ManifestRepository,
  OwnerLeasePort,
  QuarantineResult,
  QuarantineUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
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
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Outlook',
      lease_workload: 'outlook',
      accepts: 'Outlook manifests',
      kind_of: (key) => (is_outlook_manifest_key(key) ? 'manifest' : undefined),
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
      after_move: (ctx, key, lease) => this.forget_moved_manifest(ctx, key, lease),
    };
    return quarantine_unreadable_object(
      this._tenant_factory,
      this._leases,
      target,
      tenant_id,
      storage_key,
    );
  }

  /** Drops a moved manifest's row from the mailbox's summary index (#625). */
  private async forget_moved_manifest(
    ctx: TenantContext,
    storage_key: string,
    lease: HeldOwnerLease,
  ): Promise<void> {
    const [, owner_id = '', snapshot_id = ''] = MANIFEST_KEY.exec(storage_key) ?? [];
    await this._manifests.forget_snapshot_summary(ctx, owner_id, snapshot_id, lease);
  }
}
