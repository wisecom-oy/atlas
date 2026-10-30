---
description: Microsoft Graph throttling pools that limit Atlas backups, the values built into GRAPH_SERVICE_LIMITS, and how they cap parallel backup queues.
---

# Microsoft Graph rate limits

Atlas reads and writes Microsoft 365 only through Microsoft Graph. Graph throttles each app along several independent pools, and the throttling rules decide how far a backup queue can run in parallel. The limits below are the values Atlas builds into `GRAPH_SERVICE_LIMITS`, with the official Microsoft sources linked for each pool.

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

The [SDK reference](/reference/sdk) documents `AtlasInstanceConfig` and the full `OperationCost` type.

## How Graph throttles

Each request is checked against two kinds of limit. The first one reached returns `429 Too Many Requests`:

| Layer            | Scope                       | Limit                           |
| ---------------- | --------------------------- | ------------------------------- |
| Global           | Per app, across all tenants | 130,000 requests per 10 seconds |
| Service-specific | Per pool, see below         | Separate budget per pool        |

The global limit matters only for an app running hundreds of tenants at once. For most deployments, the service pools are the constraint.

Each pool has its own budget. Using one does not reduce another:

- Each mailbox has its own Outlook budget, so 50 parallel mailbox backups draw from 50 budgets.
- All SharePoint and OneDrive calls from one app share one budget per tenant, however many drives or sites they touch.

Atlas uses three pools:

| Pool                          | Scope                | Cost model                 | Used by                        |
| ----------------------------- | -------------------- | -------------------------- | ------------------------------ |
| Outlook                       | Per app, per mailbox | Flat (1 request = 1)       | Mail backup and restore        |
| SharePoint / OneDrive         | Per app, per tenant  | Resource units (1 to 5 RU) | OneDrive and SharePoint backup |
| Identity (Microsoft Entra ID) | Per app, per tenant  | Resource units (1 to 5 RU) | Mailbox discovery              |

## Outlook pool

**Official source:** [Outlook service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits)

Outlook limits apply per app ID per mailbox. Each request costs 1, whatever the endpoint or method.

| Limit                                                   | Value  |
| ------------------------------------------------------- | ------ |
| API requests per 10-minute window                       | 10,000 |
| Maximum concurrent requests per mailbox                 | 4      |
| Upload body size per 5-minute window (POST, PATCH, PUT) | 150 MB |

Atlas's per-mailbox limiter caps each window at 9,600 requests, 96% of Microsoft's limit, which leaves headroom for requests in flight. It also allows four concurrent requests per mailbox.

Graph processes at most four requests from a batch at a time. A `dependsOn` chain in a batch runs them one at a time. Each request inside a batch counts against the window on its own, so Atlas charges its limiter one unit per request in the batch, not one per round trip. `graphCost` counts the same way, so reaction capture costs one request per stored message in both. A retried batch resends only the messages still pending, and `graphCost` counts those again.

### Throttle handling

A `429` response includes `Retry-After`, the number of seconds to wait. Throttled requests still count toward the budget.

Atlas handles a throttled response in two steps:

1. The call that was throttled retries with exponential backoff, honouring `Retry-After`, for up to 12 retries.
2. The instance's throttle coordinator starts a cooldown for the pool the request was charged to, for the `Retry-After` window, or 30 seconds when Graph sends none. Every request to that pool waits for the cooldown before it sends, including each retry attempt.

The coordinator keeps one cooldown per pool: `outlook`, `sharepoint_onedrive` and `identity`. A 429 on one mailbox pauses the instance's other mailboxes, because they would keep sending requests that count against the same limit and fail. A 429 on a drive or site pauses the instance's other drive and site requests, which share one per-tenant budget. Neither pauses the other pool. The cooldown starts on the first throttled response, so calls already in a retry loop see it between attempts.

