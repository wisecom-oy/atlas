# Roadmap

What is planned for Atlas next. Order reflects priority, not dates. Shipped changes are listed in the [GitHub releases](https://github.com/wisecom-oy/atlas/releases).

<ol class="wc-roadmap">
  <li data-status="next">
    <span class="wc-roadmap-status">Next</span>
    <h3>v6: stable storage keys</h3>
    <p>Outlook keyed by Entra object ID and SharePoint by hostname-free site ID, so renames no longer orphan backups. Breaking; see <a href="/migration/v6">Migrating to v6</a>.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Calendars and contacts</h3>
    <p>Exchange backup today covers mail only. Calendar events, including recurrences and attachments, and contacts become first-class items with their own restore.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Microsoft Teams</h3>
    <p>Channel messages with replies and reactions, membership, and channel settings. Team files are already covered by SharePoint backup.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Microsoft Entra ID</h3>
    <p>Versioned export of users, groups, roles, app registrations and Conditional Access policies, with a reviewed, diff-based reapply path.</p>
  </li>
  <li data-status="planned">
    <span class="wc-roadmap-status">Planned</span>
    <h3>Recovery into a clean tenant</h3>
    <p>Restore a compromised or lost tenant's data into a different tenant, with a mapping from old identities to new ones. Builds on the Entra ID export.</p>
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
</ol>

## Constraints that shape the plan

**Teams.** Graph has no delta query for channel messages. Bulk export uses protected `getAllMessages` endpoints that Microsoft approves per application and bills per message, so incremental backup will rely on change notifications. Chats hold personal data with different retention expectations and will be opt-in.

**Entra ID.** Restore is reapplication, not byte recovery: a recreated policy or app gets a new object ID, and client secrets cannot be read back. Atlas will never overwrite a live directory silently. Graph keeps deleted directory objects for only 30 days and has no history for Conditional Access changes, which is the gap Atlas fills.

**Clean-tenant recovery.** Object IDs differ between tenants, so every owner, mailbox and site needs an explicit mapping before anything is written. Unmapped identities are reported, never guessed.

**Planner.** Graph has no delta query for Planner, so each run re-reads plans and compares ETags. Recreated tasks get new IDs, completion history cannot be written back, and task comments live in the group's conversations rather than in Planner. Premium plans (Planner Plan 1 and up) use a different API and are out of scope.

## Suggest a feature

Send ideas to [info@wisecom.fi](mailto:info@wisecom.fi) or [open an issue on GitHub](https://github.com/wisecom-oy/atlas/issues). Wisecom prioritizes the roadmap against its own business goals, so not every request will be scheduled. When a suggestion is a good fit for both sides, we may build it.

The most direct way to shape the engine is to contribute. Pull requests are welcome; start with [CONTRIBUTING.md](https://github.com/wisecom-oy/atlas/blob/main/CONTRIBUTING.md).
