import type { FullSnapshotManifestLayout } from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import { calendar_manifest_key, calendar_manifest_prefix } from '@/services/shared/storage-keys';

/** How the calendar workload lays out and shapes its snapshot manifests. */
export const CALENDAR_MANIFEST_LAYOUT: FullSnapshotManifestLayout = {
  label: 'calendar manifest',
  manifest_key: calendar_manifest_key,
  manifest_prefix: calendar_manifest_prefix,
  snapshot_id_prefix: 'cal-snap-',
  list_fields: ['calendars'],
  entry_id_field: 'event_id',
};