The default coordinator lives in memory and covers one Atlas instance. A host that runs several processes for the same tenant can pass its own `throttleCoordinator` so a 429 in one process pauses the others. See [Concurrent operations](/reference/sdk#concurrent-operations).

Retries happen in one layer only. The Graph SDK's own retry handler is disabled, so one logical call makes at most 13 HTTP attempts. Running both layers would multiply the retries.

Two paths do not consult the coordinator: chunked and whole-file downloads of large SharePoint and OneDrive content, and the resumable upload sessions a drive restore uses. Both fetch pre-authenticated URLs directly and retry on their own. Every request made through a Graph connector, including mailbox discovery and user resolution on the identity pool and Outlook restore, is coordinated.

### Endpoints in the Outlook pool

| Operation                   | Graph endpoint                                                                                                | Cost                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `list_mail_folders`         | `GET /users/{id}/mailFolders`, `/mailFolders/{wellKnownName}`                                                 | 1 per folder page, plus well-known folder reads                              |
| `fetch_delta`               | `GET /users/{id}/mailFolders/{id}/messages/delta`                                                             | 1 per page                                                                   |
| `fetch_message`             | `GET /users/{id}/messages/{id}`                                                                               | 1                                                                            |
| `fetch_mime`                | `GET /users/{id}/messages/{id}/$value`                                                                        | 1                                                                            |
| `fetch_reaction_properties` | `POST /$batch` of up to 20 chained `GET /users/{id}/messages/{id}?$expand=singleValueExtendedProperties(...)` | 1 per message, 1 round trip per 20 messages. `graphCost` counts each message |
| `fetch_attachments`         | `GET /users/{id}/messages/{id}/attachments`                                                                   | 1                                                                            |
| `create_mail_folder`        | `POST /users/{id}/mailFolders`                                                                                | 1                                                                            |
| `create_message`            | `POST /users/{id}/mailFolders/{id}/messages`                                                                  | 1                                                                            |
| `add_attachment`            | `POST /users/{id}/messages/{id}/attachments`                                                                  | 1, plus upload bytes                                                         |
| `create_upload_session`     | `POST /users/{id}/messages/{id}/attachments/createUploadSession`                                              | 1                                                                            |
| `upload_chunk`              | `PUT {upload_url}`                                                                                            | 1, plus upload bytes                                                         |
| `count_folder_messages`     | `GET /users/{id}/mailFolders/{id}?$select=totalItemCount`                                                     | 1                                                                            |
| `list_folder_messages`      | `GET /users/{id}/mailFolders/{id}/messages`                                                                   | 1                                                                            |

## SharePoint and OneDrive pool

**Official source:** [Avoid getting throttled or blocked in SharePoint Online](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)

This pool is per app, per tenant. Every call is charged in resource units (RU).

::: warning Drive cost is recorded at 1 RU per request
Atlas records every SharePoint and OneDrive request under `byService.sharepoint_onedrive` in `graphCost`. The drive code does not assign Microsoft's per-operation RU costs, so each request is recorded as 1 RU. The totals therefore undercount the RU that Microsoft charges for list, delta-without-token, and permission calls. Use the Microsoft limits below for scheduling, not the recorded RU.
:::

### Resource unit costs

| Operation                                        | Cost |
| ------------------------------------------------ | ---- |
| Single-item GET, delta with a token              | 1 RU |
| Multi-item list or search, delta without a token | 2 RU |
| Permission operations, `$expand=permissions`     | 5 RU |

Microsoft can change these costs. `GRAPH_SERVICE_LIMITS.sharepoint_onedrive` holds the values Atlas uses.

### Per-app, per-tenant limits

The limits scale with the tenant's license count.

| Licenses         | RU per minute | RU per 24 hours |
| ---------------- | ------------- | --------------- |
| 0 to 1,000       | 1,250         | 1,200,000       |
| 1,001 to 5,000   | 2,500         | 2,400,000       |
| 5,001 to 15,000  | 3,750         | 3,600,000       |
| 15,001 to 50,000 | 5,000         | 4,800,000       |
| 50,000 and over  | 6,250         | 6,000,000       |

### Tenant-level limits (all apps combined)

| Licenses         | RU per 5 minutes |
| ---------------- | ---------------- |
| 0 to 1,000       | 18,750           |
| 1,001 to 5,000   | 37,500           |
| 5,001 to 15,000  | 56,250           |
| 15,001 to 50,000 | 75,000           |
| 50,000 and over  | 93,750           |

### User-level and bandwidth limits

| Scope               | Limit                                     |
| ------------------- | ----------------------------------------- |
| Per user            | 3,000 requests per 5 minutes              |
| Per user            | 50 GB ingress and 100 GB egress per hour  |
| Per app, per tenant | 400 GB ingress and 400 GB egress per hour |

### Throttle responses

| Response                  | Meaning                                                  |
| ------------------------- | -------------------------------------------------------- |
| `429 Too Many Requests`   | The app exceeded its rate limit. Includes `Retry-After`. |
| `503 Service Unavailable` | Service-level load spike. Includes `Retry-After`.        |

A throttled request still counts toward the limit. Persistent offenders can be blocked, returning 503 until the block lifts. Microsoft announces blocks through the Microsoft 365 Message Center.

SharePoint also sends `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers (IETF draft-03, preview) once an app uses 80% of its one-minute RU budget. Atlas does not read these headers yet. See [RateLimit headers](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview).

### Scheduling implication

The budget is per tenant, not per user. Running N drive backups in parallel for one tenant does not add capacity the way N mailbox backups do, because they draw on the same budget. Parallel drive jobs shorten a run only while the budget has headroom. Once Graph throttles, the shared cooldown pauses all of them together.

## Identity pool (Microsoft Entra ID)

**Official source:** [Identity and access service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits)

This pool is per app, per tenant, with a global per-app limit across all tenants. Each call has a base RU cost, adjusted by query parameters.

| Tenant tier | Users     | RU per 10 seconds |
| ----------- | --------- | ----------------- |
| S           | Under 50  | 3,500             |
| M           | 50 to 500 | 5,000             |
| L           | Over 500  | 8,000             |

| Global per-app limit | Value                         |
| -------------------- | ----------------------------- |
| Read                 | 150,000 RU per 20 seconds     |
| Write                | 35,000 requests per 5 minutes |

Write quota per app and tenant is 3,000 requests per 2 minutes 30 seconds. Per-tenant write requests across all apps are capped at 18,000 per 5 minutes.

| Endpoint                             | Base cost |
| ------------------------------------ | --------- |
| `GET /users`                         | 2 RU      |
| `GET /users/{id}`                    | 1 RU      |
| `GET /reports/getMailboxUsageDetail` | 1 RU      |
| Other read paths                     | 1 RU      |

Modifiers: `$select` reduces the cost by 1 RU, `$expand` adds 1 RU, and `$top` below 20 reduces it by 1 RU. Atlas uses `$select` on user listing calls, so each `/users` page costs about 1 RU.

Atlas reads from this pool only during mailbox discovery and existence checks. These run at job start, so they seldom matter at small scale. They matter when many tenants list mailboxes at once.

## Summary

| Pool                  | Scope       | Cost model     | Constraint                                   |
| --------------------- | ----------- | -------------- | -------------------------------------------- |
| Outlook               | Per mailbox | Flat           | Primary limit for mail backup and restore    |
| SharePoint / OneDrive | Per tenant  | Resource units | Coordinate drive jobs per tenant             |
| Identity              | Per tenant  | Resource units | Matters only for discovery at scale          |
| Global                | Per app     | Flat           | Matters only with hundreds of active tenants |

For scheduling:

- Outlook is the most parallel pool. N mailbox backups use N budgets.
- Treat all drive jobs for one tenant as sharing one budget.
- Identity cost is small for individual jobs. Watch it only for tenant-wide discovery.

## Read the cost in code

`graphCost` is measured at the HTTP transport. Each `@odata.nextLink` page and each retry attempt counts as its own request, so a cooldown computed from `graphCost` reflects quota actually used. A run that threw usually used more quota than one that finished, so apply the cooldown in both cases. The [SDK reference](/reference/sdk) documents the full `OperationCost` type.

## Official Microsoft documentation

| Resource                           | URL                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global and service-specific limits | https://learn.microsoft.com/en-us/graph/throttling-limits                                                                                                       |
| General throttling guidance        | https://learn.microsoft.com/en-us/graph/throttling                                                                                                              |
| Outlook service limits             | https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits                                                                                |
| SharePoint and OneDrive throttling | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online                             |
| SharePoint RateLimit headers       | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview |
| Identity and access service limits | https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits                                                                    |

## See also

- [Delta sync](/operations/delta-sync): how delta queries use the drive costs above
- [Storage usage](/operations/storage-usage): listing cost on the S3 side
