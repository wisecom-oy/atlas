---
description: 'Use the dependency-free @wisecom/atlas-sdk/contract entry to validate tenant onboarding in a browser and key a Microsoft 365 inventory in a Worker the way Atlas keys its backups.'
---

# Browser and Worker examples

Recipes for code that runs where the Node SDK cannot: an onboarding form in a browser, an inventory in a Cloudflare Worker, a schema shared between services. Each one imports only `@wisecom/atlas-sdk/contract`, which has no Node or third-party dependencies. Every export is listed in [Contract values](/reference/sdk#contract-values).

```ts
import {
  MIN_PASSPHRASE_BYTES,
  passphraseByteLength,
  isAcceptablePassphrase,
  tenantBucketName,
  isValidBucketName,
  canonicalSiteId,
  normalizeOwnerId,
  parseTeamId,
  isFileStorageContainerSite,
  GRAPH_SERVICE_POOLS,
} from '@wisecom/atlas-sdk/contract';
import type { GraphServicePool } from '@wisecom/atlas-sdk/contract';
```

The functions are the ones Atlas enforces with, so a form that accepts a value accepts exactly what `createAtlasInstance` accepts, and an inventory key equals the ID Atlas reports in a backup result.

## Validate tenant onboarding in a browser

Use this in the form that collects a new tenant's passphrase and, optionally, its own bucket, so the user sees the error before anything reaches your backend.

```ts
import {
  isAcceptablePassphrase,
  isValidBucketName,
  MIN_PASSPHRASE_BYTES,
  passphraseByteLength,
  tenantBucketName,
} from '@wisecom/atlas-sdk/contract';

export interface OnboardingInput {
  tenantId: string;
  passphrase: string;
  /** Empty when the tenant uses the bucket Atlas derives. */
  bucket: string;
}

export interface OnboardingCheck {
  /** The value to pass as `s3Bucket`, or the derived name when none was given. */
  bucket: string;
  /** True when your backend must create the bucket before the first backup. */
  createdByCaller: boolean;
  errors: string[];
}

export function checkOnboarding(input: OnboardingInput): OnboardingCheck {
  const errors: string[] = [];
  if (!isAcceptablePassphrase(input.passphrase)) {
    const bytes = passphraseByteLength(input.passphrase);
    errors.push(`The passphrase is ${bytes} bytes in UTF-8. Use at least ${MIN_PASSPHRASE_BYTES}.`);
  }

  const createdByCaller = input.bucket !== '';
  const bucket = createdByCaller ? input.bucket : tenantBucketName(input.tenantId);
  if (!isValidBucketName(bucket)) {
    errors.push(
      createdByCaller
        ? `"${bucket}" is not a valid S3 bucket name.`
        : `The tenant ID derives "${bucket}", which S3 refuses. Use the tenant GUID in lowercase, or name a bucket.`,
    );
  }
  return { bucket, createdByCaller, errors };
}
```

- **The floor is in bytes, not characters.** `'ä'` is 2 UTF-8 bytes, so a 10-character passphrase can pass while a 13-character ASCII one fails. `input.passphrase.length` gives the wrong answer for any non-ASCII input.
- **An explicit bucket is yours to create.** With `s3Bucket` set, Atlas never creates the bucket, and an operation that would create it throws `ConfigError`. Create it before the first backup, with [Object Lock](/reference/sdk#object-lock) enabled at creation if the backups must be immutable. See [Bucket override](/reference/sdk#bucket-override).
- **The derived bucket keeps the tenant ID's case.** `tenantBucketName('Contoso.onmicrosoft.com')` is `atlas-Contoso.onmicrosoft.com`, which S3 refuses. Atlas creates the derived bucket on the first backup, so a name that fails `isValidBucketName` fails there. Pass the tenant ID to `createAtlasInstance` in the same form you checked.

## Key a SharePoint inventory in a Worker

Use this when a Worker discovers sites through Microsoft Graph and enqueues backups, and later has to match each backup result to its inventory entry.

```ts
import {
  canonicalSiteId,
  isFileStorageContainerSite,
  normalizeOwnerId,
} from '@wisecom/atlas-sdk/contract';

interface GraphSite {
  id: string;
  webUrl: string;
  displayName: string;
}

interface GraphSitePage {
  value: GraphSite[];
  '@odata.nextLink'?: string;
}

export interface InventorySite {
  /** Equals `siteId` in an Atlas SharePoint backup result for this site. */
  key: string;
  webUrl: string;
  displayName: string;
}

/** The key Atlas stores and reports a site under. */
export function siteKey(graphSiteId: string): string {
  return normalizeOwnerId(canonicalSiteId(graphSiteId));
}

/** Every site Atlas can back up, without SharePoint Embedded containers. */
export async function discoverSites(accessToken: string): Promise<InventorySite[]> {
  const sites: InventorySite[] = [];
  let url: string | undefined =
    'https://graph.microsoft.com/v1.0/sites?search=*&$select=id,webUrl,displayName';
  while (url !== undefined) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Graph returned ${response.status} for the site search`);
    const page = (await response.json()) as GraphSitePage;
    for (const site of page.value) {
      if (isFileStorageContainerSite(site.webUrl)) continue;
      sites.push({ key: siteKey(site.id), webUrl: site.webUrl, displayName: site.displayName });
    }
    url = page['@odata.nextLink'];
  }
  return sites;
}
```

The job that runs the backup reports the result's `siteId`, and the Worker looks the site up by it:

```ts
const results = await atlas.sharepoint.backup(site.key);
for (const result of results) {
  await reportOutcome({ siteId: result.siteId, healthy: result.summary.healthy });
}
```

- **Compose both functions.** Graph's site ID is `hostname,siteGuid,webGuid`. `canonicalSiteId` drops the hostname and keeps the case it is given, and Atlas lowercases the result before it keys anything. A key built with `canonicalSiteId` alone misses a result whenever Graph returns uppercase GUIDs.
- **Filter containers before enqueueing.** Graph lists [SharePoint Embedded containers](/sharepoint-backup#sharepoint-embedded-containers) in the site search but refuses them to an app with only `Sites` permissions. A backup of one fails with `GraphAccessRefusedError`, and retrying returns the same answer.
- **Honour throttling.** The site search counts against the tenant's Graph limits like any other request. On `429`, wait for `Retry-After` before the next page.
- **Subsites.** With `includeSubsites: true`, `backup` returns one result per site. Each `siteId` is keyed the same way, so a subsite your discovery listed matches its own result.

## Key Teams and users

```ts
import { normalizeOwnerId, parseTeamId } from '@wisecom/atlas-sdk/contract';

