---
name: wisecom-coding
description: >
  Apply Wisecom's language-agnostic coding playbook when writing, fixing,
  refactoring, reviewing, testing, or designing software in any repository.
  Covers contracts, invariants, naming, functions, state, safe typing, security,
  errors, APIs, concurrency, transactions, retries, performance, observability,
  architecture, scaling, dependencies, and evidence-based verification. Also use
  whenever code sends email or serves public web pages, even if the user does not
  mention it: email deliverability (SPF, DKIM, DMARC, unsubscribe, suppression,
  spam filtering) and SEO/AI discovery (crawlers, robots.txt, redirects, canonicals,
  sitemaps, structured data, GEO).
license: MIT
metadata:
  author: wisecom-oy
---

# Wisecom Coding

Treat coding as a verification loop, not text generation. Optimize for **local
reasoning**: a reader can understand behavior, effects, failures, and dependencies
without reconstructing hidden context from distant files.

Use this skill for implementation, bug fixes, refactoring, code review, and
architecture work. Translate examples into the strongest idiomatic mechanism in
the repository's language and ecosystem; no language, framework, vendor, or agent
is required.

## Priorities and rule strength

Existing repository invariants, architecture, tests, public contracts, and
documented conventions outrank generic stylistic guidance unless the task
explicitly changes them. A local bug fix is not permission to redesign the
surrounding architecture. Surface conflicting evidence or unsafe behavior rather
than silently rewriting contracts or weakening tests to fit a preferred design.

Resolve design conflicts in this order: correctness; security and data integrity;
clarity; testability; simplicity; maintainability; operability; performance;
consistency. Do not sacrifice correctness for brevity or security for convenience.
Do not introduce architecture merely to satisfy a stylistic rule.

MUST means required unless the task or existing architecture makes it impossible;
SHOULD is the default with concrete reasons for deviations; MAY is optional.
Name any impossible requirement and its consequence rather than silently skipping
it. These are engineering standards, not permission to override the user's task,
repository instructions, or the host agent's safety and tool constraints.

## Match depth to risk

Always inspect the local contract and affected callers, preserve repository
constraints, and run targeted checks. Choose depth by impact, not diff size:

| Change | Required depth |
| --- | --- |
| Trivial/local, with no sensitive behavior affected | Inspect the local contract and run targeted checks. No full chapter sweep, architecture analysis, or complete checklist. |
| Moderate behavioral change | Load relevant chapters, inspect and update behavioral tests where needed, and check applicable completion criteria. |
| Business-critical, stateful, or security-sensitive change | Load relevant chapters, perform a full failure-mode review of affected behavior, and review the complete definition of done. |

A one-line authorization or transaction change is not trivial. Escalate when
inspection reveals broader impact or uncertainty about invariants. Deeper review
still concerns the affected behavior, not unrelated distributed-system design.
These tiers govern the procedure and reference checklists below; they never waive
security, data integrity, or repository-required checks.

## Working procedure

1. **Understand.** Read the requirement, acceptance criteria, current implementation,
   callers, types, tests, configuration, and conventions. Find the owning module.
   Identify invariants, trust boundaries, side effects, expected outcomes, failure
   modes, concurrency, type guarantees, and relevant scale assumptions. Inspect
   unfamiliar APIs instead of guessing them.
2. **Design the smallest correct change.** Reuse existing patterns and boundaries.
   Define observable behavior, valid states, errors, resource lifetimes, and
   transaction guarantees. Preserve public behavior unless the task changes it.
   Do not invent extension points or redesign unrelated code.
3. **Protect behavior.** Use the existing test style. Capture important behavior
   and failure cases with a behavioral or characterization test where practical;
   reproduce bugs and keep useful regression coverage. Control external time,
   randomness, and network dependencies. Test contracts, not implementation trivia.
4. **Implement.** Use domain names, coherent functions, explicit mutation, and
   narrow ownership. Validate untrusted data at trusted boundaries; authorize
   sensitive operations. Preserve cleanup and atomic invariants. Distinguish
   domain outcomes from infrastructure failures. Bound resources and remote work;
   establish idempotency before retrying effects. Add useful, secret-safe telemetry
   where failures would otherwise be opaque.
5. **Refactor.** Once behavior is protected, improve names and reading flow,
   separate mixed abstraction levels, remove true duplicated policy and obsolete
   code, and reduce needless nesting and public surface. Do not abstract unrelated
   policies just because their code looks similar.
