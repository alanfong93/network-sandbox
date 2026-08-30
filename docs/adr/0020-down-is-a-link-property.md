# 0020. Down is a link property, not a device role

- **Status:** Accepted
- **Date:** 2026-08-30
- **Source:** issue #39, SPEC.md §6 stage 3

## Context

Stage 3 models failover as **state comparison**, not a timed transition (ADR 0003):
"all lines up" versus "WAN1 down" are two computed runs of one topology. `Link`
had no way to say a link is down, so a WAN outage could not be expressed at all —
there was no state to compare.

## Decision

`Link.up?: boolean`, omitted is up. Down is a property of the **link** — the
path between two ports — and every consumer of links treats it the same way:

- **Walk:** `peerOf` does not return a peer across a down link, so no frame is
  enqueued across one. This is general: a down inter-switch copper link is down
  exactly like a down WAN.
- **STP:** the converged state is computed from up links only. A down link is
  not a segment; its ports compute as `disabled`, which is what a link-down
  port is in 802.1D terms.
- **Route reachability:** a connected iface on a down link, and any route whose
  via resolves to a down-link iface, are not candidates — including a selector
  route targeting the down WAN. A port carrying several links is down only
  when all of them are: the walk crosses the first up link, and the two must
  agree. The drop is still `route-lookup`; no new pipeline step (ADR 0001).
- **NAT:** masquerade picks the default-route iface with the same
  reachability rule, so the translation follows the failover egress.

## Alternatives rejected

- **A WAN-only flag** (`WanLink.down`, or `device.role === 'wan'` plus a state
  field). It makes the engine branch on a device kind — this project has
  promised there are no device kinds, only chassis plus functions
  ([ADR 0013](0013-devices-are-a-chassis-plus-functions.md)). It also cannot
  express the same physical fact on a non-WAN link, so failover would be a
  special case instead of two runs of one topology.
- **A timed transition** (link goes down, failover fires after N seconds). A
  clock, and precisely where a browser model would be inventing seconds —
  rejected already by ADR 0003.

## Consequences

- Failover is expressed by flipping `up: false` on one link and re-running.
  "Will failover work" is answered structurally; "how fast" remains out of
  scope (ADR 0003).
- WAN1 down with no second default drops at `route-lookup`; catalogue
  [row 25](../SPEC.md) names it. The working case — WAN1 down with a WAN2
  default takes WAN2 — needs no new mechanism: the WAN2 default is ordinary
  route data, and the exclusion of the down via is what makes it win.
