---
name: write-issue
description: >-
  Write a GitHub issue for this repository -- bug report or feature request.
  Produces a short, concrete, reproducible issue with acceptance criteria, and
  scrubs real tenant data before anything is filed.
when_to_use: >-
  Use whenever the user asks to write, draft, open, file, create, or report an
  issue, a bug, a defect, or a feature request, including "make an issue for
  this" after a debugging session.
---

# Writing an Issue

The rule: **describe the problem, give enough context to reproduce or understand
it, and define what "done" means.** Short and concrete beats thorough and buried.

## Never put real tenant data in an issue

**This is mandatory and comes before everything else.** While debugging you may
have read genuine tenant content -- mailbox addresses, display names, file names,
message subjects, site URLs, drive item IDs. None of it may reach an issue.
GitHub issues are permanent and, for this repository, visible beyond the tenant's
operators.

Replace every real value with a generic one, using the same substitution
throughout so the reproduction still makes sense:

| Real value                         | Use instead                                    |
| ---------------------------------- | ---------------------------------------------- |
| Mailbox / UPN / username           | `john.doe@example.com`                         |
| Person's display name              | `John Doe`                                     |
| A second person                    | `jane.roe@example.com` / `Jane Roe`            |
| Tenant domain                      | `contoso.onmicrosoft.com`                      |
| Tenant / client GUID               | `00000000-0000-0000-0000-000000000000`         |
| SharePoint site URL                | `https://contoso.sharepoint.com/sites/Example` |
| File name                          | `Report.docx`, `Budget.xlsx`                   |
| Custom folder name                 | `Example Folder`                               |
| Message subject                    | `Example subject`                              |
| Message / drive item ID            | truncate to `AAMkAG...` or write `<item-id>`   |
| S3 bucket name                     | `atlas-example-bucket`                         |
| Internal hostname                  | `storage.example.com`                          |
| Any token, key, secret, passphrase | omit entirely -- never a placeholder           |

Do **not** scrub things that carry the diagnosis: HTTP status codes, Graph error
codes (`ErrorItemNotFound`, `activityLimitReached`), stack frames, file paths
inside this repository, well-known folder names (`inbox`, `sentitems`), Graph
endpoint shapes (`/users/{id}/messages/{id}`), and byte counts. An issue scrubbed
of its evidence is useless.

Keep the real-to-placeholder mapping out of the issue entirely. Sanitise pasted
logs line by line -- Atlas log lines and `graph-tap` output contain UPNs and site
paths even though credentials are already redacted.

## Structure

Match the repo's existing templates in `.github/ISSUE_TEMPLATE/`, and append
acceptance criteria, which the templates do not cover.

**Title** — state the outcome or problem. The house style in this repo prefixes
an area and, for bugs, often names the mechanism after an em dash:

```
Backup job should recover after temporary storage failure
SDK: a pre-aborted operation still emits a discovering event
replicate/rehydrate -s only resolves Outlook snapshots — find_by_snapshot searches the manifests/ prefix only
```

**For a bug**, cover:

- **Atlas version** (required by the template)
- **Description** — what happened, in a few sentences, behaviour not implementation
- **Steps to reproduce** — minimal and numbered
- **Expected** / **Actual**
- **Logs / error output** — the relevant lines, sanitised, not the whole run
- **Interface** — CLI, SDK, or Both (required by the template)
- **Environment** — paste the output of `./tools/diagnostics.sh`
- **Acceptance criteria**

**For a feature**, cover:

- **Problem or motivation** — what is not possible today, and why it matters
- **Proposed solution** — what should be possible; CLI flags or SDK surface if relevant
- **Alternatives considered**
- **Scope** — CLI, SDK, Backup, Restore, Verification, Catalog, Deletion, Storage, Encryption
- **Constraints** that limit the design
- **Acceptance criteria**

**Acceptance criteria** must be specific and testable — what has to be true for
this to be done. Include the negative cases:

```
- Temporary storage failures are retried.
- The job continues automatically after recovery.
- Permanent failures are still reported clearly.
- Relevant retry events are logged.
```

## Collect the environment

```bash
./tools/diagnostics.sh
```

Prints OS, kernel, arch, Node, pnpm, Atlas version, git branch and commit, Docker,
and which config sources exist. It never prints secret values. It does print
`ATLAS_S3_ENDPOINT` when set, so check that line before pasting if the endpoint is
a private hostname.

Only include it for bugs. A feature request does not need an environment dump.

## Before filing

1. **Search for duplicates**: `gh issue list --search "<keywords>" --state all --limit 10`
2. **Re-read for tenant data** using the table above. This is the last checkpoint.
3. **Show the user the full draft and ask for approval.** Never file an issue
   without it — an issue is a permanent public artifact.

## Filing it

```bash
gh issue create --title "<title>" --label bug --body-file <path>
```

Use `--body-file`, not `--body`, so formatting survives. Note that
`.github/ISSUE_TEMPLATE/` applies only to the web UI: `gh issue create` does not
expand it, so the body must already contain every section above, and the label the
template would have applied has to be passed explicitly.

| Label              | Use                                       |
| ------------------ | ----------------------------------------- |
| `bug`              | defects — the template's default          |
| `enhancement`      | feature requests — the template's default |
| `documentation`    | docs-only changes                         |
| `question`         | needs clarification before work           |
| `priority: high`   | urgent or high-impact                     |
| `priority: medium` | plan into an upcoming cycle               |
| `priority: low`    | nice to have                              |

Set a priority label only when the user states the urgency or it is obvious from
impact, such as data loss. Otherwise leave it off rather than guessing.
