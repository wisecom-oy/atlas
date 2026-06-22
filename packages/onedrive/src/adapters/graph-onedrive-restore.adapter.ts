import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';

const LARGE_UPLOAD_CHUNK = 10 * 1024 * 1024;
const CHUNK_PUT_ATTEMPTS = 3;

async function sleep_ms(delay_ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay_ms));
}

function parse_fetch_retry_after_ms(header_value: string | null): number | undefined {
  if (!header_value) return undefined;
  const trimmed = header_value.trim();
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const date_ms = Date.parse(trimmed);
  if (!isNaN(date_ms)) {
    const delta = date_ms - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

async function cancel_resumable_upload_session(upload_url: string): Promise<void> {
  try {
    await fetch(upload_url, { method: 'DELETE' });
  } catch {}
}

async function put_upload_chunk_with_retry(
  upload_url: string,
  range: string,
  chunk: Buffer,
): Promise<void> {
  let last_detail = '';
  for (let attempt = 0; attempt < CHUNK_PUT_ATTEMPTS; attempt++) {
    const response = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Range': range,
        'Content-Length': String(chunk.length),
      },
      body: chunk,
    });
    if (response.ok) return;

    last_detail = await response.text();
    const retriable = response.status === 429 || response.status === 503;
    const is_last = attempt === CHUNK_PUT_ATTEMPTS - 1;
    if (retriable && !is_last) {
      const wait_ms = parse_fetch_retry_after_ms(response.headers.get('retry-after')) ?? 1000;
      await sleep_ms(wait_ms);
      continue;
    }
    await cancel_resumable_upload_session(upload_url);
    throw new Error(
      `Resumable upload failed at range ${range}: HTTP ${response.status} ${last_detail}`,
    );
  }
}

async function find_child_folder_id_by_name(
  client: Client,
  owner_id: string,
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
        .api(`/users/${owner_id}/drives/${drive_id}/${parent_ref}/children?$filter=${filter}`)
        .get() as Promise<{ value?: Array<{ id?: string; folder?: Record<string, unknown> }> }>,
  );
  const match = response.value?.find((item) => item.folder !== undefined && item.id);
  return match?.id;
}

/**
 * Creates a folder under a OneDrive parent and returns its item id. Uses conflictBehavior `fail`
 * so an existing folder is not replaced (which would delete its subtree); on name conflict,
 * returns the id of the existing folder with that name.
 */
export async function graph_onedrive_create_folder(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  folder_name: string,
): Promise<string> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  try {
    const response = await with_graph_retry(
      () =>
        client.api(`/users/${owner_id}/drives/${drive_id}/${parent_ref}/children`).post({
          name: folder_name,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }) as Promise<{ id?: string }>,
    );
    if (!response.id) {
      throw new Error('Graph create folder returned no id');
    }
    return response.id;
  } catch (err) {
    if ((err as Record<string, unknown>).statusCode !== 409) throw err;
    const existing_id = await find_child_folder_id_by_name(
      client,
      owner_id,
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

/** Uploads file contents with a single PUT (small files). */
export async function graph_onedrive_upload_small_file(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
  conflict_behavior: string = 'rename',
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const encoded_name = encodeURIComponent(file_name);
  const conflict_qs = `@microsoft.graph.conflictBehavior=${conflict_behavior}`;
  await with_graph_retry(
    () =>
      client
        .api(
          `/users/${owner_id}/drives/${drive_id}/${parent_ref}:/${encoded_name}:/content?${conflict_qs}`,
        )
        .header('Content-Type', 'application/octet-stream')
        .put(content) as Promise<unknown>,
  );
}

/**
 * Uploads via createUploadSession and chunked PUTs. Each chunk PUT is retried up to three times on
 * 429/503 with Retry-After delays; on terminal failure the upload session is cancelled with DELETE.
 */
export async function graph_onedrive_upload_large_file(
  client: Client,
  owner_id: string,
  drive_id: string,
  parent_id: string,
  file_name: string,
  content: Buffer,
  conflict_behavior: string = 'rename',
): Promise<void> {
  const parent_ref = parent_id === 'root' ? 'root' : `items/${parent_id}`;
  const session_response = await with_graph_retry(
    () =>
      client
        .api(
          `/users/${owner_id}/drives/${drive_id}/${parent_ref}:/${encodeURIComponent(file_name)}:/createUploadSession`,
        )
        .post({
          item: { '@microsoft.graph.conflictBehavior': conflict_behavior },
        }) as Promise<{ uploadUrl?: string }>,
  );
  if (!session_response.uploadUrl) {
    throw new Error('Graph createUploadSession returned no uploadUrl');
  }
  const upload_url = session_response.uploadUrl;

  for (let offset = 0; offset < content.length; offset += LARGE_UPLOAD_CHUNK) {
    const end = Math.min(offset + LARGE_UPLOAD_CHUNK, content.length);
    const chunk = content.subarray(offset, end);
    const range = `bytes ${offset}-${end - 1}/${content.length}`;
    await put_upload_chunk_with_retry(upload_url, range, chunk);
  }
}
