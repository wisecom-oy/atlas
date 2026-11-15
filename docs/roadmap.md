---
description: 'The Atlas roadmap: planned work in priority order, with shipped changes listed in the GitHub releases.'
next: false
---

# Roadmap

What is planned for Atlas next. Order reflects priority, not dates. Shipped changes are listed in the [GitHub releases](https://github.com/wisecom-oy/atlas/releases).

<ol class="wc-roadmap">
  <li data-status="progress">
    <span class="wc-roadmap-status">In progress</span>
    <h3>Calendars</h3>
    <p>Calendar backup, restore, listing, and verification, with recurring series, exceptions, and file attachments (issue #134). Exchange backup already covers mail and contacts. See <a href="/calendar-backup">Calendar backup</a>.</p>
  </li>
  <li data-status="progress">
    <span class="wc-roadmap-status">In progress</span>
    <h3>Microsoft Teams</h3>
    <p>Channel messages with replies, reactions, and edits, membership, channel settings, and tabs. Backup and verification are available; restore is pending. Team files are covered by SharePoint backup.</p>
  </li>
  <li data-status="progress">
    <span class="wc-roadmap-status">In progress</span>
    <h3>Sharing permissions for OneDrive and SharePoint</h3>
    <p>Who a file or folder is shared with, captured on backup and re-applied on restore only when you ask for it with <code>--restore-permissions</code> (issue #580). A grantee that no longer exists is reported without failing the run.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Certificate authentication</h3>
    <p>Sign-in with a certificate instead of a client secret (issue #778). It is the prerequisite for restoring site and library permissions and folder colours, which Microsoft 365 accepts only through the SharePoint REST API.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Microsoft Entra ID</h3>
    <p>Versioned export of users, groups, roles, app registrations and Conditional Access policies, with a reviewed, diff-based reapply path.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Recovery into a clean tenant</h3>
    <p>Restore a compromised or lost tenant's data into a different tenant, with a mapping from old identities to new ones. Builds on the Entra ID export. Restoring one owner or site into another tenant already works with <a href="/reference/cli-recovery#cross-tenant-restore"><code>--target-profile</code></a> and the SDK's <a href="/reference/sdk#cross-tenant-restore"><code>createTenant</code></a>.</p>
  </li>
  <li data-status="exploring">
    <span class="wc-roadmap-status">Exploring</span>
    <h3>Argon2id key derivation</h3>
    <p>A memory-hard alternative to scrypt. Existing tenants move over with <a href="/reference/cli#atlas-keys"><code>atlas keys rewrap</code></a>, without re-encrypting data.</p>
  </li>
  <li data-status="exploring">
    <span class="wc-roadmap-status">Exploring</span>
    <h3>Microsoft Planner</h3>
    <p>Plans, buckets, tasks and their details, read app-only with <code>Tasks.Read.All</code>. Restore recreates them as new objects.</p>
  </li>
  <li data-status="exploring">
    <span class="wc-roadmap-status">Exploring</span>
    <h3>Power BI</h3>
    <p>Reports and semantic models exported per workspace through the Power BI REST API. Read app-only once a Power BI administrator enables <strong>Allow service principals to use Power BI APIs</strong> and the app is a member or admin of each workspace. No Microsoft Graph permission covers it.</p>
  </li>
</ol>

## Constraints that shape the plan

**Teams.** Scope is channel content: messages with replies and reactions, team and channel membership, tabs, and channel configuration.

- Each channel has its own sync checkpoint. A channel that cannot be read incrementally is read in full, without failing the run.
- Reading channel messages app-only may require Microsoft's protected API approval for `ChannelMessage.Read.All`.
- Restore is export-only, because Microsoft Graph cannot repost a message with its original author and timestamp.
- 1:1, group, and meeting chats are out of scope. They hold personal conversations with separate legal and retention obligations, bulk access goes through the metered `getAllMessages` export API, and every user's chats would have to be listed separately.

**Sharing permissions.** Scope is the sharing on files and folders in OneDrive and SharePoint document libraries.

- A change to sharing alone is picked up on the next incremental backup without downloading the file again.
- Restore is opt-in, so an ordinary restore never widens access. Owner grants are stored but not re-applied.
- Some grants cannot come back as they were: a grantee that has left the tenant, an anonymous link the tenant now blocks, or a link that has expired. Each is reported.
- Site and library permissions and folder colours can be read but not written with a client secret. The SharePoint REST API that writes them requires certificate authentication.
- Shortcuts to shared folders do not appear in Microsoft Graph's change listing, so they need a separate scan (issue #777).

**Entra ID.** Restore means reapplying configuration, not recovering bytes: a recreated policy or app gets a new object ID, and client secrets cannot be read back. Atlas will never overwrite a live directory silently. Microsoft keeps deleted directory objects for only 30 days and keeps no history of Conditional Access changes, which is the gap Atlas fills.

**Clean-tenant recovery.** Object IDs differ between tenants, so every owner, mailbox, and site needs an explicit mapping before anything is written. Unmapped identities are reported, never guessed. A single cross-tenant restore already takes its target explicitly. What is missing is the tenant-wide mapping that drives every owner at once.

**Planner.** Microsoft Graph cannot report Planner changes incrementally, so each run re-reads plans and compares ETags. Recreated tasks get new IDs, completion history cannot be written back, and task comments live in the group's conversations rather than in Planner. Premium plans (Planner Plan 1 and up) use a different API and are out of scope.

**Power BI.** Power BI is not part of Microsoft Graph, so the permissions on the Atlas app registration do not cover it. A Power BI administrator must enable **Allow service principals to use Power BI APIs** in the tenant settings, and the app must be added to each workspace as a member or admin. Personal workspaces (My Workspace) cannot be read by a service principal.

## Suggest a feature

Send ideas to [info@wisecom.fi](mailto:info@wisecom.fi) or [open an issue on GitHub](https://github.com/wisecom-oy/atlas/issues). Wisecom prioritizes the roadmap against its own business goals, so not every request will be scheduled. When a suggestion fits both sides, we may build it.

The most direct way to shape the engine is to contribute. Pull requests are welcome; start with [CONTRIBUTING.md](https://github.com/wisecom-oy/atlas/blob/main/CONTRIBUTING.md).
