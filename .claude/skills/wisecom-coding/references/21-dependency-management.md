# 21. Dependency Management

## 21.1 Add a dependency only when it buys more than it costs

Evaluate:

- maintenance activity;
- security history/process;
- transitive dependency weight;
- API stability;
- license;
- bundle/runtime cost;
- platform compatibility;
- whether the needed feature is trivial to implement safely yourself.

Do not hand-roll cryptography, parsers for complex security-sensitive formats, or protocol stacks merely to avoid dependencies.

## 21.2 Use lockfiles and reproducible installs

Commit the ecosystem lockfile when that ecosystem expects one. CI and deployment should resolve the same dependency graph as development.

## 21.3 Keep dependencies current deliberately

Avoid two extremes:

- never updating until a crisis;
- automatically merging every dependency update without tests.

Use automated update tooling plus tests/review. Patch security-critical issues promptly according to severity and exposure.

## 21.4 Remove unused dependencies

Unused packages increase:

- attack surface;
- install time;
- audit noise;
- license obligations;
- future upgrade work.

Delete them.
