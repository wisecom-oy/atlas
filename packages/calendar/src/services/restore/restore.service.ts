import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { inject, injectable } from 'inversify';
import type {
  CalendarConnector,
  CalendarManifestRepository,
  CalendarRestoreOptions,
  CalendarRestoreResult,
  CalendarRestoreUseCase,
  TenantContext,
  OwnerLeases,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CALENDAR_CONNECTOR_TOKEN,
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  OWNER_LEASES_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

import { map_source_calendars } from '@/services/restore/restore-calendar-mapper';
import { restore_all_entries } from '@/services/restore/restore-entry-loop';

/**
 * Restores a calendar snapshot into the source mailbox or a target mailbox. Existing events are
 * never overwritten or duplicated, and restored events carry no attendees, so no one is invited.
 */
@injectable()
export class CalendarRestoreService implements CalendarRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CALENDAR_CONNECTOR_TOKEN) private readonly _connector: CalendarConnector,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: CalendarManifestRepository,
    @inject(OWNER_LEASES_TOKEN) private readonly _leases: OwnerLeases,
  ) {}

  /** Restores a snapshot into the source or a target mailbox without re-inviting attendees. */
  async restore_calendar(
    tenant_id: string,
    mailbox_id: string,
    options: CalendarRestoreOptions,
  ): Promise<CalendarRestoreResult> {
    const source_id = normalize_owner_id(mailbox_id);
    const target_id = normalize_owner_id(options.target_mailbox_id ?? mailbox_id);
    const cancelled = (): CalendarRestoreResult => {
      finish_operation_progress(options, 'restore', 'calendar', 0, 0, true);
      return {
        snapshot_id: options.snapshot_id,
        events_restored: 0,
        events_skipped: 0,
        calendars_created: 0,
        errors: [],
        interrupted: true,
      };
    };
    if (begin_operation_progress(options, 'restore', 'calendar')) return cancelled();

    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const scope = { workload: 'calendar', owner_id: source_id, operation: 'restore' } as const;
      return await this._leases.run_exclusive_when_writable(tenant_ctx, scope, (ctx) =>
        run_cancellable(
          options,
          () => this.run_restore(ctx, tenant_id, source_id, target_id, options),
          cancelled,
        ),
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_restore(
    ctx: TenantContext,
    tenant_id: string,
    source_id: string,
    target_id: string,
    options: CalendarRestoreOptions,
  ): Promise<CalendarRestoreResult> {
    const manifest = await this._manifests.find_by_snapshot(ctx, source_id, options.snapshot_id);
    if (manifest === undefined) {
      throw new NotFoundError(`No calendar snapshot ${options.snapshot_id} found for this mailbox`);
    }

    const mapping = await map_source_calendars(
      this._connector,
      { tenant_id, mailbox_id: target_id },
      manifest.calendars,
    );
    const loop = await restore_all_entries(
      { ctx, connector: this._connector, tenant_id, target_mailbox_id: target_id },
      manifest.entries,
      mapping.target_by_source,
      options,
    );
    const interrupted = finish_operation_progress(
      options,
      'restore',
      'calendar',
      loop.processed,
      manifest.entries.length,
      loop.interrupted,
    );

    return {
      snapshot_id: options.snapshot_id,
      events_restored: loop.restored,
      events_skipped: loop.skipped,
      calendars_created: mapping.calendars_created,
      errors: [...mapping.errors, ...loop.errors],
      interrupted,
    };
  }
}
