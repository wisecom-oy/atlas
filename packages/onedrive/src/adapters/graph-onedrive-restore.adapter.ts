import type { Client } from '@microsoft/microsoft-graph-client';
import { Readable } from 'node:stream';
import { with_graph_retry } from '@atlas/m365-graph';

const LARGE_UPLOAD_CHUNK = 10 * 1024 * 1024;

/** Creates a folder under a OneDrive parent and returns the new item id. */
export async function graph_onedrive_create_folder(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  folder_name: string,
): Promise<string> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const response = await with_graph_retry(
    () =>
      client.api(`/users/${owner_id}/drives/${drive_id}/${parent_ref}/children`).post({
        name: folder_name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'replace',
      }) as Promise<{ id?: string }>,
  );
  if (!response.id) {
    throw new Error('Graph create folder returned no id');
  }
  return response.id;
}

/** Uploads file contents with a single PUT (small files). */
export async function graph_onedrive_upload_small_file(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  await with_graph_retry(
    () =>
      client
        .api(
          `/users/${owner_id}/drives/${drive_id}/${parent_ref}:/${encodeURIComponent(file_name)}:/content`,
        )
        .putStream(Readable.from(content)) as Promise<unknown>,
  );
}

/** Uploads via createUploadSession and chunked PUTs to the session URL. */
export async function graph_onedrive_upload_large_file(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const session_response = await with_graph_retry(
    () =>
      client
        .api(
          `/users/${owner_id}/drives/${drive_id}/${parent_ref}:/${encodeURIComponent(file_name)}:/createUploadSession`,
        )
        .post({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) as Promise<{
        uploadUrl?: string;
      }>,
  );
  if (!session_response.uploadUrl) {
    throw new Error('Graph createUploadSession returned no uploadUrl');
  }
  const upload_url = session_response.uploadUrl;

  for (let offset = 0; offset < content.length; offset += LARGE_UPLOAD_CHUNK) {
    const end = Math.min(offset + LARGE_UPLOAD_CHUNK, content.length);
    const chunk = content.subarray(offset, end);
    const range = `bytes ${offset}-${end - 1}/${content.length}`;

    const response = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Range': range,
        'Content-Length': String(chunk.length),
      },
      body: chunk,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Resumable upload failed at range ${range}: HTTP ${response.status} ${detail}`,
      );
    }
  }
}
