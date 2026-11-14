/**
 * Which hosts the relay may intercept, and what each request is.
 *
 * The allowlist is matched on the exact hostname (or a dot-separated suffix),
 * never with an unanchored pattern: `graph.microsoft.com.example.net` must not
 * qualify, because the relay forwards to whatever origin it is handed.
 *
 * Classification is by host and path only. Bodies and headers are never read,
 * so a `$batch` request is `directory` even when it carries mailbox calls: the
 * relay cannot know without buffering the request body, which it never does.
 */

/** Every service name a request can be classified as. */
export const SERVICES = [
  'outlook',
  'onedrive',
  'sharepoint',
  'teams',
  'directory',
  'identity',
  'transfer',
];

/** Every request kind. */
export const KINDS = ['delta', 'batch', 'download', 'upload', 'token', 'write', 'read'];

/** Selectors accepted wherever a service is: `graph` is everything but identity. */
export const SERVICE_SELECTORS = {
  graph: SERVICES.filter((s) => s !== 'identity'),
  all: [...SERVICES],
};

const GRAPH_HOST = 'graph.microsoft.com';
const IDENTITY_HOST = 'login.microsoftonline.com';

/** Hosts that serve pre-authenticated download and upload URLs. */
const TRANSFER_SUFFIXES = ['.sharepoint.com', '.1drv.com', '.1drv.ms', '.officeapps.live.com'];
// Outlook attachment upload sessions (createUploadSession on a message) live on outlook.office.com.
const TRANSFER_EXACT = [
  '1drv.com',
  '1drv.ms',
  'officeapps.live.com',
  'outlook.office.com',
  'outlook.office365.com',
];

/** True when `hostname` belongs to Microsoft 365 and the relay may handle it. */
export function is_m365_host(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === GRAPH_HOST || host === IDENTITY_HOST) return true;
  if (TRANSFER_EXACT.includes(host)) return true;
  return TRANSFER_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** True when `hostname` is the Entra ID token endpoint host. */
export function is_identity_host(hostname) {
  return String(hostname ?? '').toLowerCase() === IDENTITY_HOST;
}

/** Expands a service name or selector (`graph`, `all`) into service names, or null if unknown. */
export function expand_service_selector(name) {
  if (SERVICE_SELECTORS[name]) return SERVICE_SELECTORS[name];
  return SERVICES.includes(name) ? [name] : null;
}

/** Path segments after the Graph version prefix, lowercased, without the query. */
function graph_segments(path) {
  const segments = path.split('?')[0].toLowerCase().split('/').filter(Boolean);
  if (segments[0] === 'v1.0' || segments[0] === 'beta') segments.shift();
  return segments;
}

const OUTLOOK_SEGMENT =
  /^(messages|mailfolders|events|calendar|calendars|calendarview|calendargroups|contacts|contactfolders|sendmail|mailboxsettings|outlook|inferenceclassification)$/;
const TEAMS_SEGMENT = /^(chats|joinedteams|teamwork|channels)$/;

/** Classifies a graph.microsoft.com path into a service. */
function classify_graph_service(segments) {
  const [root] = segments;
  if (root === 'sites') return 'sharepoint';
  if (root === 'drives' || root === 'shares') return 'onedrive';
  if (root === 'teams' || root === 'chats') return 'teams';
  // users/{id}/<resource> and me/<resource> name the workload in the resource segment.
  const resource = root === 'me' ? segments[1] : root === 'users' ? segments[2] : undefined;
  if (resource) {
    if (OUTLOOK_SEGMENT.test(resource)) return 'outlook';
    if (resource === 'drive' || resource === 'drives') return 'onedrive';
    if (TEAMS_SEGMENT.test(resource)) return 'teams';
  }
  return 'directory';
}

/** Classifies a request into its service, from the origin's host and the path. */
export function classify_service(hostname, path) {
  const host = String(hostname).toLowerCase();
  if (host === IDENTITY_HOST) return 'identity';
  if (host !== GRAPH_HOST) return 'transfer';
  return classify_graph_service(graph_segments(path));
}

const DELTA_SEGMENT = /^(microsoft\.graph\.)?delta(\(.*\))?$/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Classifies a request into its kind, given its service, method and path. */
export function classify_kind(service, method, path) {
  const verb = String(method).toUpperCase();
  const segments = graph_segments(path);
  const last = segments[segments.length - 1] ?? '';
  if (service === 'identity')
    return segments.includes('token') ? 'token' : READ_METHODS.has(verb) ? 'read' : 'write';
  if (service === 'transfer') {
    if (verb === 'GET') return 'download';
    if (verb === 'PUT') return 'upload';
    return READ_METHODS.has(verb) ? 'read' : 'write';
  }
  if (last === '$batch') return 'batch';
  if (DELTA_SEGMENT.test(last)) return 'delta';
  if (last.endsWith('createuploadsession')) return 'upload';
  if (last === 'content' || last === '$value') {
    if (verb === 'GET') return 'download';
    if (verb === 'PUT') return 'upload';
  }
  return READ_METHODS.has(verb) ? 'read' : 'write';
}
