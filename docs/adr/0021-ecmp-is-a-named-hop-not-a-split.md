# 0021. ECMP is a named hop, not a split

- **Status:** Accepted
- **Date:** 2026-08-30
- **Source:** GitHub issue #40

## Context

SPEC §6 stage 3 lists "load balancing" after policy routing and failover. A
router with two equal-cost default routes (ECMP) is the natural place a user
expects a 50/50 split — send half the traffic out WAN1, half out WAN2.

There is no clock ([ADR 0003](0003-converged-state-no-timers.md)). A 50/50
split is a statement about how frames distribute *over time*: round-robin
state, or a flow hash that spreads. Either is a result computed from
something the engine does not have — a clock, or per-flow identity with a
vendor-chosen hash function. Stating a split ratio would be invented
seconds wearing a route table's clothes: the exact failure mode ADR 0003
exists to prevent. Catalogue row 26 is the honesty lesson, the same shape
as row 19 (per-VLAN load balancing that single-instance STP cannot do).

## Decision

When the longest-prefix match returns multiple equal-prefix matches in the
tier that decided the frame, the engine picks **one** — the first match in
`routes[]` order among those whose via is reachable — and names that via on
the `route-lookup` hop facts. The pick is stable across runs; there is no
spreading mechanism and no `load-balance` pipeline step (ADR 0001).

The catalogue carries row 26 so the tool says plainly what happened: equal-
cost routes do not split here, the named via carries every frame, and real
gear may hash flows across them.

## Alternatives rejected

- **A 50/50 split claim.** It would be a statistic about frames this engine
  never counted, one frame at a time — invented seconds by another name.
- **A per-flow hash, modelling what real gear does.** Real ECMP hashes on
  flow tuples, but the hash is vendor-specific and the sandbox sees one
  frame per trace. Any spread we reported would be invented. Also rejected
  a `load-balance` pipeline step: the pick is a property of route lookup,
  not a new stage of the pipeline (ADR 0001).
- **Round-robin across the tie.** Requires state across frames — a counter
  that persists between sends. State that accumulates across frames is a
  clock by another name (ADR 0003), and a trace would stop being
  reproducible.

## Consequences

- Two equal-cost defaults produce **one** named next-hop, repeatable across
  runs — catalogue row 26 is green structurally and verbatim.
- No 50/50 claim appears in tests or docs; the sentence names the picked
  via and points at real gear for the spread.
- The selector-miss lesson (row 24) keeps precedence when both apply: a
  frame that fell through to a destination-only default names why it fell
  through, not the tie.
