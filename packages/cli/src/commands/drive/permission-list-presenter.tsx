import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import type {
  DriveFolderColor,
  DriveFolderColorItem,
  DrivePermission,
  DrivePermissionGrantee,
  DrivePermissionListing,
} from '@wisecom/atlas-types';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

interface PermissionRow {
  path: string;
  kind: string;
  roles: string;
  access: string;
}

const permission_columns: TableColumn<PermissionRow>[] = [
  { key: 'path', header: 'Path' },
  { key: 'kind', header: 'Kind' },
  { key: 'roles', header: 'Roles' },
  { key: 'access', header: 'Granted to' },
];

interface FolderColorRow {
  path: string;
  color: string;
}

const folder_color_columns: TableColumn<FolderColorRow>[] = [
  { key: 'path', header: 'Folder' },
  { key: 'color', header: 'Colour' },
];

/**
 * A folder colour as a table cell. `_ColorHex` holds the palette index the web UI wrote, not a hex
 * value, so it is shown as stored.
 */
function describe_folder_color(color: DriveFolderColor): string {
  return [
    color.color_hex !== undefined ? `palette ${color.color_hex}` : undefined,
    color.color_tag !== undefined ? `tag ${color.color_tag}` : undefined,
    color.emoji !== undefined ? `emoji ${color.emoji}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}

/** A grantee as a table cell: name and address when known, with the principal type. */
function describe_grantee(grantee: DrivePermissionGrantee | undefined): string {
  if (!grantee) return 'unknown';
  const label = grantee.display_name ?? grantee.login_name ?? grantee.id ?? '';
  const address = grantee.email ? ` <${grantee.email}>` : '';
  return `${label}${address} (${grantee.type.replace('_', ' ')})`.trim();
}

/** Who a permission grants access to: the grantee, or the link's type, scope and limits. */
function describe_access(permission: DrivePermission): string {
  const link = permission.link;
  if (!link) return describe_grantee(permission.granted_to);
  const limits = [
    permission.expires_at ? `expires ${permission.expires_at}` : undefined,
    permission.has_password === true ? 'password' : undefined,
    link.prevents_download === true ? 'no download' : undefined,
  ].filter((limit): limit is string => limit !== undefined);
  const people = (permission.granted_to_identities ?? []).map(describe_grantee);
  const detail = [...limits, ...people].join(', ');
  return `${link.type} link, ${link.scope}${detail ? ` (${detail})` : ''}`;
}

/**
 * Prints who had access to what at a snapshot, one row per permission, then each coloured folder.
 */
export async function report_permission_listing(
  title: string,
  listing: DrivePermissionListing,
): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <Banner title={title} />
      <KeyValueList items={[{ label: 'Snapshot', value: listing.snapshot_id }]} />
    </Box>,
  );
  await report_permission_rows(listing);
  await report_folder_colors(listing.folder_colors);
}

async function report_permission_rows(listing: DrivePermissionListing): Promise<void> {
  if (listing.items.length === 0) {
    logger.info(
      'No non-inherited permissions are recorded in this snapshot. ' +
        'Snapshots taken before permission capture record none.',
    );
    return;
  }
  const rows: PermissionRow[] = listing.items.flatMap((item) =>
    item.permissions.map((permission) => ({
      path: item.path,
      kind: item.kind,
      roles: permission.roles.join(', '),
      access: describe_access(permission),
    })),
  );
  await render_static_view(<DataTable columns={permission_columns} rows={rows} />);
}

/** Prints each coloured folder. Says nothing when there is none, which is the common case. */
async function report_folder_colors(folders: readonly DriveFolderColorItem[]): Promise<void> {
  if (folders.length === 0) return;
  const rows: FolderColorRow[] = folders.map((folder) => ({
    path: folder.path,
    color: describe_folder_color(folder.folder_color),
  }));
  await render_static_view(<DataTable columns={folder_color_columns} rows={rows} />);
}
