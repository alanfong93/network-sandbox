# 0031. Router LAN jacks are one bridge, not per-jack subnets

- **Status:** Accepted
- **Date:** 2026-09-08
- **Source:** issue #124; [ADR 0013](0013-devices-are-a-chassis-plus-functions.md);
  [ADR 0004](0004-one-router-type-at-any-depth.md);
  [ADR 0008](0008-pvid-is-ingress-native-vlan-is-egress.md)

## Context

Real home and SMB routers are not 1 LAN + 1 WAN. The shipped preset hid
that: a user placing "the router they actually have" — four yellow LAN
jacks, maybe two WAN jacks — could not draw it.

The question is what an extra LAN jack **is**. Alan's plain meaning,
confirmed in the issue: extra LAN is more jacks on the **same** house
network (the four yellow ports), not extra routed networks. Extra WAN is
another internet jack — the engine already has the second-WAN path
(`wan.fixture`, dual defaults, masquerade that follows the egress ADR
0022).

The tempting implementation is the obvious one: `lan2` becomes another
routed iface with its own subnet, because routing ifaces are what a router
has. That silently turns one house network into N subnets the user never
asked for — a host on `lan` and a host on `lan2` would then need a route
hop between jacks of the same physical box, exactly the topology the user
does not have.

## Decision

**A router's LAN side is a bridge plus one SVI; extra LAN jacks are bridge
members of the one LAN; extra WANs are routed uplinks.**

1. The router preset carries a LAN-side `bridging` function whose members
   are the physical `lan`…`lanN` ports plus one rt-owned SVI port
   (`lan-svi`), with the single LAN routing iface on that SVI
   (`RouterIface.id === 'lan-svi'`, the #71 composition). The engine is
   unchanged — `sviDecision`, the SVI egress re-entry, and NAT already
   implement everything.
2. `lan2`…`lanN` never get routing ifaces. A grown jack joins the PVID the
   existing LAN members carry, so new jacks land in the same broadcast
   domain by construction.
3. Extra WANs (`wan2`, …) are routed ports on the engine's second-WAN
   pattern: an untagged iface and its own default route, both removed again
   on shrink. Counts: LAN 1–8, WAN 1–2 — dual-WAN is the modelled engine
   scenario (the reference fixture carries exactly two WANs), and 8 covers
   the real hardware range.
4. An SVI member port is internal wiring, not a jack: it renders no canvas
   handle and no Start-link button. Cabling it is a false affordance.
5. Cabled and pending ports are refused on shrink with a notice, never
   silently unlinked — the same rule as the switch SKU resize (#125).

## Alternatives rejected

- **A routing iface per LAN jack.** Rejected: it makes `lan2` a second
  subnet, against the confirmed plain meaning; the trace would invent a
  route hop inside one box, and the user's real LAN is one broadcast
  domain.
- **A second router kind ("multi-LAN router").** Rejected under ADR 0004
  and ADR 0013: there is one router shape; composition (bridge + SVI +
  routed WANs on the same chassis) already expresses it.
- **Turning the modem into the multi-jack box.** Rejected in the issue:
  the modem stays the ISP handoff.
- **SVI ports as cabling jacks.** Rejected: an SVI never carries a link;
  offering it invites cabling a port whose frames the walk would only ever
  reach through internal dispatch.
- **Free-form counts.** Rejected: unbounded jacks invent addressing the
  engine has no story for (a third WAN has no documentation subnet in
  use); LAN 1–8 / WAN 1–2 matches the modelled scenarios and the hardware.

## Consequences

- Two hosts on two LAN jacks of one router ARP each other through the
  bridge — no route hop, one network (the #124 done-when).
- Host-to-WAN traffic punts through the SVI into `routeFrame` and
  masquerades out the default-named WAN; the reply returns through the NAT
  session — all pre-existing machinery, now reachable from the shipped
  preset.
- A saved topology from before this change keeps its old shape on import
  (a routed `lan` port, no bridge): it is not router-shaped, shows no count
  controls, and behaves exactly as it did.
- Pinging the router's own SVI address delivers the request (the #71 ARP
  and punt paths) but the reply cannot originate from a router chassis —
  `send()` is host-shaped. Tracked as a separate engine issue, not
  silently accepted here.
