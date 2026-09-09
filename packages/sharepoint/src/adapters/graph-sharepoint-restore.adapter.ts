import type { Client } from '@microsoft/microsoft-graph-client';
import { build_upload_file_system_info, with_graph_retry } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { upload_content_to_session } from '@wisecom/atlas-drive/restore/upload-session';
import type { DriveFileSystemInfo } from '@wisecom/atlas-types';

async function find_child_folder_id_by_name(
  client: Client,
  site_id: string,
  drive_id: string,
  parent_id: string,
  folder_name: string,
): Promise<string | undefined> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const escaped = folder_name.replace(/'/g, "''");
  const filter = encodeURIComponent(`name eq '${escaped}'`);
  const response = await with_graph_retry(
    () =>
      client
        .api(`/sites/${site_id}/drives/${drive_id}/${parent_ref}/children?$filter=${filter}`)
        .get() as Promise<{ value?: Array<{ id?: string; folder?: Record<string, unknown> }> }>,
  );
  const match = response.value?.find((item) => item.folder !== undefined && item.id);
  return match?.id;
}

/**
 * Creates a folder under a SharePoint document library parent and returns its item id.
 * Uses conflictBehavior `fail` so an existing folder is not replaced; on name conflict,
 * returns the id of the existing folder.
 */
export async function graph_sharepoint_create_folder(
  client: Client,
  site_id: string,
  drive_id: string,
  parent_id: string,
  folder_name: string,
): Promise<string> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  try {
    const response = await with_graph_retry(
      () =>
        client.api(`/sites/${site_id}/drives/${drive_id}/${parent_ref}/children`).post({
          name: folder_name,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }) as Promise<{ id?: string }>,
    );
    if (!response.id) throw new Error('Graph create folder returned no id');
    return response.id;
  } catch (err) {
    if ((err as Record<string, unknown>).statusCode !== 409) throw err;
    const existing_id = await find_child_folder_id_by_name(
      client,
      site_id,
      drive_id,
      parent_id,
      folder_name,
    );
    if (!existing_id) {
      throw new Error(
        `Graph folder create conflict (409) but existing folder "${folder_name}" was not found`,
      );
    }
    return existing_id;
  }
}

/**
 * Uploads file contents with a single PUT (small files under 4 MiB).
 *
 * `PUT /content` carries bytes only, so original timestamps need a follow-up
 * PATCH on the created item. The PATCH is best-effort: a restored file with
 * the wrong timestamps is still a restored file, and failing the upload over
 * metadata would trade content for provenance.
 */
export async function graph_sharepoint_upload_small_file(
  client: Client,
  site_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
  conflict_behavior: string = 'rename',
  file_system_info?: DriveFileSystemInfo,
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const encoded_name = encodeURIComponent(file_name);
  // Encoded: an unescaped value could append a second conflictBehavior to the query.
  const conflict_qs = `@microsoft.graph.conflictBehavior=${encodeURIComponent(conflict_behavior)}`;
  const uploaded = await with_graph_retry(
    () =>
      client
        .api(
          `/sites/${site_id}/drives/${drive_id}/${parent_ref}:/${encoded_name}:/content?${conflict_qs}`,
        )
        .header('Content-Type', 'application/octet-stream')
        .put(content) as Promise<{ id?: string } | undefined>,
  );

  await stamp_file_system_info(client, site_id, drive_id, uploaded?.id, file_system_info);
}

/** Applies captured timestamps to an uploaded item, logging rather than failing. */
async function stamp_file_system_info(
  client: Client,
  site_id: string,
  drive_id: string,
  item_id: string | undefined,
  file_system_info: DriveFileSystemInfo | undefined,
): Promise<void> {
  const body = build_upload_file_system_info(file_system_info);
  if (!body || !item_id) return;

  try {
    await with_graph_retry(
      () =>
        client
          .api(`/sites/${site_id}/drives/${drive_id}/items/${item_id}`)
          .patch({ fileSystemInfo: body }) as Promise<unknown>,
    );
  } catch (err) {
    logger.warn(
      `Restored file kept restore-time timestamps: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Uploads via createUploadSession and chunked PUTs. Each chunk is retried up to three times on a
 * transient Graph status (429, 500, 502, 503, 504) with Retry-After delays; on terminal failure the
 * upload session is cancelled.
 */
export async function graph_sharepoint_upload_large_file(
  client: Client,
  site_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
  conflict_behavior: string = 'rename',
  file_system_info?: DriveFileSystemInfo,
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const file_system_body = build_upload_file_system_info(file_system_info);
  const session_response = await with_graph_retry(
    () =>
      client
        .api(
          `/sites/${site_id}/drives/${drive_id}/${parent_ref}:/${encodeURIComponent(file_name)}:/createUploadSession`,
        )
        .post({
          item: {
            '@microsoft.graph.conflictBehavior': conflict_behavior,
            ...(file_system_body ? { fileSystemInfo: file_system_body } : {}),
          },
        }) as Promise<{ uploadUrl?: string }>,
  );
  if (!session_response.uploadUrl) {
    throw new Error('Graph createUploadSession returned no uploadUrl');
  }
  const upload_url = session_response.uploadUrl;

  await upload_content_to_session(upload_url, content, file_name);
}
