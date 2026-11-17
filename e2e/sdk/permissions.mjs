/**
 * `onedrive.listPermissions` for the newest snapshot of the configured owner.
 *
 * Prints the snapshot id, the item count, and for items whose path carries the run marker only
 * their path, kind and sharing-link shapes. Grantees are left out: they name people.
 */

import { create_instance, main, required_env } from './lib.mjs';

await main(async () => {
  const owner = required_env('E2E_ONEDRIVE_OWNER');
  const marker = required_env('E2E_RUN_MARKER');
  const atlas = create_instance();
  try {
    const listing = await atlas.onedrive.listPermissions(owner);
    return {
      snapshot_id: listing.snapshotId,
      item_count: listing.items.length,
      marked_items: listing.items
        .filter((item) => item.path.includes(marker))
        .map((item) => ({
          path: item.path,
          kind: item.kind ?? 'file',
          links: item.permissions
            .filter((permission) => permission.link !== undefined)
            .map((permission) => ({ type: permission.link.type, scope: permission.link.scope })),
        })),
    };
  } finally {
    await atlas.dispose();
  }
});
