---
description: How Microsoft Graph throttling limits Atlas backups, what Atlas does when it is throttled, and how to schedule jobs around the request budgets.
---

# Microsoft Graph rate limits

Atlas reads and writes Microsoft 365 only through Microsoft Graph, and Microsoft Graph limits how many requests an app may send. When a backup goes over a limit, Microsoft Graph answers `429 Too Many Requests` with a `Retry-After` header that says how long to wait. Atlas pauses, waits, and retries on its own.

Occasional throttling during a large first backup is normal and needs no action. What you control is how many jobs run at once, and the limits decide how far that helps:

| Workload | Budget | Running more jobs in parallel |
| --- | --- | --- |
| Outlook | One per mailbox | Adds capacity. 50 mailbox backups draw from 50 budgets |
| OneDrive, SharePoint | One per tenant, shared by every drive and site | Helps only while the tenant budget has headroom |
| Teams | One per tenant, plus limits per team and channel | Atlas paces requests itself. `--concurrency` sets channels in parallel |
| Mailbox discovery | One per tenant | Matters only when many tenants list mailboxes at once |

The limits below are the values Atlas builds into `GRAPH_SERVICE_LIMITS`, with Microsoft's source linked for each.

## Spacing runs with the SDK

Every SDK result reports the requests it used in `graphCost`, and a failed run still reports what it consumed. A scheduler can use it to keep the next run of a mailbox out of the current throttling window:

```ts
import { createAtlasInstance, getGraphCost, GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance(config); // AtlasInstanceConfig, see the SDK reference

let graphCost;
let failure: unknown;
try {
  const result = await atlas.outlook.backup('<mailbox-id>');
  graphCost = result.graphCost;
} catch (err) {
  failure = err;
  graphCost = getGraphCost(err); // a failed run still consumed quota
}

const used = graphCost?.byService.outlook?.requests ?? 0;
// Requests from this run leave the 10-minute sliding window within one window of being sent.
const cooldownMs = used > 0 ? GRAPH_SERVICE_LIMITS.outlook.windowDurationMs : 0;
// Store the cooldown before rethrowing, so a failed run still delays the next one.
await saveCooldown('<mailbox-id>', Date.now() + cooldownMs); // your scheduler's store
if (failure !== undefined) throw failure;
```

`graphCost` is measured at the HTTP transport. Each `@odata.nextLink` page and each retry attempt counts as its own request, so a cooldown computed from it reflects quota actually used. A run that threw usually used more quota than one that finished, so apply the cooldown in both cases. The [SDK reference](/reference/sdk) documents `AtlasInstanceConfig` and the full `OperationCost` type.

## How Microsoft Graph throttles

Each request is checked against two layers. The first limit reached returns `429 Too Many Requests`:

| Layer | Scope | Limit |
| --- | --- | --- |
| Global | Per app, across all tenants | 130,000 requests per 10 seconds |
| Service-specific | Per pool, see below | Separate budget per pool |

The global limit matters only for an app running hundreds of tenants at once. For most deployments the service pools are the constraint. Each pool has its own budget, and using one does not reduce another. Atlas uses four:

| Pool | Scope | Cost model | Used by |
| --- | --- | --- | --- |
| Outlook | Per app, per mailbox | Flat (1 request = 1) | Mail backup and restore |
| SharePoint / OneDrive | Per app, per tenant | Resource units (1 to 5 RU) | OneDrive and SharePoint backup |
| Identity (Microsoft Entra ID) | Per app, per tenant | Resource units (1 to 5 RU) | Mailbox discovery |
| Teams | Per app, per tenant, plus per team or channel | Flat (1 request = 1) | Teams channel backup |

A throttled request still counts toward the budget.

## Throttle handling

When Microsoft Graph throttles a request, Atlas pauses every request that draws on the same budget, not only the one that was refused. A `429`, and SharePoint's `509 Bandwidth Limit Exceeded`, both count as throttling. This is what slows the instance down: concurrency is fixed and a `429` does not lower it.

