# 0005. A newly placed router has NAT on

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `docs/SPEC.md` §3

## Context

`Router.nat` is the decision that matters at every tier, and the two settings fail in
completely different ways:

- **NAT on** (home/SMB, router behind router) — downstream hides behind one address
  and the upstream needs no routes. Fails at inbound connections and port
  forwarding, and is miserable to debug three tiers deep.
- **NAT off** (a proper routed hierarchy) — real subnets, real routing. Fails at the
  **missing return route**: the downstream reaches up fine, the upstream has no route
  back down, so replies never come home. Invisible from the downstream side, which is
  exactly why a trace beats a ping.

A default has to be picked, and the default decides which failure most users meet.

## Decision

A newly placed router defaults to **`nat: true`**. This matches consumer gear, and it
matches what a user expects when they drop a second router behind their first.

## Alternatives rejected

- **Default NAT off.** Would surface the missing-return-route case — arguably the
  single most instructive failure in the catalogue — to everyone by default. Rejected
  because it contradicts the behaviour of the hardware people actually own; a sandbox
  whose default disagrees with the box on the desk teaches the wrong reflex and makes
  early traces confusing rather than illuminating.
- **No default — force the user to choose when placing a router.** Honest, but it
  puts a routing-architecture question in front of someone who has not yet built a
  topology, and stalls the first five minutes of the tool.

## Consequences

- **Accepted cost: the missing-return-route failure never appears unless a user turns
  NAT off.** The catalogue's best lesson sits behind a flag.
- Mitigation is *content, not a default change*: ship a starter scenario that arrives
  with NAT off and the return route missing. Fix the discoverability problem where it
  lives, rather than by making the default less realistic.
- Double NAT becomes the easy accident, since stacking two default routers produces
  it. The trace must call it out explicitly (catalogue row 12).
