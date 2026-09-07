# 0029. Canvas is a UI view and editor (layout sidecar, hop replay)

- **Status:** Accepted
- **Date:** 2026-09-07
- **Source:** issue #103 (canvas UI plan, grill 2026-09-07);
  [ADR 0026](0026-sandbox-json-encodes-sets-omits-maps.md),
  [ADR 0027](0027-the-ui-entry-is-vite-built-vanilla-typescript.md),
  [ADR 0002](0002-trace-not-verdict.md),
  [ADR 0003](0003-converged-state-no-timers.md)

## Context

Issue #58 shipped a forms UI: palette, inspector, send, hop sentences.
Architecture and README still said there is no canvas. ADR 0026 rejected
putting canvas `x,y` on Topology because the graph is the file and layout
is UI. PRODUCT jobs 1–3 already cover build / configure / send-and-see-hops.
Without a written decision, a canvas PR is a design-breach against #58's
no-canvas Watch and against ADR 0026.

This ADR does not ship a canvas. It is the contract later jsonio / SVG /
authoring / replay issues test against. It overrides only the standing
"Do not add a canvas" Watch for this phase. It does not reverse the forms
editor, and it does not supersede issue #58 as a whole.

## Decision

A later vanilla-SVG canvas is both the topology **builder** and the
**hop-replay** surface. The shipped forms UI stays.

The sandbox envelope at version 1 is `{format, version, topology, layout?}`.
`layout` is keyed by device id to `{x,y}`. It is never a field on
`Topology` or `Chassis`. Missing `layout` is valid — the later UI
auto-places. Engine `fromJson` already ignores extra keys; `SANDBOX_VERSION`
stays 1. Do not change `src/json.ts` to learn layout.

Hop replay consumes the completed `Hop[]` a send already produced. It is
not a clock (ADR 0003) and not a pass/fail overlay (ADR 0002). Flood
multiplying-tokens is a later issue.

## Alternatives rejected

- **`x,y` on Topology / Chassis.** Rejected under ADR 0026: coordinates
  would make a screenshot a network. Layout is an envelope sibling, not
  graph data.
- **localStorage-only layout.** Rejected: the file is the format of record
  (SPEC §8 Q2). A layout that exists only in the tab cannot round-trip
  with the topology the user keeps.
- **Timed simulation.** Rejected under ADR 0003: replay is not a clock
  and not an event queue. It plays hops that already exist.
- **Pass/fail overlay on the canvas.** Rejected under ADR 0002: a green
  tick on a box is a verdict. The canvas shows hops, not a conclusion.
- **Implementing the canvas in this issue.** Rejected: the contract lands
  first (`practice:spec-first`). A canvas commit here would ship a view
  with no jsonio / SVG issues behind it.

## Consequences

- Later canvas issues may add a vanilla-SVG view without reversing #58's
  forms UI or putting coordinates on Topology.
- `ui/jsonio.ts` will persist `layout` as an envelope sibling; the engine
  continues to round-trip `topology` only.
- Architecture, system flow, README and CONTEXT must not unconditionally
  forbid a canvas. Claiming the canvas has shipped remains false until a
  later issue lands it.
- Flood replay as concurrent tokens is out of scope here.
