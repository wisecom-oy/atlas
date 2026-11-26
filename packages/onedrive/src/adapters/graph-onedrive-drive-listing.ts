import type { Client } from '@microsoft/microsoft-graph-client';
import {
  is_no_onedrive_answer,
  no_onedrive_message,
  read_owner_listing,
  rethrow_if_no_onedrive,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type { OneDriveDrive } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';

interface GraphCollectionResponse<T> {
  value?: T[];
}

interface GraphDriveRecord {
  id?: string;
  name?: string;
}

/**
 * Lists an owner's drives, falling back to the default drive when the collection is empty.
 *
 * Read under the in-run confirmation rule: Graph's "User's mysite not found." answer is accepted at
 * once, and any other 404 is read again before it is believed (issue #863).
 *
 * @throws NotFoundError when the owner has no OneDrive, or the owner does not exist.
 * @throws GraphUnavailableError when another 404 or 4xx persisted for an owner that exists.
 */
export async function list_owner_drives(
  client: Client,
  owner_id: string,
): Promise<OneDriveDrive[]> {
  return read_owner_listing(
    client,
    { owner_id, listing: 'drives', is_conclusive: is_no_onedrive_answer },
    () => read_drives(client, owner_id),
  );
}

/** One read of `GET /users/{id}/drives`, and of the default drive when it lists none. */
async function read_drives(client: Client, owner_id: string): Promise<OneDriveDrive[]> {
  const response = await with_graph_retry(
    () =>
      client.api(`/users/${owner_id}/drives?$select=id,name`).get() as Promise<
        GraphCollectionResponse<GraphDriveRecord>
      >,
  );
  const drives = (response.value ?? [])
    .filter((drive) => Boolean(drive.id))
    .map((drive) => ({ drive_id: drive.id ?? '', drive_name: drive.name ?? '' }));
  if (drives.length > 0) return drives;
  return read_default_drive(client, owner_id);
}

/** Reads `GET /users/{id}/drive` for an owner whose drive collection came back empty. */
async function read_default_drive(client: Client, owner_id: string): Promise<OneDriveDrive[]> {
  let default_drive: GraphDriveRecord | undefined;
  try {
    default_drive = await with_graph_retry(
      () =>
        client.api(`/users/${owner_id}/drive?$select=id,name`).get() as Promise<GraphDriveRecord>,
    );
  } catch (err) {
    // The "no OneDrive" 404 means the drive does not exist, not that a grant is missing. Reporting
    // it as a permission fault sent operators to Entra to grant what they already had (#404).
    rethrow_if_no_onedrive(err, owner_id);
    throw err;
  }
  if (!default_drive.id) throw new NotFoundError(no_onedrive_message(owner_id));
  return [{ drive_id: default_drive.id, drive_name: default_drive.name ?? 'default' }];
}
