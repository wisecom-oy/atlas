# Microsoft Graph API Skill

Atlas is built almost entirely against Microsoft Graph, and Graph carries more than
27,700 endpoints that change weekly. Any coding assistant working in this repository
has a training cutoff, so it will confidently invent endpoint paths, miss a required
header, or reach for a path that was renamed. The `msgraph` agent skill removes the
guessing: it bundles the whole Graph surface as local indexes and answers lookups
offline in milliseconds.

Install it once per clone:

```bash
npx skills add merill/msgraph
```

That writes the skill to `.agents/skills/msgraph/` and symlinks it into
`.claude/skills/`. Both locations are discovered: `.agents/skills/` is the native
location for OMP-based agents, and the symlink covers Claude Code reading
`.claude/skills/`. The two resolve to the same file, so the skill is loaded once
rather than twice. Skills are enumerated when a session starts, so reload skills or
start a new session after installing.

`skills-lock.json` records the source and a content hash, and it is committed, so
every clone installs the same revision.

## What it answers

| Command | Use it for |
|---|---|
| `sample-search` | Curated task-to-query samples. Highest quality, try first. |
| `api-docs-search` | Permissions, query parameters, required headers, and which properties need `$select` for a known endpoint or resource. |
| `openapi-search` | The full 27,700-endpoint catalog, when the path cannot be found any other way. |

Run them through the launcher, which picks the right prebuilt binary for the platform:

```bash
bash .agents/skills/msgraph/scripts/run.sh openapi-search --query "mail folder delta" --limit 3
bash .agents/skills/msgraph/scripts/run.sh api-docs-search --resource message
bash .agents/skills/msgraph/scripts/run.sh sample-search --query "delta query" --product exchange
```

Output is JSON. All three run with no network access.

## Why this matters for Atlas specifically

The parts of Graph that Atlas depends on are exactly the parts an assistant gets
wrong from memory:

- **Delta queries.** Every backup path is a delta sync. `api-docs-search --resource message`
  states which properties come back by default and which need `$select`, which is what
  determines whether a manifest entry is complete.
- **Permission scopes.** Atlas runs app-only. The docs index separates delegated from
  application permissions, so a scope can be confirmed before it is added to the app
  registration rather than after a 403 in an e2e run.
- **Required headers.** `ConsistencyLevel: eventual` is mandatory for `$count` and
  `$search` on directory objects and is a common omission.
- **Throttling semantics.** `references/docs/throttling.md` documents `Retry-After` and
  backoff, which is the contract `with_graph_retry` and `graph-request-error-handler.ts` implement.

## Verify the API version before copying anything into `src`

The skill defaults to the **beta** endpoint, and its search results link to
`view=graph-rest-beta` documentation. Atlas ships against **v1.0**: `graph-client.factory.ts`
hardcodes `https://graph.microsoft.com` and takes the Graph SDK's stable default version.

A beta path or a beta-only property that reaches production code is a regression, because
Microsoft can change or withdraw it without notice. Treat a result from this skill as a
lead, then confirm the endpoint and every property exists in v1.0 before it lands in a
package. Pass `--api-version v1.0` on any `graph-call` so the tool matches what Atlas does.

## Authentication: knowledge mode is the sanctioned mode

The skill can also authenticate and call Graph directly. **Do not point it at a customer
tenant.** Use it for search and knowledge only, which needs no credentials at all.

This is a hard line rather than a preference. The skill is a third-party binary that runs
with full agent permissions, its published risk assessment carries a medium-risk rating and
one dependency alert, and its token cache is outside anything Atlas controls or audits. None
of that is disqualifying for reading a local index, and all of it matters the moment real
tenant credentials are involved.

When live Graph traffic is genuinely needed, use the paths this repository already owns and
audits:

- `graph-tap` records the requests Atlas actually sends. See [Graph Request Tracing](/development/graph-tap).
- The E2E suite runs against the dedicated E2E app registration, with its own credentials
  and its own redaction boundary, proved before the first Graph call.

If direct execution is ever unavoidable, use a throwaway developer tenant, set
`MSGRAPH_NO_TOKEN_CACHE=true` so no token is persisted, and never populate
`MSGRAPH_CLIENT_SECRET` with an Atlas app registration secret. Writes require an explicit
`--allow-writes` flag and `DELETE` is blocked by the tool, but neither guard protects a
tenant from a mistaken `PATCH`, and neither is a substitute for using a tenant that does not
hold customer data.

## Why it is not committed

The indexes and the per-platform binaries come to roughly 117 MB across 25 files, so
`.agents/skills/` is ignored by git and each clone installs its own copy.
`skills-lock.json` is committed instead: it pins `merill/msgraph` and the content hash, so
the install is reproducible without carrying the payload in history. Re-run the install
command to pick up a newer index.
