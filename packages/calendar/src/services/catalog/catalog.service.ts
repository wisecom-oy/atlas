import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { return_or_raise_partial } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import { inject, injectable } from 'inversify';
import type {
  CalendarCatalogUseCase,
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  CalendarSnapshotSummary,
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

  /**
   * Lists a mailbox's calendar snapshots, newest first.
   *
   * @throws UnreadableObjectsError naming each damaged manifest, with the readable snapshots in
   *   `partial_result` (issue #631).
   */
  async list_calendar_snapshots(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest[]> {
    const mailbox = normalize_owner_id(mailbox_id);
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_readable_snapshots_by_mailbox(tenant_ctx, mailbox);
      return return_or_raise_partial(listing.unreadable_keys, listing.manifests);
    } finally {
      tenant_ctx.destroy();
    }
  }

  /**
   * Lists a mailbox's calendar snapshots from its summary index, newest first, decrypting only
   * manifests the index has no row for (#727).
   *
   * @throws UnreadableObjectsError naming each rowless manifest that could not be read, with the
   *   summaries in `partial_result`.
   */
  async list_calendar_snapshot_summaries(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<CalendarSnapshotSummary[]> {
    const mailbox = normalize_owner_id(mailbox_id);
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_snapshot_summaries(tenant_ctx, mailbox);
      return return_or_raise_partial(listing.unreadable_keys, listing.summaries);
    } finally {
      tenant_ctx.destroy();
    }
  }
}
