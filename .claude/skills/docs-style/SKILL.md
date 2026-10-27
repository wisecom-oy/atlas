---
name: docs-style
description: Use when writing, editing, or reviewing anything under docs/ (VitePress site), the README, or package READMEs. Keeps Atlas docs consistent with the Wisecom brand, voice, and page structure.
---

# Atlas Docs Style

Atlas is the open-source Microsoft 365 backup engine behind **Wisecom Continuity**, Wisecom's managed SaaS. The docs are product documentation for developers and operators using the CLI and SDK. They are not design documents.

## Voice

- Calm, precise, confident. Short declarative sentences, as on wisecom.fi ("Backup you don't have to take on faith.").
- Write for a technical reader new to Atlas internals. Say what to do, then why it matters.
- No em dashes and no `--` as punctuation in prose. Split the sentence or use a comma.
- No throat-clearing, no restating the heading, no marketing superlatives in reference pages.
- Product names: **Atlas** (the engine, CLI, SDK), **Wisecom Continuity** (the SaaS), **Wisecom** (the company). Never "M365 Atlas".
- Use "Microsoft Entra ID", not "Azure AD", except when quoting a portal label or a file name.

## What belongs in the docs

Keep:
- Install, configure, run: working commands first.
- Every CLI flag and SDK method a user can call, in tables.
- Constraints that change user decisions: required Graph permissions, Object Lock must be enabled at bucket creation, retention cannot be shortened, passphrase loss means data loss, rate limits, supported workloads.
- Security model: what is encrypted, with what (AES-256-GCM, scrypt parameters), what an attacker with each credential can and cannot do. Concise, but never vague.

Cut or move to `docs/development/`:
- Internal class names, call graphs, file-by-file walkthroughs, algorithm narratives.
- Anything only a contributor changing the engine needs.

Rule of thumb: if removing a paragraph would not change what a user types or decides, remove it.

## Page structure

1. `# Title` and one or two sentences on what the page covers.
2. A working example (CLI or code) as early as possible.
3. Options or fields as a table.
4. Details, constraints, and caveats under `##` headings.
5. Use VitePress containers: `::: tip` for advice, `::: warning` for constraints that cause failures, `::: danger` for irreversible actions (data loss, retention lock). Do not stack more than two per section.
6. End with links to the next logical page when useful (`See also`).

Headings use sentence case ("Restore a mailbox", not "Restore A Mailbox"). Keep pages under roughly 400 lines; split by task if longer and add the new page to the sidebar in `docs/.vitepress/config.ts`.

## Code and examples

- Placeholders: `<tenant-id>`, `<bucket>`, `user@example.com`, `contoso.sharepoint.com`. Never real tenants, secrets, or internal hosts (see `.claude/CLAUDE.md`).
- Shell blocks use `bash`, SDK blocks use `ts`. Examples must match the current CLI and SDK source; check `packages/cli` and `packages/sdk` before documenting a flag.

## Visual theme

The theme is Wisecom monochrome, defined only in `docs/.vitepress/theme/custom.css`:
- Black (`#0a0a0a`) and white, grey scale for borders and muted text. No hue accents; brand color is white in dark mode and black in light mode.
- Square corners (radius 0 to 2px), 1px borders, flat surfaces, no gradients or glows.
- Uppercase, letter-spaced, small monospace labels for eyebrows.
- Do not add inline styles or colors in Markdown. Extend the CSS variables instead.

- Logos live in `docs/public/`: `wisecom-wordmark-{dark,light}.png` for the nav (dark ink for the light theme, light ink for the dark theme), `wisecom-mark-light.png` on the Continuity card, and square 128px `favicon-{dark,light}.png` (favicons must be square or browsers stretch them). Regenerate them from the official brand files, never redraw or recolor them.

## Home page

`docs/index.md` keeps a hero, a feature grid, and the Wisecom Continuity section linking to https://wisecom.fi/en/products/continuity and https://wisecom.fi/en/pricing. Keep the upsell factual: what the SaaS adds over self-hosting (managed scheduling, weekly verification, immutable EU storage, audit log and SIEM streaming, restore dashboard). Check claims against wisecom.fi before changing them.

## Before finishing
- `pnpm run docs:build` passes with no dead links.
- New pages are in the sidebar.
- Check the changed page in a browser at desktop and mobile width.
