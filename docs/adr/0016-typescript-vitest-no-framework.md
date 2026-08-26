# 0016. TypeScript + Vitest, no runtime framework

- **Status:** Accepted
- **Date:** 2026-08-26
- **Source:** GitHub issue #2 (Stage 1, steps S1–S3)

## Context

The wired-core engine has to run in the browser with no server (ADR 0009) and
stay small enough that a third party can check it against IEEE 802.1Q/802.1D.
That rules out anything that pulls a runtime into the bundle just to exist.
It also has to be typed tightly enough that a reason code cannot be a
hand-authored scenario name — the product of pipeline step × outcome is a type,
not a convention.

## Decision

The engine is a **dependency-free TypeScript library**. Strict mode, no UI
framework, no runtime packages. Tests run under **Vitest**. `package.json`
`dependencies` stays empty; TypeScript and Vitest are `devDependencies` only.

Source in `src/` must stay browser-safe: no Node APIs, no `fs`, no timers
disguised as `setTimeout`. Tests may use Node to inspect the tree.

## Alternatives rejected

- **Plain JavaScript.** Faster to start, and it would run anywhere. Rejected
  because the reason-code product (`step:outcome`) and the "no `nativeVlan`
  field" invariant are type-level claims; a linter comment would not stop
  someone adding `vlan-missing-from-trunk` as a string.
- **Shipping a UI framework with the engine** (React, Svelte, Vue). The
  product will have a UI, but the engine is the thing this project has
  promised to keep checkable against the standard. A framework in the engine
  bundle would make that check a framework check. The UI can wait.
- **Jest.** Familiar, and it would run these tests. Rejected because Vitest
  is ESM-native, shares the same transform the browser build will use, and
  the engine has no Jest-specific need.

## Consequences

- `npm test` and `npm run build` are the gate for every later Stage 1 issue.
- Adding a runtime dependency is now a decision that needs a new ADR, not a
  convenience in `package.json`.
- The UI, when it lands, is a separate package or entry that *imports* this
  engine. It does not live inside it.