/** The key Atlas stores a team under, or undefined for a value that is not a team GUID. */
export function teamKey(graphTeamId: string): string | undefined {
  return parseTeamId(graphTeamId);
}

/** The key Atlas stores a mailbox or OneDrive owner under: its Entra object ID, lowercased. */
export function ownerKey(entraObjectId: string): string {
  return normalizeOwnerId(entraObjectId);
}

teamKey(' 0A1B2C3D-0000-4000-8000-00000000000A '); // '0a1b2c3d-0000-4000-8000-00000000000a'
teamKey('https://teams.microsoft.com/l/team/x'); // undefined
```

`parseTeamId` returns `undefined` for every value `teams.backup` refuses with `ConfigError`, so a team your inventory keys is one Atlas accepts.

### Which IDs keep their case

| ID | Atlas stores it as | Inventory key |
| --- | --- | --- |
| Entra object ID of a user or mailbox | Lowercased | `normalizeOwnerId(id)` |
| SharePoint site ID | Hostname dropped, lowercased | `normalizeOwnerId(canonicalSiteId(id))` |
| Teams team ID | Trimmed, lowercased, must be a GUID | `parseTeamId(id)` |
| Email address or UPN | Not a key. The SDK resolves it to the object ID through Graph | Resolve it first, then use the object ID |
| Graph drive item, file, or message ID | Unchanged. These are case-sensitive | The ID as Graph returns it |
| Tenant ID | Unchanged, as part of the derived bucket name | `tenantBucketName(id)` |

Never pass a Graph item ID through `normalizeOwnerId`. Two items whose IDs differ only in case are different items, and a lowercased key would merge them.

## Share pool names with a scheduler

Use the pool names where a scheduler, a shared [throttle coordinator](/reference/sdk#sharing-throttle-cooldowns), or a metrics schema receives a pool as a string.

```ts
import { GRAPH_SERVICE_POOLS } from '@wisecom/atlas-sdk/contract';
import type { GraphServicePool } from '@wisecom/atlas-sdk/contract';

/** Narrows a pool name read from a queue message, a URL, or `graphCost.byService`. */
export function isGraphServicePool(value: string): value is GraphServicePool {
  return (GRAPH_SERVICE_POOLS as readonly string[]).includes(value);
}

/** How many jobs the scheduler runs at once against each pool of one tenant. */
export const jobsPerPool: Record<GraphServicePool, number> = {
  outlook: 1,
  sharepoint_onedrive: 1,
  identity: 1,
  teams: 1,
};
```

Typing the map as `Record<GraphServicePool, number>` makes a pool added in a later Atlas release a compile error in your scheduler, instead of a pool it silently never schedules. The values match `graphCost.byService` keys and the `pool` argument of `throttleCoordinator.wait` and `raise`.

## See also

- [Contract values](/reference/sdk#contract-values): every export and its rule
- [SDK examples](/reference/examples): Node.js recipes that use the full SDK
- [SharePoint Embedded containers](/sharepoint-backup#sharepoint-embedded-containers)
