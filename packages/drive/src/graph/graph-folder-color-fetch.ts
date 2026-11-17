import type { DriveFolderColor } from '@wisecom/atlas-types';
import type { GraphApiClient } from '@/permissions/graph-api-client';
import { batch_read_each } from '@/graph/graph-batch-read';

/** The list item columns that hold a folder's colour. */
const COLOR_FIELDS = '_ColorHex,_ColorTag,_Emoji';

/**
 * Reads the colour of each folder from its list item, 20 folders to a `$batch` round trip. Delta
 * accepts `$expand=listItem` but never fills it in, so this separate read is the only way to see a
 * colour. Graph leaves an empty column out of the response, so a folder without a colour reads as
 * an empty object.
 *
 * A folder missing from the result could not be read. The reason is logged, and the caller treats
 * the folder as "not read", never as "no colour".
 */
export async function fetch_drive_folder_colors(
  client: GraphApiClient,
  drive_id: string,
  item_ids: readonly string[],
): Promise<Map<string, DriveFolderColor>> {
  const requests = item_ids.map((item_id) => ({
    key: item_id,
    url: `/drives/${drive_id}/items/${item_id}/listItem/fields?$select=${COLOR_FIELDS}`,
  }));
  return batch_read_each(client, requests, {
    label: 'Folder colour capture',
    read_body: parse_folder_color,
  });
}

/** The non-empty colour columns of a `fieldValueSet`, under Atlas's own names. */
export function parse_folder_color(fields: Record<string, unknown>): DriveFolderColor {
  const color_hex = column_text(fields['_ColorHex']);
  const color_tag = column_text(fields['_ColorTag']);
  const emoji = column_text(fields['_Emoji']);
  return {
    ...(color_hex !== undefined && { color_hex }),
    ...(color_tag !== undefined && { color_tag }),
    ...(emoji !== undefined && { emoji }),
  };
}

/** A column value as text, or undefined when it is empty or not a scalar. */
function column_text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}
