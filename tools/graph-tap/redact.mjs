/**
 * URL redaction shared by graph-tap and outagesoft-365.
 *
 * Pure and side-effect free, so a tool that only needs to turn a raw Microsoft
 * 365 URL into something safe to write down can import it without starting a
 * capture. The rules are tuned for analysis: identifiers become placeholders so
 * repeated calls collapse into one shape, and opaque credential or cursor values
 * shrink to their byte count.
 *
 * Tenant data hides in more places than ids: file and folder names in path
 * addressing (`root:/Q1 budget.xlsx:`), site names, the tenant's own host label,
 * OneDrive owners in `/personal/<user>`, tenant names on the token endpoint, and
 * string literals in `$filter`. Shape alone misses short names, so ids are also
 * templated by position (whatever follows `users/`, `messages/`, `drives/` ...),
 * and on SharePoint hosts every segment that is not a known API word is
 * templated: when in doubt, a placeholder.
 */

/** Hosts worth recording. Anything else (S3, MinIO, telemetry) is ignored. */
export const DEFAULT_HOSTS = String.raw`graph\.microsoft\.com|login\.microsoftonline\.com|\.sharepoint\.com|1drv\.(com|ms)|officeapps\.live\.com`;

/**
 * Query parameters whose values are opaque and enormous: delta and skip tokens
 * run to kilobytes, and `tempauth`/`guestaccesstoken`/`authtoken` on
 * pre-authenticated URLs are credentials that grant access on their own. Both
 * are replaced by their byte count, which is all an analysis needs.
 */
export const ELIDE_PARAMS =
  /^(\$deltatoken|\$skiptoken|\$skip|token|tempauth|guestaccesstoken|authtoken|access_token|id_token|refresh_token|code|client_secret|password|sig|se|sp|sv|skoid|st|spr|sr|nonce|state|cv|authkey)$/i;

/** Longest a single kept query value may be before it is truncated. */
export const MAX_PARAM_LEN = 160;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// The local part is bounded so a long run of its characters with no `@` cannot
// make the scan quadratic. 256 covers a 64-character local part fully percent-encoded.
const EMAIL = /[A-Za-z0-9._%+-]{1,256}(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SINGLE_QUOTED = /'(?:[^']|'')*'/g;
const DOUBLE_QUOTED = /"[^"]*"/g;

const IDENTITY_HOST = 'login.microsoftonline.com';
const SHAREPOINT_HOST = /^([a-z0-9-]+?)(-my|-admin)?\.sharepoint\.com$/i;
const PUBLIC_TENANTS = new Set(['common', 'organizations', 'consumers']);

/** Segments whose next segment is an id (or a UPN, or a site), whatever its shape. */
const ID_PARENTS = new Set([
  'users',
  'groups',
  'sites',
  'teams',
  'channels',
  'chats',
  'drives',
  'items',
  'messages',
  'mailfolders',
  'childfolders',
  'events',
  'calendars',
  'contacts',
  'contactfolders',
  'attachments',
  'lists',
  'permissions',
  'replies',
  'members',
]);

/** Words that may follow an id parent without being an id. */
const KEYWORDS = new Set([
  'delta',
  'root',
  'search',
  'getallsites',
  'getallmessages',
  'sharedwithme',
  'recent',
  'following',
  'allchannels',
  'primarychannel',
  'inbox',
  'sentitems',
  'deleteditems',
  'drafts',
  'archive',
  'junkemail',
  'outbox',
  'msgfolderroot',
  'clutter',
  'conversationhistory',
  'recoverableitemsdeletions',
  'recoverableitemsroot',
  'recoverableitemspurges',
  'recoverableitemsversions',
  'scheduled',
  'searchfolders',
  'serverfailures',
  'syncissues',
  'conflicts',
  'localfailures',
]);

/** API words kept on SharePoint hosts; every other segment there is tenant content. */
const SHAREPOINT_KEEP = new Set([
  '_api',
  '_layouts',
  '_vti_bin',
  '15',
  '16',
  'v2.0',
  'v2.1',
  'drives',
  'drive',
  'items',
  'root',
  'children',
  'uploadsession',
  'content',
  'download.aspx',
  'personal',
  'sites',
  'teams',
  'web',
  'lists',
  '$value',
]);

/** True for a segment that is a function, a system segment or a known word, not an id. */
function is_keyword(seg) {
  const lower = seg.toLowerCase();
  return (
    KEYWORDS.has(lower) ||
    lower.startsWith('$') ||
    lower.startsWith('microsoft.graph.') ||
    lower.endsWith('()')
  );
}

