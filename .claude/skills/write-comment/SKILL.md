---
name: write-comment
description: >-
  Write a GitHub comment, review reply, or pull request description in the
  repository owner's own voice, posted from their personal account. Keeps the
  writing first-person, neutral, and plain, and never attributes the work to an
  assistant or a model.
when_to_use: >-
  Use whenever the user asks to comment on an issue or pull request, reply to
  review feedback, post findings or a verification report, update a PR
  description, or "leave a note" on something. Also use before posting any
  comment produced at the end of a debugging or implementation session.
---

# Writing a GitHub Comment

The rule: **the comment is the user talking.** He did the work, he ran the
commands, he found the cause, and he is making the call. Write it the way he
would write it, post it from his account, and leave the tooling out of it
entirely.

New issue bodies are a different job: use `write-issue`.

## Identity

Comments go out from whatever account `gh` is authenticated as, which is the
user's personal account. That is the default and it needs no discussion. Confirm
with `gh auth status` if there is any doubt.

Only attribute a comment to an assistant, a model, or a vendor when the user
**explicitly asks for it in that request**. "Post this as the bot", "make clear
this was machine generated", or similar. Then say so in one plain sentence at the
top and carry on normally. A general instruction from an earlier, unrelated turn
is not consent for this comment.

Never add attribution the user did not ask for. No `Co-authored-by` trailers, no
"generated with", no model names, no tool footers, no signature blocks, no
disclosure that a comment was drafted rather than typed.

## Voice

First person, active, and owning the work. The user debugged it, decided it, and
where relevant got it wrong.

| Do not write | Write |
| --- | --- |
| The assistant traced the failure to X | I traced the failure to X |
| As an AI, I cannot verify this on Windows | I have not verified this on Windows |
| The fix was applied to both copies | I fixed both copies |
| It is recommended to fix both adapters | I fixed both adapters, because leaving one is the same bug twice |
| Should I file a separate issue? | I will file this separately unless someone objects |
| Say the word and I will do it | Happy to do it, just tell me which way you want it |
| This PR implements the following changes | Here is what I changed and why |
| Analysis indicates the root cause is Y | The root cause is Y |
| I hope this helps, let me know if you need anything | (delete it) |

Passive voice is the usual tell. "The tests were updated" hides who decided
what. "I updated the tests" is shorter and truer.

Never refer to the tooling, the session, the prompt, the context window, or the
model. Not even obliquely. "I ran out of context" is not a thing the user says
in a comment.

## Register

Neutral and informative. No personality, no persona, no enthusiasm, no jokes,
no emoji, no exclamation marks. Nothing that reads like a brand voice.

Casual is fine where it is clearer. Plain words beat ceremony:

- "this was my fault" over "this represents an oversight on my part"
- "burned all five retries" over "exhausted the configured retry allocation"
- "the test was junk" over "the test exhibited insufficient rigour"
- "grabbed the wrong stash" over "an incorrect stash entry was selected"

Generally understood slang is allowed: "flaky", "junk", "hammering", "blew up",
"drive-by fix", "paper over". Skip anything regional or obscure enough to need
explaining, and skip jargon that adds nothing. Keep the precise term when
precision is the point: status codes, header names, function names, byte counts,
and timings all stay exact.

Do not pad. Cut any sentence that survives deletion without losing information.
Avoid the stock connectives that signal filler: "It is worth noting that",
"Additionally", "Furthermore", "In conclusion", "At the end of the day".

## What a comment carries

Enough for a reviewer to agree or disagree without rerunning the work:

- What was wrong, in one or two sentences.
- The evidence, pasted as output rather than described. Numbers, log lines, test
  names, exit codes.
- The decision and the reason, including the option not taken when it was a real
  choice.
- What is **not** verified, stated plainly and where the claim is made.

## Getting it wrong

When the work included a mistake, say it in first person and move on. No
apology paragraph, no self-flagellation, no burying it at the bottom.

> CI caught my test, not the fix. The 1 GB case allocated 256 buffers to check
> arithmetic a 100 MB file proves just as well, and it blew the per-test timeout
> under coverage. Folded it into the smaller case.

That reads like an engineer. "An issue was identified with the test
implementation" does not.

## First person is not a licence to invent

Voice controls attribution, never facts. Do not write "I ran the suite", "I
tested this on a real tenant", or "I confirmed the fix" unless it actually
happened. If something was not checked, the comment says so:

> Not verified end to end: producing this needs a seeded tenant, so the unit
> tests are the only evidence here.

A first-person comment full of unearned claims is worse than an obviously
machine-written one, because nobody can tell which parts to trust.

## Formatting

- No em dash, and no `--` inside a phrase. Rewrite, split the sentence, or use a
  comma. Same prose rule as the rest of the repo. Issue **titles** are the
  documented exception; comments are prose.
- Evidence goes in fenced blocks. Tables for option and flag comparisons.
- Bold sparingly, for the one thing a skimming reader must not miss. A comment
  where every third phrase is bold reads as machine output.
- Short paragraphs, one idea each. Bullets for lists of things, not as a
  substitute for sentences.
- Match the surrounding thread. A one-line question gets a one-line answer, not
  a report.

## Pull request descriptions

A PR body is a comment with a fixed skeleton. Everything above applies, plus
the sections from `.github/PULL_REQUEST_TEMPLATE.md`:

- `## Summary`: what the PR does and why, in plain sentences, with `Closes #N`
  for the issue it fixes.
- `## Changes`: concrete bullets, one per thing changed.
- `## Checklist`: ticked only for what was actually run.

`Summary` and `Changes` are what the `Changes explained` pre-merge check
enforces, spelled exactly as the template spells them. The `Checklist` is not
gated, so a body without it still passes, but a ticked box is a claim that the
command ran and the rule against unearned claims applies to it. Extra sections
under those are fine, and a long PR usually needs one for evidence or for the
option not taken, though they never replace `Summary` and `Changes`. Delete
every template HTML comment, including the one above `## Summary`, along with
the placeholder bullets: a leftover comment fails the check, and an empty
section reads as a PR nobody bothered to describe.

`CONTRIBUTING.md` carries the same rule for human contributors. Keep the two in
sync when either changes.

## Never

- Anything covered by **This Is a Public Repository** in `.claude/CLAUDE.md`:
  secrets, tenant or customer data, personal information, internal system
  detail. A comment is published the moment it is posted and editing it later
  does not unpublish it. Sanitise pasted output line by line rather than
  trusting that it is clean.
- Claims of verification that did not happen.
- Unrequested attribution to a model, an assistant, or a vendor.

## Posting

Use `--body-file` so formatting survives the shell.

```bash
gh issue comment <number> --body-file <path>
gh pr comment <number> --body-file <path>
gh pr review <number> --comment --body-file <path>
gh pr edit <number> --body-file <path>          # replaces the PR description
```

Reply inside an existing review thread through the API when the comment belongs
to a specific line rather than the PR as a whole:

```bash
gh api repos/:owner/:repo/pulls/<number>/comments/<comment-id>/replies \
  -f body="$(cat <path>)"
```

## Before posting

1. Read it back as the user. Anything that sounds like a tool describing its own
   output gets rewritten.
2. Every "I" claim is something that actually happened.
3. Nothing a public repository should not carry: no secrets, tenant data,
   personal details, or internal system detail, and no unrequested attribution.
4. No em dash or `--` used as punctuation.
5. Delete the last paragraph if it only restates the first.
