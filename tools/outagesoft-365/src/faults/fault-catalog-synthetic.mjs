/**
 * Faults answered by the relay itself: the request never reaches the upstream.
 *
 * Each `basis` names the real behaviour the fault mirrors, so a report reader
 * can tell a simulated condition from an invented one. Wire shapes (status,
 * error code, headers) live in faults/graph-error-responses.mjs.
 */

const API = ['outlook', 'onedrive', 'sharepoint', 'teams', 'directory'];
const GRAPH = [...API, 'transfer'];
const DRIVE = ['onedrive', 'sharepoint'];
const UPLOAD_HOSTS = ['transfer', 'onedrive', 'sharepoint'];
const ALL = [...GRAPH, 'identity'];

/** Synthetic-response fault entries; see fault-catalog.mjs for the entry shape. */
export const SYNTHETIC_FAULTS = [
  {
    id: 'throttle_429',
    category: 'throttle',
    services: GRAPH,
    params: { retry_after_s: [5, 30] },
    summary: '429 with Retry-After and the service-specific throttling code',
    basis:
      'Graph returns 429 with Retry-After when an app exceeds a per-mailbox, per-tenant or per-app limit.',
  },
  {
    id: 'throttle_429_no_retry_after',
    category: 'throttle',
    services: GRAPH,
    summary: '429 without a Retry-After header',
    basis: 'Some workloads, Teams among them, are documented to throttle without advising a wait.',
  },
  {
    id: 'throttle_429_long_retry_after',
    category: 'throttle',
    services: GRAPH,
    params: { retry_after_s: [315, 3570] },
    summary: '429 with a Retry-After of 315 to 3570 s',
    basis:
      'SharePoint sharing and tenant limits advise waits far beyond 300 s, where Atlas fails fast.',
  },
  {
    id: 'throttle_503',
    category: 'throttle',
    services: GRAPH,
    params: { retry_after_s: [5, 30] },
    summary: '503 with Retry-After (SharePoint "Server Too Busy")',
    basis: 'SharePoint and OneDrive throttle with 503 plus Retry-After as often as with 429.',
  },
  {
    id: 'server_500',
    category: 'server',
    services: GRAPH,
    summary: '500 generalException / InternalServerError',
    basis:
      'Graph front ends return 500 when a backend call fails unexpectedly; retrying usually succeeds.',
  },
  {
    id: 'bad_gateway_502',
    category: 'server',
    services: GRAPH,
    summary: '502 UnknownError with an empty message',
    basis:
      'The Graph gateway returns 502 when a workload backend drops or rejects the proxied call.',
  },
  {
    id: 'unavailable_503',
    category: 'server',
    services: GRAPH,
    summary: '503 serviceNotAvailable without Retry-After',
    basis:
      'Regional incidents and deployments surface as 503 serviceNotAvailable with no advised wait.',
  },
  {
    id: 'gateway_timeout_504',
    category: 'server',
    services: GRAPH,
    params: { delay_ms: [5000, 20000] },
    summary: 'waits, then 504 UnknownError with an empty message',
    basis:
      'Slow backend queries (large folders, deep delta pages) time out at the Graph gateway as 504.',
  },
  {
    id: 'html_503',
    category: 'server',
    services: GRAPH,
    summary: '503 text/html IIS queue-full page, no Retry-After',
    basis: 'An overloaded IIS front end answers with an HTML error page instead of Graph JSON.',
  },
  {
    id: 'mailbox_backend_503',
    category: 'server',
    services: ['outlook'],
    summary: '503 MailboxInfoStale: the mailbox database is on backend Unknown',
    basis:
      'Exchange Online returns MailboxInfoStale while a mailbox database moves between servers.',
  },
  {
    id: 'spurious_401',
    category: 'auth',
    services: API,
    summary: '401 InvalidAuthenticationToken "Lifetime validation failed"',
    basis:
      'Clock skew or a token cached across its expiry yields 401 even though a refresh would succeed.',
  },
  {
    id: 'spurious_400',
    category: 'consistency',
    services: API,
    summary: '400 invalidRequest for a request that is valid',
    basis:
      'Graph occasionally rejects a valid request during backend failover; the same call later succeeds.',
  },
  {
    id: 'transient_404',
    category: 'consistency',
    services: API,
    summary: '404 for an item that exists (eventual consistency)',
    basis:
      'An item created or moved moments ago is not yet visible on every replica Graph reads from.',
  },
  {
    id: 'locked_423',
    category: 'consistency',
    services: DRIVE,
    summary: '423 notAllowed / resourceLocked',
    basis: 'A file open for co-authoring or under a retention hold is locked against changes.',
  },
  {
    id: 'delta_resync_410',
    category: 'consistency',
    services: API,
    kinds: ['delta'],
    summary: '410 resyncRequired with a Location header',
    basis:
      'Delta state is discarded server side; the client must restart enumeration from the given link.',
  },
  {
    id: 'delta_token_expired',
    category: 'consistency',
    services: API,
    kinds: ['delta'],
    params: { status: { choice: [400, 410] } },
    summary: '410 or 400 syncStateNotFound',
    basis:
      'Delta tokens expire: directory delta tokens last 7 days, and Outlook delta tokens have no fixed lifetime but are evicted from a server-side cache.',
  },
  {
    id: 'upload_session_gone_404',
    category: 'consistency',
    services: UPLOAD_HOSTS,
    kinds: ['upload'],
    methods: ['PUT'],
    summary: '404 itemNotFound / uploadSessionNotFound on a fragment PUT',
    basis:
      'An upload session expires or is cancelled server side while fragments are still being sent.',
  },
  {
    id: 'upload_fragment_416',
    category: 'consistency',
    services: UPLOAD_HOSTS,
    kinds: ['upload'],
    methods: ['PUT'],
    summary: '416 invalidRange / fragmentOverlap on a fragment PUT',
    basis: 'A retried fragment overlaps a range the server already committed.',
  },
  {
    id: 'download_url_expired_401',
    category: 'auth',
    services: ['transfer'],
    methods: ['GET'],
    summary: '401 "JWT Token Expired" on a pre-authenticated download URL',
    basis:
      'Pre-authenticated download URLs are short-lived and can expire within minutes; a queued download can outlive them.',
  },
  {
    id: 'token_endpoint_503',
    category: 'server',
    services: ['identity'],
    summary: '503 temporarily_unavailable (AADSTS90033), no Retry-After',
    basis: 'Entra ID returns AADSTS90033 during transient token service failures.',
  },
  {
    id: 'token_endpoint_429',
    category: 'throttle',
    services: ['identity'],
    params: { retry_after_s: 60 },
    summary: '429 from the token endpoint with Retry-After: 60',
    basis: 'Entra ID throttles token requests from an app that asks for tokens too often.',
  },
  {
    id: 'connection_reset',
    category: 'transport',
    services: ALL,
    summary: 'the connection is reset before any response',
    basis: 'Load balancer recycling and network path failures drop connections mid-request.',
  },
  {
    id: 'no_response',
    category: 'transport',
    services: ALL,
    params: { hold_ms: 90000 },
    summary: 'accepts the request, answers nothing, closes after hold_ms',
    basis:
      'A hung backend or a silently dropped path leaves the client waiting until its own timeout.',
  },
];