/** Shape rules: placeholders for segments that look like ids wherever they appear, or null. */
function template_by_shape(seg) {
  if (GUID.test(seg)) return '{guid}';
  if (seg.includes('@') || /%40/i.test(seg)) return '{upn}';
  if (/^[a-z]!/i.test(seg)) return '{id}'; // drive ids (b!...) and share ids (s!...)
  // Outlook item ids, drive item ids and site ids: long and opaque.
  if (seg.length > 40) return '{id}';
  if (/^\d+$/.test(seg) && seg.length > 3) return '{n}';
  if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '{id}';
  return null;
}

/** The placeholder for the segment that follows an id parent. */
function positional_placeholder(parent, seg, colon) {
  if (parent === 'sites') return colon ? '{host}' : '{site}';
  if (parent === 'teams' && colon) return '{host}';
  return template_by_shape(seg) ?? '{id}';
}

/** Templates one bare segment (no trailing colon) given its parent and the host's kind. */
function template_segment(seg, parent, host_kind, index, colon) {
  if (!seg || seg.startsWith('{')) return seg;
  // OData key syntax, e.g. Users('jane@example.com') or Messages('AAMk...'): keep the name.
  if (seg.includes('(')) return seg.replace(SINGLE_QUOTED, "'{value}'").replace(EMAIL, '{upn}');
  if (host_kind === 'identity' && index === 0)
    return PUBLIC_TENANTS.has(seg.toLowerCase()) ? seg : '{tenant}';
  if (host_kind === 'sharepoint') {
    if (parent === 'personal') return '{upn}';
    if (parent === 'sites' || parent === 'teams') return '{site}';
    if (SHAREPOINT_KEEP.has(seg.toLowerCase())) return seg;
    if (parent === 'drives' || parent === 'items') return '{id}';
    return template_by_shape(seg) ?? '{path}';
  }
  if (ID_PARENTS.has(parent) && !is_keyword(seg)) return positional_placeholder(parent, seg, colon);
  return template_by_shape(seg) ?? seg;
}

/** Classifies a host for the host-specific rules: identity, sharepoint or other. */
function host_kind_of(host) {
  const lower = String(host ?? '').toLowerCase();
  if (lower === IDENTITY_HOST) return 'identity';
  if (SHAREPOINT_HOST.test(lower)) return 'sharepoint';
  return 'other';
}

/** Replaces a SharePoint host's tenant label: contoso-my.sharepoint.com -> {tenant}-my.sharepoint.com. */
export function template_host(host) {
  const match = SHAREPOINT_HOST.exec(String(host ?? ''));
  if (!match) return host;
  return `{tenant}${(match[2] ?? '').toLowerCase()}.sharepoint.com`;
}

/**
 * Collapses a path into a shape: concrete identifiers become placeholders so
 * thousands of per-message calls group into one row instead of one row each.
 * `host` (optional) enables the SharePoint and token-endpoint rules.
 */
export function template_path(path, host = '') {
  const host_kind = host_kind_of(host);
  // Path addressing (`root:/Folder/File.xlsx:/content`) carries file and folder names.
  // One pass, so the closing colon of a span is consumed and `:/content` after it survives.
  const addressed = path.replace(/:\/[^:]*(:|$)/g, ':/{path}$1');
  const segments = addressed.split('/');
  let parent = '';
  let index = 0;
  return segments
    .map((raw) => {
      if (!raw) return raw;
      const colon = raw.endsWith(':');
      const seg = colon ? raw.slice(0, -1) : raw;
      const out = template_segment(seg, parent, host_kind, index, colon);
      parent = seg.toLowerCase();
      index += 1;
      return colon ? `${out}:` : out;
    })
    .join('/');
}

/** Decodes a URI component, falling back to the raw text when it is malformed. */
function safe_decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Redacts one kept query value: search terms, string literals, GUIDs and addresses. */
function redact_query_value(key, decoded) {
  if (/^\$?search$/i.test(key)) return '{value}';
  return decoded
    .replace(SINGLE_QUOTED, "'{value}'")
    .replace(DOUBLE_QUOTED, '"{value}"')
    .replace(GUID_ANYWHERE, '{guid}')
    .replace(EMAIL, '{upn}');
}

/** Elides credential and cursor values, keeping their size, and templates ids and tenant content. */
export function normalize_url(origin, full_path) {
  const q = full_path.indexOf('?');
  const raw_host = origin.replace(/^https?:\/\//, '');
  const path = template_path(q === -1 ? full_path : full_path.slice(0, q), raw_host);
  const host = template_host(raw_host);
  if (q === -1) return `${host}${path}`.replace(EMAIL, '{upn}');

  const params = full_path
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (ELIDE_PARAMS.test(safe_decode(key))) return `${key}=<${value.length}b>`;
      const redacted = redact_query_value(safe_decode(key), safe_decode(value));
      return `${key}=${redacted.length > MAX_PARAM_LEN ? `${redacted.slice(0, MAX_PARAM_LEN)}…` : redacted}`;
    });
  return `${host}${path}?${params.join('&')}`.replace(EMAIL, '{upn}');
}
