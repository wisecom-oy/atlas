import { inject, injectable } from 'inversify';
import type {
  CalendarManifestRepository,
  QuarantineResult,
  QuarantineUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';

/** A calendar snapshot manifest: `calendar/manifests/{mailbox}/{snapshot}.json`. */
const MANIFEST_KEY = /^calendar\/manifests\/[^/]+\/[^/]+\.json$/;

/** Moves an unreadable calendar manifest aside (issue #631). */
@injectable()
export class CalendarQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: CalendarManifestRepository,
  ) {}

  /** Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Calendar',
      accepts: 'Calendar manifests',
      kind_of: (key) => (MANIFEST_KEY.test(key) ? 'manifest' : undefined),
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
    };
    return quarantine_unreadable_object(this._tenant_factory, target, tenant_id, storage_key);
  }
}
