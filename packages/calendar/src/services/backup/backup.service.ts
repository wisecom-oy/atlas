import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { lock_run_writes } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { inject, injectable } from 'inversify';
import type {
  CalendarBackupOptions,
  CalendarBackupResult,
  CalendarBackupSummary,
  CalendarBackupUseCase,
  CalendarConnector,
  CalendarDeltaCursor,
  CalendarDeltaCursorRepository,
  CalendarManifestRepository,
  CalendarRecord,
  CalendarSnapshotManifest,
  GraphCalendar,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CALENDAR_CONNECTOR_TOKEN,
  CALENDAR_DELTA_CURSOR_REPOSITORY_TOKEN,
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { resolve_backup_progress } from '@/services/backup/backup-progress';
import {
  sync_all_calendars,
  type CalendarLoopOutcome,
  type CalendarLoopState,
} from '@/services/backup/backup-calendar-loop';
import {
  build_snapshot_manifest,
  calendars_differ,
  compare_entries,
  new_snapshot_id,
} from '@/services/backup/backup-snapshot';

/**
 * Backs up one mailbox's calendars as a full snapshot manifest. Each calendar keeps its own delta
 * link; a run that changes nothing writes no snapshot but still advances the cursor. Read-only
 * calendars (Birthdays, read-only shares) are skipped: restore could not write them back.
 */
@injectable()
export class CalendarBackupService implements CalendarBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CALENDAR_CONNECTOR_TOKEN) private readonly _connector: CalendarConnector,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: CalendarManifestRepository,
    @inject(CALENDAR_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: CalendarDeltaCursorRepository,
  ) {}

  /** Backs up the mailbox's calendars; returns the new snapshot, or none when nothing changed. */
  async backup_calendar(
    tenant_id: string,
    mailbox_id: string,
    options: CalendarBackupOptions = {},
  ): Promise<CalendarBackupResult> {
    const mailbox = normalize_owner_id(mailbox_id);
    const cancelled = (): CalendarBackupResult => {
      finish_operation_progress(options, 'backup', 'calendar', 0, 0, true);
      return {
        mailbox_id: mailbox,
        snapshot: undefined,
        interrupted: true,
        summary: empty_summary(),
      };
    };
    if (begin_operation_progress(options, 'backup', 'calendar')) return cancelled();
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const ctx = await lock_run_writes(tenant_ctx, options.object_lock_request);
      return await run_cancellable(
        options,
        () => this.run_backup(ctx, tenant_id, mailbox, options),
        cancelled,
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_backup(
    ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    options: CalendarBackupOptions,
  ): Promise<CalendarBackupResult> {
    const cursor = await this._cursors.load(ctx, mailbox_id);
    const latest = await this._manifests.find_latest_readable(ctx, mailbox_id);
    const previous = latest.manifest;
    const head_unreadable = latest.unreadable_keys.length > 0;
    const listed = await this._connector.list_calendars(tenant_id, mailbox_id);
    // The default calendar is always backed up: losing it to a misreported canEdit is data loss.
    const backed_up = (calendar: GraphCalendar): boolean =>
      calendar.can_edit || calendar.is_default;
    const calendars = listed.filter(backed_up);
    const skipped = listed.filter((calendar) => !backed_up(calendar));
    const reporter = resolve_backup_progress(options, calendars);
    const loop = await sync_all_calendars(
      {
        ctx,
        connector: this._connector,
        tenant_id,
        mailbox_id,
        should_interrupt: () =>
          options.should_interrupt?.() === true || options.abort_signal?.aborted === true,
      },
      calendars,
      loop_state(previous, cursor, options.force_full === true || head_unreadable),
      options,
      reporter,
    );
    reporter.finish(calendars.length);
    return this.persist_snapshot(ctx, {
      tenant_id,
      mailbox_id,
      calendars,
      skipped,
      previous,
      unreadable_keys: latest.unreadable_keys,
      loop,
      options,
    });
  }

  /**
   * Writes the snapshot and cursor. An interrupted run writes neither: a partial run has moved some
   * calendar links past changes no manifest records, so the next run must replay from the old links.
   *
   * A run built on an older manifest because the newest could not be read writes neither when any
   * calendar failed. A failed calendar keeps its entries from that older manifest, so the snapshot would
   * roll it back past the unreadable one: items added since missing, deleted ones back. Without a
   * cursor the next run reads every calendar in full again (issue #631).
   */
  private async persist_snapshot(
    ctx: TenantContext,
    run: PersistInput,
  ): Promise<CalendarBackupResult> {
    const { tenant_id, mailbox_id, calendars, skipped, previous, unreadable_keys, loop, options } =
      run;
    const created_at = new Date();
    const calendar_records: CalendarRecord[] = calendars.map((calendar) => ({
      calendar_id: calendar.id,
      display_name: calendar.display_name,
      is_default: calendar.is_default,
    }));
    const counts = compare_entries(previous?.entries ?? [], loop.entries);
    const changed =
      counts.changed + counts.removed > 0 ||
      calendars_differ(previous?.calendars, calendar_records) ||
      unreadable_keys.length > 0;
    const has_content =
      loop.entries.length > 0 || previous !== undefined || unreadable_keys.length > 0;
    const writable =
      !loop.interrupted && (unreadable_keys.length === 0 || loop.errors.length === 0);
    const snapshot =
      writable && changed && has_content
        ? build_snapshot_manifest({
            tenant_id,
            mailbox_id,
            snapshot_id: new_snapshot_id(created_at.getTime()),
            created_at,
            calendars: calendar_records,
            entries: loop.entries,
          })
        : undefined;
    if (snapshot !== undefined) await this._manifests.save(ctx, snapshot);
    if (writable) {
      const cursor: CalendarDeltaCursor = {
        mailbox_id,
        delta_link_by_calendar: loop.delta_link_by_calendar,
        updated_at: created_at.toISOString(),
      };
      await this._cursors.save(ctx, cursor);
    }
    const interrupted = finish_operation_progress(
      options,
      'backup',
      'calendar',
      calendars.length,
      calendars.length,
      loop.interrupted,
    );
    const summary: CalendarBackupSummary = {
      calendars_scanned: calendars.length,
      calendars_skipped: skipped.length,
      events_changed: counts.changed,
      events_removed: counts.removed,
      objects_stored: loop.objects_stored,
      snapshot_created: snapshot !== undefined,
      ...(snapshot === undefined && loop.errors.length === 0 && !loop.interrupted
        ? {
            no_snapshot_reason:
              previous === undefined && loop.entries.length === 0 ? 'no_content' : 'no_changes',
          }
        : {}),
      warnings: [
        ...skipped.map((calendar) => `Calendar ${calendar.display_name} skipped: read-only`),
        ...loop.warnings,
      ],
      attachments_skipped: loop.attachments_skipped,
      errors: loop.errors,
      healthy: loop.errors.length === 0 && loop.attachments_skipped === 0,
      ...(unreadable_keys.length > 0 ? { unreadable_keys: [...unreadable_keys] } : {}),
    };
    return { mailbox_id, snapshot, interrupted, summary };
  }
}

interface PersistInput {
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly calendars: readonly GraphCalendar[];
  readonly skipped: readonly GraphCalendar[];
  readonly previous: CalendarSnapshotManifest | undefined;
  /** Manifests newer than `previous` that could not be read; they force a full read and a snapshot. */
  readonly unreadable_keys: readonly string[];
  readonly loop: CalendarLoopOutcome;
  readonly options: CalendarBackupOptions;
}

/**
 * Decides which previous state a run may build on. Links are only trusted when the previous
 * manifest exists, since the links describe the state that manifest captured. A damaged newer
 * manifest counts as untrusted too: the cursor's links describe the state it captured, which is
 * unreadable, so building on an older manifest with those links would drop every change between
 * the two. The run reads every folder in full instead and writes a fresh snapshot (issue #631).
 */
function loop_state(
  previous: CalendarSnapshotManifest | undefined,
  cursor: CalendarDeltaCursor | undefined,
  read_in_full: boolean,
): CalendarLoopState {
  const trusted = previous !== undefined && !read_in_full;
  const links = trusted ? (cursor?.delta_link_by_calendar ?? {}) : {};
  return {
    previous_entries: previous?.entries ?? [],
    read_links: links,
    kept_links: trusted ? links : {},
  };
}

function empty_summary(): CalendarBackupSummary {
  return {
    calendars_scanned: 0,
    calendars_skipped: 0,
    events_changed: 0,
    events_removed: 0,
    objects_stored: 0,
    snapshot_created: false,
    warnings: [],
    attachments_skipped: 0,
    errors: [],
    healthy: true,
  };
}
