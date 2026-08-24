# 0004. One router type, placed at any depth

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `README.md`; `docs/SPEC.md` §2, §3

## Context

Real topologies stack routers: an HQ router, a floor router beneath it, a department
router beneath that. The tempting modelling move is to make "sub-router" a device
kind of its own, because people talk about it that way, and because the downstream
failures (double NAT, overlapping subnets, missing return routes) feel like a
different class of problem.

## Decision

There is **one `Router` type**, placed anywhere in the topology. "Sub-router" is a
*position*, not a kind of box. Depth is expressed by the `uplink` field — absent
means edge, present means it sits behind something.

The real difference between tiers is not the device, it is the `nat` flag, and the
two worlds fail very differently (see ADR 0005).

## Alternatives rejected

- **A distinct `SubRouter` device kind.** It matches how users describe their
  network, and it would let downstream-only failures be modelled directly. Rejected
  because it duplicates every routing, DHCP, firewall and NAT behaviour into a
  second type that must then be kept in sync — and the duplication buys nothing,
  since the downstream failures come from *configuration at a position*, not from a
  different capability set.
- **A depth or tier field on the router** (`tier: 'hq' | 'floor' | 'dept'`).
  Rejected as the same mistake in cheaper clothing: it invites behaviour to branch
  on tier, which would put the author's beliefs back in the engine (ADR 0001). Depth
  is already derivable from the link graph.

## Consequences

- Router behaviour is written once. A fix to routing or DHCP relay applies at every
  tier automatically.
- Multi-tier failures in the catalogue (overlapping subnets, double NAT, broken
  relay chains, asymmetric paths, missing return route) fall out of ordinary routers
  wired in series — they need no special-case code.
- The UI must not label a device "sub-router". If depth needs showing, derive it
  from the topology at render time.
- An L3 switch is a managed switch plus `RouterIface`, reusing the same interface
  type — the taxonomy stays flat there too.
