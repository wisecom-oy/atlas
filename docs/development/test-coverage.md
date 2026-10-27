---
description: 'Measure Atlas test coverage across every package in one run with pnpm run test:coverage, and learn how to read the coverage results.'
---

# Test Coverage

Atlas measures test coverage across every package in one run. This page covers the command and how to read the results.

```bash
pnpm run build
pnpm run test:coverage
```

```
Merged coverage per package (every package test run counted)

Package     Lines   Branches  Functions  Statements
----------  ------  --------  ---------  ----------
core        92.6%   82.5%     92.6%      91.7%
drive       93.3%   88.1%     93.9%      92.6%
...
```

`test:coverage` runs every package's Vitest config as a project of one root run (`vitest.config.ts` at the repository root), measures every file under `packages/*/src`, and prints one row per package. The HTML report is in `coverage/index.html` and the per-file JSON in `coverage/coverage-summary.json`. CI runs the same command and uploads `coverage/` as the `coverage-report` artifact.

## Which number to read

Read the merged row above. Shared code is mostly exercised through other packages: `drive` through `onedrive` and `sharepoint`, `core` and `types` through every package. A package's own run (`pnpm --filter @wisecom/atlas-drive exec vitest run --coverage`) counts only that package's tests. That run reported `drive` at 26% and `types` at 16%, both above 90% in the merged run, and listed files at 0% that other packages test thoroughly. Those numbers point work at the wrong files.

Use a per-package run only to see what one package's tests reach on their own, for example when deciding whether a helper deserves tests next to it.

## Reading a gap

Low numbers are a lead, not a verdict. Before writing tests for a file, check the per-file entry in the HTML report and the lines it marks uncovered:

- An adapter that talks to Graph or S3 is exercised only by its own tests, because services mock it. A gap there means the code that runs against the real service is untested. Issue #444 was this case for the drive restore adapters and `fetch_delta`.
- A file at 0% that nothing in `src` imports is dead code, not a missing test. Remove it with its barrel export rather than testing it.
- `index.ts` barrels and `packages/types/src/testing/` are excluded from the measurement.
