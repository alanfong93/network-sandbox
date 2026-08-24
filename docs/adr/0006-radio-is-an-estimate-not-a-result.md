# 0006. Radio coverage ships last and does not share the tool's visual language

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `README.md`; `docs/SPEC.md` §6

## Context

Everything in stages 1–3 executes a published standard: 802.1Q switching, 802.1D
spanning tree, IP routing tables. The output can be checked against a document.

**Radio coverage cannot.** Whether an AP reaches the far end of an office depends on
walls, materials, antenna patterns and interference from nearby networks. No standard
answers it; a site survey does. Any coverage model here is an estimate built on
assumptions the user cannot see.

The danger is not that the estimate is wrong — it is that it would be rendered in the
same typeface, in the same panel, next to outcomes that are *derived*. Trust would
leak from the reliable half of the tool to the unreliable half, and the project's
central promise would quietly stop being true.

## Decision

Two parts, both binding:

1. **Radio is stage 4 — last.** Wired core, then APs as wired devices (SSID → VLAN
   mapping, management VLAN, clients behaving as ordinary hosts), then multi-WAN,
   then radio. Stage 2 reuses the stage 1 engine and adds no new one.
2. **Coverage output must be visually distinct from derived output.** It is presented
   as an estimate with its assumptions visible, and it must not look like a trace.

SSID-to-VLAN mapping is *configuration*, so it carries the same confidence as the
rest of the tool. Only coverage is downgraded.

## Alternatives rejected

- **Build radio early, since it is the visible, demo-friendly feature.** Rejected:
  shipping the least defensible part first sets the tool's perceived accuracy at its
  weakest point, and the wired engine — which everything else reuses — would end up
  built around it rather than before it.
- **Model coverage in the same visual language, with a disclaimer.** This is the
  default thing to do, and it is the specific trap. A confident-looking coverage
  heatmap is the most dangerous thing this app could render; a footnote does not undo
  a full-colour heatmap.
- **Never model coverage at all.** Cleanest, and seriously considered. Rejected
  because coverage is a real question people need help with — the answer is to mark
  the claim honestly, not to withhold it.

## Consequences

- Stage 4 needs a *design decision about presentation*, not just a propagation model.
  That design is a prerequisite for shipping it, not a polish step.
- Stages 1–3 must not depend on anything in stage 4.
- The honesty boundary is a user-visible feature and belongs in the UI, alongside the
  no-timers limit from ADR 0003.