6. **Verify.** Run available, relevant formatting, lint, type, unit/integration,
   build, and configured security checks. Inspect the change for accidental edits,
   debug output, stale comments, disabled tests, secrets, unhandled errors,
   unnecessary dependencies, and unrelated churn. Never weaken checks to hide a bug.
7. **Check production failure behavior.** For business-critical, stateful, or
   security-sensitive work, consider
   timeout, duplicate execution, concurrent workers, process death halfway through,
   hostile input, unexpected dependency responses, diagnostics, secret exposure,
   and cross-user/tenant access. Return truthful outcomes, including partial failure.

## Loading the complete playbook

The references are the full standard, not optional summaries. At task start read
[the operating procedure](references/03-ai-coding-agent-operating-procedure.md)
and [the compact instruction block](references/31-compact-agent-instruction-block.md).
Then apply the risk tiers above. Trivial/local changes need no additional chapter
loading unless inspection exposes a relevant uncertainty or a domain signal below.
For moderate and high-risk changes, read every relevant chapter, including its
caveats and examples.
A retrying payment operation needs contracts, errors, security, concurrency,
typing, tests, and observability—not just the chapter matching its headline.

For non-trivial work use [the seven-phase workflow](references/29-end-to-end-implementation-workflow.md)
at the selected depth. Consult [the decision rules](references/28-explicit-decision-rules-for-coding-agents.md)
when a design or review question calls for them. Use applicable sections of
[the definition of done](references/30-definition-of-done-checklist.md) for moderate
changes and review the full checklist for high-risk changes. Report relevant
checks that were unavailable rather than assuming they passed.

### Domain chapters load from code signals

Chapters 32 and 33 carry provider rules agents do not know by default. Load them
when inspection shows the change touches one of these signals, even if the user
never mentions deliverability, SEO, or AI search. This applies at every risk tier:
a one-line `robots.txt`, redirect, or DKIM-signing-order change can silently remove
a site from search or send mail to spam. Read the sections covering the touched
behavior, apply their Never lists, and surface any violated rule to the user.

| Signal in code, config, or task | Load |
| --- | --- |
| Sending email: SMTP clients, ESP SDKs/APIs (SES, SendGrid, Postmark, Mailgun, and similar), MIME building, mail templates, newsletters, notifications, password-reset/verification mail, bounce or unsubscribe handling, `List-Unsubscribe`, suppression lists, SPF/DKIM/DMARC DNS records | [32. Email Deliverability](references/32-email-deliverability.md) |
| Public web pages: HTML routes, SSR/SSG frameworks, `<head>`/meta tags, status codes for missing or moved pages, redirects, URL or route changes, pagination, faceted filters, `robots.txt`, `sitemap.xml`, canonical/`hreflang`, JSON-LD, product/business feeds, CDN/WAF bot rules, site migrations, search or AI-referral analytics | [33. SEO and AI Discovery](references/33-seo-and-ai-discovery.md) |

All paths below are relative to this installed skill directory, not the target
repository. Read them with the host agent's file tools. Load details on demand,
not the entire playbook for every small task.

### Reference index

[Playbook overview](references/00-overview.md)

