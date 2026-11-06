import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  CalendarCatalogUseCase,
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

/** Lists a mailbox's calendar snapshots from the manifest repository. */
@injectable()
export class CalendarCatalogService implements CalendarCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: CalendarManifestRepository,
  ) {}

  /** Lists a mailbox's calendar snapshots, newest first. */
  async list_calendar_snapshots(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest[]> {
    const mailbox = normalize_owner_id(mailbox_id);
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await this._manifests.list_snapshots_by_mailbox(tenant_ctx, mailbox);
    } finally {
      tenant_ctx.destroy();
    }
  }
}