1. **The pool cools down.** Atlas's throttle coordinator starts a cooldown for the `Retry-After` window, or 30 seconds when Microsoft Graph sends none. Every request to that budget waits for it before it is sent, including retry attempts already in progress.
2. **The throttled call retries.** It waits out the cooldown and tries again, up to 12 retries. Without a `Retry-After`, it backs off exponentially, up to 5 minutes per wait.
3. **Requests resume gradually.** When the cooldown ends, each waiting request resumes after its own random delay, so the pool does not return to Microsoft Graph in one burst and draw the next `429`.

| Budget throttled | What pauses |
| --- | --- |
| One Outlook mailbox | Only that mailbox's requests. Other mailboxes keep sending |
| SharePoint / OneDrive | Every drive and site request of the instance, because they share one tenant budget |
| Identity | Every identity request of the instance |
| One team | Only that team's requests. Listing the tenant's teams has no team, so a `429` there pauses the whole Teams pool |

A cooldown never crosses pools. Overlapping cooldowns do not add up: the longest one wins.

::: details Throttle timing in detail
| Parameter | Value |
| --- | --- |
| Cooldown without `Retry-After` | 30 s |
| Maximum retries | 12, so at most 13 HTTP attempts per call |
| Backoff cap per wait | 5 minutes |
| Waiting budget per call | 24 minutes. After that the call starts no new wait, but a wait already started runs in full. Time spent inside each request does not count, so a call can take longer. See [the wall-clock worst case](/operations/reliability#microsoft-graph-requests) |
| Waiting budget per backup run | One call's budget. The first call that spends it ends every other Graph call of the run, which exits `3`. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle) |
| Longest `Retry-After` honoured | 1 hour. A longer value fails the call with a `ThrottledError` naming the value, and the pool still cools down for the hour. A CLI command that ends on that error exits at once; the cooldown does not hold the process open |
| Release delay after a cooldown | Random, up to a tenth of the cooldown, kept between 1 and 5 s. A 6-minute cooldown releases its requests over 5 s |

The release delay is only ever added, so nothing is sent before the `Retry-After` Microsoft Graph asked for. The cooldown starts on the first throttled response, so calls already in a retry loop see it between attempts.

Retries happen in one layer only. The Graph SDK's own retry handler is disabled, because running both layers would multiply the retries.
:::

### What the coordinator covers

Every request made through a Graph connector is coordinated, including mailbox discovery and user resolution on the identity pool, and Outlook restore.

OneDrive and SharePoint file downloads (whole or in ranges) and resumable upload chunks use pre-authenticated URLs instead of the Graph client. Atlas still makes each attempt wait for the `sharepoint_onedrive` cooldown before it is sent, and raises the cooldown on a `429`, or a `503` with `Retry-After`. Their own retry backoff still applies, see [File transfers](/operations/reliability#file-transfers-onedrive-and-sharepoint).

### Several processes for one tenant

The default coordinator lives in memory and covers one Atlas instance. A host that runs several processes for the same tenant can pass its own `throttleCoordinator`, so a `429` in one process pauses the others. A host coordinator fails open: if its shared store is unreachable, requests proceed on their own backoff and a warning is logged. See [Concurrent operations](/reference/sdk#concurrent-operations).

## Outlook pool

**Official source:** [Outlook service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits)

Outlook limits apply per app ID per mailbox. Each request costs 1, whatever the endpoint or method.

| Limit | Microsoft | Atlas |
| --- | --- | --- |
| API requests per 10-minute window | 10,000 | Paces each mailbox at 9,600 (96%), leaving headroom for requests in flight |
| Concurrent requests per mailbox | 4 | 4 |
| Upload body size per 5-minute window (POST, PATCH, PUT) | 150 MB | |

Microsoft Graph processes at most four requests from a `$batch` at a time, and a `dependsOn` chain runs them one at a time. Each request inside a batch counts against the window on its own, so Atlas charges its pacing one unit per request in the batch, not one per round trip. `graphCost` counts the same way, so reaction capture costs one request per stored message in both. A retried batch resends only the messages still pending, and `graphCost` counts those again.

### Requests in the Outlook pool

`graphCost.requestsByType` labels each request with the operation that issued it:

| `requestsByType` label | Microsoft Graph endpoint | Cost |
| --- | --- | --- |
| `list_folders` | `GET /users/{id}/mailFolders`, `/mailFolders/{wellKnownName}` | 1 per folder page, plus well-known folder reads |
| `delta_sync` | `GET /users/{id}/mailFolders/{id}/messages/delta` | 1 per page |
| `fetch_message` | `GET /users/{id}/messages/{id}` | 1 |
| `fetch_mime` | `GET /users/{id}/messages/{id}/$value` | 1 |
| `fetch_extended_properties` | `POST /$batch` of up to 20 chained `GET /users/{id}/messages/{id}?$expand=singleValueExtendedProperties(...)` | 1 per message, 1 round trip per 20 messages |
| `fetch_attachments` | `GET /users/{id}/messages/{id}/attachments` | 1 |
| `create_folder` | `POST /users/{id}/mailFolders` | 1 |
| `create_message` | `POST /users/{id}/mailFolders/{id}/messages` | 1 |
| `add_attachment` | `POST /users/{id}/messages/{id}/attachments` | 1, plus upload bytes |
| `create_upload_session` | `POST /users/{id}/messages/{id}/attachments/createUploadSession` | 1 |
| `upload_chunk` | `PUT {upload_url}` | 1, plus upload bytes |
| `count_folder_messages` | `GET /users/{id}/mailFolders/{id}?$select=totalItemCount` | 1 |
| `list_folder_messages` | `GET /users/{id}/mailFolders/{id}/messages` | 1 |

Restore also records `find_child_folder` and `read_well_known_folder` for its folder lookups.

## SharePoint and OneDrive pool

**Official source:** [Avoid getting throttled or blocked in SharePoint Online](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)

This pool is per app, per tenant. Every call is charged in resource units (RU).

The budget is per tenant, not per user. Running N drive backups in parallel for one tenant does not add capacity the way N mailbox backups do, because they draw on the same budget. Parallel drive jobs shorten a run only while the budget has headroom. Once Microsoft Graph throttles, the shared cooldown pauses all of them together.

::: warning Drive cost is recorded at 1 RU per request
Atlas records every SharePoint and OneDrive request under `byService.sharepoint_onedrive` in `graphCost` at 1 RU, without Microsoft's per-operation costs. The totals therefore undercount what Microsoft charges for list, delta-without-token, and permission calls. Use the Microsoft limits below for scheduling, not the recorded RU.
:::

### Resource unit costs

| Operation | Cost |
| --- | --- |
| Single-item GET, delta with a token | 1 RU |
| Multi-item list or search, delta without a token | 2 RU |
| Permission operations, `$expand=permissions` | 5 RU |

Microsoft can change these costs. `GRAPH_SERVICE_LIMITS.sharepoint_onedrive` holds the values Atlas uses.

### Per-app, per-tenant limits

The limits scale with the tenant's license count.

| Licenses | RU per minute | RU per 24 hours |
| --- | --- | --- |
| 0 to 1,000 | 1,250 | 1,200,000 |
| 1,001 to 5,000 | 2,500 | 2,400,000 |
| 5,001 to 15,000 | 3,750 | 3,600,000 |
| 15,001 to 50,000 | 5,000 | 4,800,000 |
| 50,000 and over | 6,250 | 6,000,000 |

### Tenant-level limits (all apps combined)

| Licenses | RU per 5 minutes |
| --- | --- |
| 0 to 1,000 | 18,750 |
| 1,001 to 5,000 | 37,500 |
| 5,001 to 15,000 | 56,250 |
| 15,001 to 50,000 | 75,000 |
| 50,000 and over | 93,750 |

### User-level and bandwidth limits

| Scope | Limit |
| --- | --- |
| Per user | 3,000 requests per 5 minutes |
| Per user | 50 GB ingress and 100 GB egress per hour |
| Per app, per tenant | 400 GB ingress and 400 GB egress per hour |

### Throttle responses

| Response | Meaning |
| --- | --- |
| `429 Too Many Requests` | The app exceeded its rate limit. Includes `Retry-After` |
| `503 Service Unavailable` | Service-level load spike. Includes `Retry-After` |

An app that keeps exceeding its limits can be blocked, and receives `503` until the block lifts. Microsoft announces blocks through the Microsoft 365 Message Center.

SharePoint also sends `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers (IETF draft-03, preview) once an app uses 80% of its one-minute RU budget. Atlas does not read these headers. See [RateLimit headers](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview).

## Identity pool (Microsoft Entra ID)

**Official source:** [Identity and access service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits)

Atlas reads from this pool only for mailbox discovery and existence checks. These run at job start, so they seldom matter at small scale. They matter when many tenants list mailboxes at once.

The pool is per app, per tenant, with a global per-app limit across all tenants. Each call has a base RU cost, adjusted by query parameters.

| Tenant tier | Users | RU per 10 seconds |
| --- | --- | --- |
| S | Under 50 | 3,500 |
| M | 50 to 500 | 5,000 |
| L | Over 500 | 8,000 |

| Global per-app limit | Value |
| --- | --- |
| Read | 150,000 RU per 20 seconds |
| Write | 35,000 requests per 5 minutes |

Write quota per app and tenant is 3,000 requests per 2 minutes 30 seconds. Write requests per tenant across all apps are capped at 18,000 per 5 minutes.

| Endpoint | Base cost |
| --- | --- |
| `GET /users` | 2 RU |
| `GET /users/{id}` | 1 RU |
| `GET /reports/getMailboxUsageDetail` | 1 RU |
| Other read paths | 1 RU |

`$select` reduces the cost by 1 RU, `$expand` adds 1 RU, and `$top` below 20 reduces it by 1 RU. Atlas uses `$select` on user listing calls, so each `/users` page costs about 1 RU.

## Teams pool

**Official source:** [Microsoft Teams service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#microsoft-teams-service-limits)

This pool is per app, per tenant, with extra limits per team and per channel. Each call costs one request.

| Endpoint | Per app, per tenant | Per team or channel |
| --- | --- | --- |
| Channel message reads | 20 per second | 1 per second per channel |
| Team reads | 30 per second | 4 per second per team |

Atlas paces Teams requests at 80% of these limits, so Microsoft Graph seldom has to throttle them. See [Teams pacing](/teams-backup#pacing). A `429` from the Teams pool pauses only the team it came from, and the tenant's other teams keep running. Listing the tenant's teams has no team, so a `429` there pauses the whole Teams pool. A Teams `429` never pauses another pool. See [Throttle handling](#throttle-handling).

## Summary

| Pool | Scope | Cost model | Constraint |
| --- | --- | --- | --- |
| Outlook | Per mailbox | Flat | Primary limit for mail backup and restore |
| SharePoint / OneDrive | Per tenant | Resource units | Coordinate drive jobs per tenant |
| Identity | Per tenant | Resource units | Matters only for discovery at scale |
| Teams | Per tenant, plus per team or channel | Flat | Limits for busy channels and teams |
| Global | Per app | Flat | Matters only with hundreds of active tenants |

For scheduling:

- Outlook is the most parallel pool. N mailbox backups use N budgets.
- Treat all drive jobs for one tenant as sharing one budget.
- Identity cost is small for individual jobs. Watch it only for tenant-wide discovery.

## Official Microsoft documentation

| Resource | URL |
| --- | --- |
| Global and service-specific limits | https://learn.microsoft.com/en-us/graph/throttling-limits |
| General throttling guidance | https://learn.microsoft.com/en-us/graph/throttling |
| Outlook service limits | https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits |
| SharePoint and OneDrive throttling | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online |
| SharePoint RateLimit headers | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview |
| Identity and access service limits | https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits |

## See also

- [Retries and fail-safes](/operations/reliability): what a run does when retries run out
- [Delta sync](/operations/delta-sync): how incremental backup uses the drive costs above
- [Troubleshooting](/troubleshooting#when-to-act): what to do when throttling causes failures
- [Storage usage](/operations/storage-usage): listing cost on the S3 side
