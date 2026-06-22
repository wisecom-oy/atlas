# Microsoft Graph API Rate Limits

Atlas communicates with Microsoft 365 services exclusively through the Microsoft Graph API. Understanding Graph's throttling model is essential for operators building high-throughput backup pipelines, especially when using a job queue (such as pg-boss) to orchestrate backups across many mailboxes or tenants.

## The Two-Layer Throttling Model

Every Graph API request is evaluated against **two independent categories** of limits simultaneously. The first limit reached triggers a `429 Too Many Requests` response:

| Layer                | Scope                         | Limit                         |
| -------------------- | ----------------------------- | ----------------------------- |
| **Global**           | Per app across all tenants    | 130,000 requests / 10 seconds |
| **Service-specific** | Varies by service (see below) | Separate pool per service     |

The global limit is unlikely to be hit by Atlas unless running hundreds of tenants simultaneously from a single app registration. Service-specific limits are the operational bottleneck for most deployments.

## Independent Service Pools

Microsoft Graph enforces **separate, independent throttling pools** for each service. **Consuming quota in one pool does not affect quota in another.** For Atlas operators, this means:

- A mailbox backup (Outlook pool, per-mailbox) does not compete with a future OneDrive backup (SharePoint pool, per-tenant) for the same user.
- Running 50 mailbox backups in parallel uses 50 independent Outlook quota budgets — one per mailbox.
- All SharePoint/OneDrive operations for a single tenant share one budget regardless of how many users or drives are targeted.

The three pools Atlas uses are:

| Pool                    | Scope               | Cost model                  | Used by                  |
| ----------------------- | ------------------- | --------------------------- | ------------------------ |
| **Outlook**             | Per app per mailbox | Flat (1 req = 1)            | Mail backup and restore  |
| **SharePoint/OneDrive** | Per app per tenant  | Resource units (1–5 RU/req) | OneDrive backup (future) |
| **Identity**            | Per app per tenant  | Resource units (1–5 RU/req) | Mailbox discovery        |

---

## Pool 1: Outlook / Exchange Online

> **Official source:** [Graph throttling limits — Outlook service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits)

**Scope:** Per app ID per mailbox. Limits for one mailbox are completely independent of limits for any other mailbox, even within the same tenant.

**Applies to:** Mail API, Calendar API, Personal Contacts API, Search API, To-do Tasks API, Mailbox Import/Export API.

**Cost model: flat** — every request counts as 1, regardless of endpoint or HTTP method.

### Limits

| Limit                                                 | Value      |
| ----------------------------------------------------- | ---------- |
| API requests per 10-minute window                     | **10,000** |
| Maximum concurrent requests per mailbox               | **4**      |
| Upload body size per 5-minute window (POST/PATCH/PUT) | **150 MB** |

### Batching Behavior

Microsoft Graph sends up to 4 individual Outlook requests from a batch at a time, regardless of target mailboxes. This is consistent with the 4-concurrent-request limit per mailbox. Using `dependsOn` in batch requests forces sequential execution (1 at a time).

### Throttle Response

`429 Too Many Requests` with a `Retry-After` header specifying how many seconds to wait. Throttled requests still count toward usage limits.

### Atlas Operations — Outlook Pool

| Operation               | Graph endpoint                                                   | Cost                     |
| ----------------------- | ---------------------------------------------------------------- | ------------------------ |
| `list_mail_folders`     | `GET /users/{id}/mailFolders`                                    | 1 request                |
| `fetch_delta`           | `GET /users/{id}/mailFolders/{id}/messages/delta`                | 1 request per page       |
| `fetch_message`         | `GET /users/{id}/messages/{id}`                                  | 1 request                |
| `fetch_attachments`     | `GET /users/{id}/messages/{id}/attachments`                      | 1 request                |
| `create_mail_folder`    | `POST /users/{id}/mailFolders`                                   | 1 request                |
| `create_message`        | `POST /users/{id}/mailFolders/{id}/messages`                     | 1 request                |
| `add_attachment`        | `POST /users/{id}/messages/{id}/attachments`                     | 1 request + upload bytes |
| `create_upload_session` | `POST /users/{id}/messages/{id}/attachments/createUploadSession` | 1 request                |
| `upload_chunk`          | `PUT {upload_url}`                                               | 1 request + upload bytes |
| `count_folder_messages` | `GET /users/{id}/mailFolders/{id}?$select=totalItemCount`        | 1 request                |
| `list_folder_messages`  | `GET /users/{id}/mailFolders/{id}/messages`                      | 1 request                |

### Why Outlook Is the Most Parallelizable Pool

