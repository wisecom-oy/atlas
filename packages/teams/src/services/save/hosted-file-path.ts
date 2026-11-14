import type { HostedOwner } from '@/services/backup/hosted-reference-scanner';

const IMAGE_TYPE_RE = /^image\/[a-z0-9.+-]+$/;

/**
 * Extensions for the types a file can carry safely. A browser shows a `.png` or `.txt` as content
 * and never runs it. HTML is saved as `.txt` for that reason, and every type not listed gets
 * `.bin`.
 */
const EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['image/webp', 'webp'],
  ['text/plain', 'txt'],
  ['text/html', 'txt'],
]);

/**
 * The archive path of one hosted content: `<directory>/hosted/<message>/<id>.<ext>`, where the
 * message is the reply's ID for a reply and the root's ID otherwise.
 */
export function hosted_archive_path(
  directory: string,
  owner: HostedOwner,
  hosted_id: string,
  content_type: string | undefined,
): string {
  const owner_segment = safe_segment(owner.reply_id ?? owner.root_id);
  const extension = EXTENSIONS.get(normalized_type(content_type) ?? '') ?? 'bin';
  return `${directory}/hosted/${owner_segment}/${safe_segment(hosted_id)}.${extension}`;
}

/** The lowercase media type of an image, with parameters removed, or undefined for other types. */
export function inline_image_type(content_type: string | undefined): string | undefined {
  const type = normalized_type(content_type);
  return type !== undefined && IMAGE_TYPE_RE.test(type) ? type : undefined;
}

/** Keeps ASCII letters, digits, `_` and `-`, so Graph IDs cannot form a path separator or dot segment. */
function safe_segment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

function normalized_type(content_type: string | undefined): string | undefined {
  const type = content_type?.split(';')[0]?.trim().toLowerCase();
  return type === undefined || type === '' ? undefined : type;
}
