import type { FullSnapshotManifestLayout } from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import { contacts_manifest_key, contacts_manifest_prefix } from '@/services/shared/storage-keys';

/** How the contacts workload lays out and shapes its snapshot manifests. */
export const CONTACTS_MANIFEST_LAYOUT: FullSnapshotManifestLayout = {
  label: 'contacts manifest',
  manifest_key: contacts_manifest_key,
  manifest_prefix: contacts_manifest_prefix,
  snapshot_id_prefix: 'ct-snap-',
  list_fields: ['folders'],
  entry_id_field: 'contact_id',
};
