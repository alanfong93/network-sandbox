# 0027. The UI entry is Vite-built vanilla TypeScript

- **Status:** Accepted
- **Date:** 2026-09-01
- **Source:** issue #58 (Stage 5, S5-2; UI shape decided by tribunal option C)

## Context

The first UI (issue #58) is a browser entry that imports the engine. The
engine is a dependency-free TypeScript library (ADR 0016) whose build emits
bundler-resolved specifiers — `from './model'`, no extension — because
`tsconfig.json` sets `moduleResolution: "bundler"`. A raw `<script
type="module">` in a browser cannot load that: browsers resolve relative
specifiers literally and require the `.js` extension. The same is true of
Node ESM. So "a browser entry that imports the engine" cannot exist today
without either a bundler or a rewrite of every import in `src/`.

The tribunal record for this issue (2026-09-01, option C) fixes the shape:
a separate UI package/entry that imports the engine, **vanilla first**, no
graph canvas, framework optional and package-local. It does not fix the
build tool.

## Decision

The UI lives in a `ui/` **entry** inside this repository and compiles with
**Vite**, a devDependency of the root package. `npm run ui:dev` serves it;
`npm run ui:build` emits a self-contained static bundle into `ui/dist/`
(currently ~19 kB gzip) that any static file server can host — the
no-server promise to users (ADR 0009) is untouched, because the artifact is
plain files, the same as the JSON file of record.

The UI code is vanilla TypeScript over the DOM: no framework, no reactive
library. The modules that carry behaviour (`presets.ts`, `state.ts`,
`trace.ts`, `jsonio.ts`, `render.ts`) are pure and unit-tested under the
root Vitest run; `main.ts` is the only DOM-glue module and stays thin. The
engine's `dependencies` stays `{}`, and the engine never imports the UI —
the dependency arrow points one way, UI to engine.

The UI renders engine sentences and never re-derives them: hop sentences
are the ones the walk produced with `format()`, and observations and STP
warnings go through `format()` in the UI. There is no second formatter.

## Alternatives rejected

- **Fix the engine's emit to raw-browser ESM** (write `.js` extensions on
  every relative import in `src/`). It would make `dist/` loadable without
  a bundler — and it is a mechanical rewrite of every engine file. That is
  its own concern, not a hidden rider on the first UI issue, and the repo
  would still need a compile step for the UI's own TypeScript.
- **No-build plain JavaScript UI.** Rejected for the same reason ADR 0016
  rejected plain JavaScript for the engine: the claims that matter (one
  control edits one mechanism; presets write functions) are type-level, and
  the UI is where those claims are easiest to violate.
- **A separate npm package with workspaces.** Honest declaration, at the
  cost of a second install, a workspace graph, and CI reordering, for no
  additional boundary: the boundary that matters is engine `dependencies`
  stays `{}` and the dependency arrow points one way, both of which the
  single-package entry already guarantees. Revisit if the UI grows its own
  release cycle.
- **A UI framework (React, Svelte, Vue).** Rejected by the tribunal for
  this issue: vanilla first, framework only if it earns its keep later.

## Consequences

- `npm test` now also discovers `ui/**/*.test.ts`; `npm run typecheck`
  checks `ui/tsconfig.json` (DOM lib) in addition to the engine.
- CI gains `npm run ui:build`, so a broken UI build fails the pipeline the
  same way a broken engine build does.
- Adding a *runtime* dependency to the engine remains an ADR-level decision
  (ADR 0016). Vite is build tooling for the UI entry and never ships in
  anything the engine publishes.
- `ui/dist/` is a build artifact and stays out of version control.