Because the 10,000 req/10min budget is **per mailbox**, not per tenant, you can back up N mailboxes in parallel without any mailboxes competing for each other's quota. The constraint is concurrency (4 parallel requests per mailbox) and the Atlas sliding window limiter (9,600 requests per mailbox per 10 minutes, leaving a 4% safety margin).

---

## Pool 2: SharePoint / OneDrive

> **Official source:** [How to avoid getting throttled or blocked in SharePoint Online](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)

**Scope:** Per app per tenant. All API calls to SharePoint and OneDrive from a single app registration share one quota bucket per tenant, regardless of the number of sites, drives, or users targeted.

**Cost model: resource units (RU)** — each Graph API request has a predetermined cost.

::: warning OneDrive Support
SharePoint/OneDrive backup is on the Atlas roadmap. The limits below are documented now so SaaS operators can design their scheduling logic in advance. Atlas does not currently emit any cost data for this pool.
:::

### Resource Unit Costs

| Operation type                               | Cost     |
| -------------------------------------------- | -------- |
| Single-item GET (by ID, delta with token)    | **1 RU** |
| Multi-item list/search, delta without token  | **2 RU** |
| Permission operations, `$expand=permissions` | **5 RU** |

> Microsoft reserves the right to change these costs. The Atlas `GRAPH_SERVICE_LIMITS.sharepoint_onedrive` constant provides the current values.

### Per-App-Per-Tenant Limits (Scale with Tenant License Count)

| Licenses      | RU / minute | RU / 24 hours |
| ------------- | ----------- | ------------- |
| 0–1,000       | 1,250       | 1,200,000     |
| 1,001–5,000   | 2,500       | 2,400,000     |
| 5,001–15,000  | 3,750       | 3,600,000     |
| 15,001–50,000 | 5,000       | 4,800,000     |
| 50,000+       | 6,250       | 6,000,000     |

### Tenant-Level Limits (All Apps Combined)

| Licenses      | RU / 5 minutes |
| ------------- | -------------- |
| 0–1,000       | 18,750         |
| 1,001–5,000   | 37,500         |
| 5,001–15,000  | 56,250         |
| 15,001–50,000 | 75,000         |
| 50,000+       | 93,750         |

### User-Level Limits

| Limit    | Value             |
| -------- | ----------------- |
| Requests | 3,000 / 5 minutes |
| Ingress  | 50 GB / hour      |
| Egress   | 100 GB / hour     |

### Per-App-Per-Tenant Bandwidth

| Direction | Limit         |
| --------- | ------------- |
| Ingress   | 400 GB / hour |
| Egress    | 400 GB / hour |

### RateLimit Headers (Preview)

