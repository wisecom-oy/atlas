import { read_full_snapshot_manifest } from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import {
  optional_string,
  stored_count,
  type SnapshotSummaryLayout,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-layout';
import type {
  CalendarSnapshotManifest,
  CalendarSnapshotSummary,
  SnapshotSummary,
} from '@wisecom/atlas-types';
import { CALENDAR_MANIFEST_LAYOUT } from '@/adapters/calendar-manifest-layout';
import {
  calendar_manifest_key,
  calendar_manifest_prefix,
  calendar_summary_key,
} from '@/services/shared/storage-keys';

/** How the calendar workload keeps its per-mailbox snapshot summary index (#727). */
export const CALENDAR_SUMMARY_LAYOUT: SnapshotSummaryLayout<
  CalendarSnapshotManifest,
  CalendarSnapshotSummary
> = {
  label: 'Calendar',
  summary_key: calendar_summary_key,
  manifest_prefix: calendar_manifest_prefix,
  manifest_root_prefix: 'calendar/manifests/',
  manifest_key: calendar_manifest_key,
  read_manifest: (ctx, key) =>
    read_full_snapshot_manifest<CalendarSnapshotManifest>(ctx, CALENDAR_MANIFEST_LAYOUT, key),
  summarize: summarize_calendar_manifest,
  parse_details: parse_calendar_summary,
};

/** Builds the summary row recorded for a calendar manifest stored at `manifest_key`. */
export function summarize_calendar_manifest(
  manifest: CalendarSnapshotManifest,
  manifest_key: string,
): CalendarSnapshotSummary {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: new Date(manifest.created_at),
    manifest_key,
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    mailbox_id: manifest.mailbox_id,
    total_events: manifest.total_events,
  };
}

/** Reads a stored calendar row's mailbox and count fields; undefined when any is malformed. */
function parse_calendar_summary(
  row: Readonly<Record<string, unknown>>,
  common: SnapshotSummary,
): CalendarSnapshotSummary | undefined {
  const mailbox_id = optional_string(row, 'mailbox_id');
  const total_events = stored_count(row, 'total_events');
  if (typeof mailbox_id !== 'string' || total_events === undefined) return undefined;
  return { ...common, mailbox_id, total_events };
}