| Chapter | Read when |
| --- | --- |
| [1. Priority Order](references/01-priority-order.md) | Principles conflict or tradeoffs need ordering. |
| [2. Normative Language](references/02-normative-language.md) | Interpreting MUST, SHOULD, MAY, and clean-code heuristics. |
| [3. AI Coding Agent Operating Procedure](references/03-ai-coding-agent-operating-procedure.md) | Starting or completing any coding task. |
| [4. Start With the Contract, Not the Implementation](references/04-start-with-the-contract-not-the-implementation.md) | Defining requirements, invariants, outcomes, or assumptions. |
| [5. Naming](references/05-naming.md) | Naming identifiers, operations, responsibilities, and units. |
| [6. Function Design](references/06-function-design.md) | Designing functions, parameters, abstraction levels, and effects. |
| [7. Control Flow](references/07-control-flow.md) | Changing branches, nesting, predicates, or exhaustive decisions. |
| [8. Data, Objects, and Abstraction](references/08-data-objects-and-abstraction.md) | Modeling data, objects, representation, valid states, and units. |
| [9. State and Side Effects](references/09-state-and-side-effects.md) | Owning mutation, calculations, or state transitions. |
| [10. Error Handling](references/10-error-handling.md) | Designing errors, resource cleanup, causes, or partial success. |
| [11. External Boundaries and Adapters](references/11-external-boundaries-and-adapters.md) | Integrating vendors, infrastructure, adapters, or injected dependencies. |
| [12. Comments and Documentation](references/12-comments-and-documentation.md) | Writing or maintaining comments, API documentation, or legal notices. |
| [13. Formatting and Source Layout](references/13-formatting-and-source-layout.md) | Arranging source, scope, whitespace, or formatting. |
| [14. Testing](references/14-testing.md) | Choosing test levels, regression coverage, or test structure. |
| [15. Security Is Part of Correctness](references/15-security-is-part-of-correctness.md) | Handling trust boundaries, authorization, secrets, uploads, or hostile input. |
| [16. Concurrency, Transactions, and Distributed Effects](references/16-concurrency-transactions-and-distributed-effects.md) | Changing shared state, transactions, retries, messages, or remote effects. |
| [17. Performance and Resource Use](references/17-performance-and-resource-use.md) | Choosing algorithms, I/O patterns, streaming, caching, or performance budgets. |
| [18. Observability and Operability](references/18-observability-and-operability.md) | Adding logs, metrics, traces, correlation, or health checks. |
| [19. Module and Class Design](references/19-module-and-class-design.md) | Assigning module/class responsibilities or dependency direction. |
| [20. API Design](references/20-api-design.md) | Designing caller contracts, pagination, units, or API evolution. |
| [21. Dependency Management](references/21-dependency-management.md) | Adding, updating, locking, or removing dependencies. |
| [22. Refactoring](references/22-refactoring.md) | Changing internal structure while preserving behavior. |
| [23. Code Review](references/23-code-review.md) | Reviewing purpose, correctness, code health, and the actual change. |
| [24. Git and Change Hygiene](references/24-git-and-change-hygiene.md) | Preparing coherent commits and avoiding generated/local junk. |
| [25. AI-Specific Failure Modes](references/25-ai-specific-failure-modes.md) | Avoiding invented APIs, unseen assumptions, unsafe suppressions, or false proof. |
| [26. Safe Typing and Type-System Discipline](references/26-safe-typing-and-type-system-discipline.md) | Designing types, validation, absence, finite states, casts, or strictness. |
| [27. Scaling Codebases, Teams, and Runtime Systems](references/27-scaling-codebases-teams-and-runtime-systems.md) | Growing codebases, teams, workloads, data, or distributed deployments. |
| [28. Explicit Decision Rules for Coding Agents](references/28-explicit-decision-rules-for-coding-agents.md) | Applying concrete IF/THEN design and review triggers. |
| [29. End-to-End Implementation Workflow](references/29-end-to-end-implementation-workflow.md) | Executing the seven phases of a non-trivial change. |
| [30. Definition of Done Checklist](references/30-definition-of-done-checklist.md) | Checking all applicable completion criteria before returning work. |
| [31. Compact Agent Instruction Block](references/31-compact-agent-instruction-block.md) | Loading the compact baseline instructions at task start. |
| [32. Email Deliverability](references/32-email-deliverability.md) | Building, signing, sending, unsubscribing, suppressing, or diagnosing email, or changing sending-domain DNS. |
| [33. SEO and AI Discovery](references/33-seo-and-ai-discovery.md) | Serving public pages, status codes, rendering, metadata, structured data, sitemaps, robots/crawler/CDN rules, feeds, or search and AI-referral analytics. |

## Policy and enforcement

- **Skill = reasoning policy.** Instructions guide decisions; they do not enforce them.
- **Repository rules = project-specific constraints.** Local contracts, commands,
  architecture, and documented conventions define what this project requires.
- **CI/tooling = enforcement.** Use the repository's existing checks and required
  merge gates to make mechanically checkable requirements block bad merges.

Inspect configured checks relevant to the change and run their documented commands.
Type checks, lint, and tests should be required CI checks where the project uses
them; secret scanning can block detected credentials. Review requirements and
coverage/diff tooling can flag removed tests, weakened assertions, or coverage
regressions, but cannot prove that tests still protect the intended behavior.
Passing automation is not a substitute for contract review.

Do not disable checks, lower thresholds, or bypass merge gates to make a change
pass. Report missing enforcement or unobserved CI results explicitly. Reuse existing
tooling; add or change enforcement only when the task calls for it. Installing
this skill does not install hooks, configure CI, or enable branch protection.

## Completion report

State what changed, the checks actually run and their observed results, and any
remaining limitations or unverified assumptions. Never claim compilation, passing
tests, command success, or production safety without evidence. Keep the report
proportional to the task.