SharePoint proactively returns `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers (IETF draft-03) when an app consumes ≥ 80% of its 1-minute resource unit budget. This allows clients to back off before hitting `429`. Atlas will read these headers when OneDrive backup support is implemented.

> Source: [RateLimit headers — preview](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview)

### Throttle Responses

- `429 Too Many Requests` — app exceeded the rate limit. Includes `Retry-After`.
- `503 Service Unavailable` — service-level load spike. Also includes `Retry-After`.

Throttled requests still count toward limits. Persistent offenders may be blocked completely (503 indefinitely, with notification via the Office 365 Message Center).

### Scheduling Implication

Because the SharePoint budget is per-tenant (not per-user), a SaaS operator must track and coordinate OneDrive backup jobs across all users of a given tenant in their external scheduler. You cannot run N OneDrive backups in parallel for the same tenant the way you can for N mailbox backups.

### Future Atlas Operations — SharePoint/OneDrive Pool

| Operation                     | Graph endpoint                          | RU cost              |
| ----------------------------- | --------------------------------------- | -------------------- |
| `delta_drive` (with token)    | `GET /drives/{id}/root/delta?token=...` | 1 RU                 |
| `delta_drive` (without token) | `GET /drives/{id}/root/delta`           | 2 RU                 |
| `list_drive_items`            | `GET /drives/{id}/items/{id}/children`  | 2 RU                 |
| `download_file`               | `GET /drives/{id}/items/{id}/content`   | 1 RU + egress bytes  |
| `upload_file`                 | `PUT /drives/{id}/items/{id}/content`   | 1 RU + ingress bytes |
| `get_drive`                   | `GET /users/{id}/drive`                 | 1 RU                 |

---

## Pool 3: Identity / Directory (Microsoft Entra ID)

> **Official source:** [Graph throttling limits — Identity and access service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits)

**Scope:** Per app per tenant, plus a global per-app limit across all tenants. Uses a token-bucket algorithm.

**Cost model: resource units (RU)** — each operation has a base RU cost that can be modified by query parameters.

### Per-App-Per-Tenant Limits (Scale with Tenant User Count)

| Tenant tier | Users  | RU / 10 seconds |
| ----------- | ------ | --------------- |
| S           | < 50   | 3,500           |
| M           | 50–500 | 5,000           |
| L           | > 500  | 8,000           |

**Write quota per app+tenant:** 3,000 requests / 2 minutes 30 seconds.

### Global Per-App Limits (Across All Tenants)

| Limit | Value                       |
| ----- | --------------------------- |
| Read  | 150,000 RU / 20 seconds     |
| Write | 35,000 requests / 5 minutes |

### Per-Tenant Limits (All Apps Combined)

| Limit          | Value              |
| -------------- | ------------------ |
| Write requests | 18,000 / 5 minutes |

### Base Resource Unit Costs (Selection)

Atlas uses only read operations in the Identity pool. Relevant base costs:

| Endpoint                             | Base cost      |
| ------------------------------------ | -------------- |
| `GET /users`                         | **2 RU**       |
| `GET /users/{id}`                    | 1 RU (default) |
| `GET /reports/getMailboxUsageDetail` | 1 RU (default) |
| Unlisted read paths                  | **1 RU**       |

### Cost Modifiers

Applied on top of the base cost:

| Modifier               | Effect |
| ---------------------- | ------ |
| `$select` present      | −1 RU  |
| `$expand` present      | +1 RU  |
| `$top` with value < 20 | −1 RU  |

Atlas uses `$select` on `/users` calls, reducing effective cost to approximately 1 RU per call in practice.

### Atlas Operations — Identity Pool

| Operation                        | Graph endpoint                       | Effective cost                               |
| -------------------------------- | ------------------------------------ | -------------------------------------------- |
| `mailbox_exists`                 | `GET /users/{id}?$select=id`         | ~1 RU (1 base − 0, $select modifier applies) |
| `list_users` (mailbox discovery) | `GET /users?$select=...&$filter=...` | ~1 RU per page (2 base − 1 for $select)      |

### Identity Pool in Practice

Atlas consumes the Identity pool only during mailbox discovery (listing all mailboxes in a tenant) and individual mailbox existence checks. This is a small number of requests per backup job — typically a handful at startup. The Identity pool becomes a scheduling concern only at very large scale, with frequent tenant-wide mailbox listing across many tenants simultaneously.

---

## Cross-Pool Summary

| Pool                    | Scope       | Cost model     | Bottleneck for                               |
| ----------------------- | ----------- | -------------- | -------------------------------------------- |
| **Outlook**             | Per mailbox | Flat           | Mail backup and restore (primary bottleneck) |
| **SharePoint/OneDrive** | Per tenant  | Resource units | OneDrive backup (future)                     |
| **Identity**            | Per tenant  | Resource units | Mailbox discovery at scale                   |
| **Global**              | Per app     | Flat           | 100+ concurrent tenants                      |

Key implications for SaaS scheduling:

- **Outlook is the most parallelizable pool** — N parallel mailbox backups use N independent budgets. Scale horizontally.
- **SharePoint requires tenant-level coordination** — treat all OneDrive jobs for one tenant as sharing one budget.
- **Identity cost is minimal per job** — ignore for individual jobs; monitor at the tenant-wide discovery level.
- **Global limit is a backstop** — unlikely to be reached unless you are operating hundreds of active tenants simultaneously.

---

## Using the Limits in Code

Atlas exports the `GRAPH_SERVICE_LIMITS` constant so your SaaS layer can use the same authoritative numbers for scheduling decisions:

```typescript
import { GRAPH_SERVICE_LIMITS } from '@atlas/sdk';
import type { OperationCost } from '@atlas/sdk';

// After a backup job completes:
const cost: OperationCost = result.graph_cost;
const outlook = GRAPH_SERVICE_LIMITS.outlook;

// Estimate cooldown: how much of the 10-min window did we consume?
const outlook_used = cost.by_service.outlook?.requests ?? 0;
const usage_ratio = outlook_used / outlook.requests_per_window;
const cooldown_ms = Math.ceil(usage_ratio * outlook.window_duration_ms);

console.log(`Used ${outlook_used}/${outlook.requests_per_window} Outlook requests`);
console.log(`Suggested cooldown: ${cooldown_ms}ms`);
```

See the [Programmatic SDK reference](/reference/sdk) for the full `OperationCost` type and a complete pg-boss orchestration example.

---

## Official Microsoft Documentation

| Resource                               | URL                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global and all service-specific limits | https://learn.microsoft.com/en-us/graph/throttling-limits                                                                                                       |
| General throttling guidance            | https://learn.microsoft.com/en-us/graph/throttling                                                                                                              |
| Outlook service limits                 | https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits                                                                                |
| SharePoint/OneDrive throttling         | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online                             |
| SharePoint RateLimit headers           | https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online#ratelimit-headers---preview |
| Identity and access service limits     | https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits                                                                    |
