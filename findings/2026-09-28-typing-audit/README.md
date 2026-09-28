# Typing audit, 2026-09-28

Audit of loose typing in `packages/*/src` at commit `4d6ee39` (v5.2.2).

Method: counted every type escape hatch in `src` (explicit `any`, `as unknown as`,
`JSON.parse(...) as T`, `as Promise<T>`, `as Record<string, unknown>`, non-null assertions,
`@ts-` directives, `eslint-disable`), traced the persisted and external ones to their consumers,
and ran the type-aware `typescript-eslint` rules once against `src` after a build.

| #         | Finding                                                                                               | Priority | Labels       |
| --------- | ----------------------------------------------------------------------------------------------------- | -------- | ------------ |
| 01 (#441) | [Outlook `Manifest.created_at` is a string at runtime](01-outlook-manifest-created-at-is-a-string.md) | medium   | `bug`        |
| 02 (#442) | [Type-aware lint rules are off](02-type-aware-lint-rules-off.md)                                      | low      | `code smell` |

Finding 01 was reproduced with a round trip through `S3ManifestRepository`.

Counts in `src`, excluding `packages/types/src/testing`:

| Pattern                         | Count | Verdict                                                                       |
| ------------------------------- | ----- | ----------------------------------------------------------------------------- |
| explicit `any`                  | 0     | Clean                                                                         |
| `@ts-ignore` / `eslint-disable` | 0     | Clean                                                                         |
| `as unknown as`                 | 3     | Library boundaries (readline internals, fetch body, S3 body stream). Kept     |
| `JSON.parse(...) as T`          | 17    | Unvalidated persisted state. The `Date` field is the one proven mismatch (01) |
| `as Promise<T>` on Graph calls  | 38    | Graph client returns `any`. Covered by 02                                     |
| `as Record<string, unknown>`    | 24    | Reading fields off thrown errors and Graph JSON. Reasonable                   |
| non-null assertions             | 62    | Guarded index access, or filter then assert. No reachable failure found       |

Checked and dropped:

- `conflict_behavior` widens from a union to `string` at the drive connector ports, but the CLI
  validates it against fixed choices and the SDK option is the union, so no invalid value reaches
  the port.
- Graph adapters read `response.id` off `any`. Graph always returns `id` on a `200`, so there is
  no reachable failure; it is part of 02 as a hygiene item.
- The version index and replication status store dates as strings and type them as strings,
  so they are consistent.
