# 0022. Masquerade follows the WAN egress, not the default pick

- **Status:** Accepted
- **Date:** 2026-08-30
- **Source:** issue #46

## Context

Masquerade answered one question: *is the egress iface the default-route pick?*
Two frames answered no and left untranslated, both pre-existing before #38 and
adjudicated out of its scope across two review cycles:

- **A frame egressing a non-default WAN.** A longer-prefix static route, a
  selector route, or a connected subnet on the second WAN names an egress that
  is not the pick. The frame left with its private source address — a real
  masquerade rule is per-egress-iface and would have translated it.
- **A hairpin frame.** A port-forward translation set `skipSnat`
  unconditionally, so a LAN client reaching a forwarded service through the
  WAN public IP was DNAT'd but never SNAT'd. The server saw the client's LAN
  address and replied direct; the router dropped out of the path. Real hairpin
  NAT rewrites the source so the return re-enters the router.

## Decision

1. **The masquerade candidate set is every iface a default route names** —
   the selector-aware pick for the frame's VLAN, the plain default, or any
   other WAN reached through a longer-prefix static or selector route. The
   SNAT source is the egress iface's own address. Reachability applies as
   everywhere else (ADR 0020): a default whose via sits behind a down link
   names nothing.
2. **A DNAT whose target is in the ingress VLAN's connected subnet is
   hairpin.** The source is rewritten to the ingress iface IP and the return
   session is recorded in the existing shape (`matchSession` keys device +
   outsideIp + remoteIp, with the iface IP as `outsideIp`), so the server's
   reply re-enters the router and is delivered to the client's inside address.
   A DNAT from an external client to a LAN server keeps `skipSnat` — its
   public source is what the server must reply to.

Still `route-lookup`/`nat`; no new pipeline step (ADR 0001). Port-forward
matching against WAN IPs is unchanged.

## Alternatives rejected

- **Document default-pick-only as the intended boundary.** It would enshrine a
  known infidelity as a decision. ADR 0005's principle — NAT matches the box
  on the desk — cuts the other way: consumer gear masquerades every WAN egress
  and hairpins. A sandbox that documents a wrong NAT model as deliberate
  teaches the wrong reflex.
- **An explicit `wan: true` marker on `RouterIface`.** Redundant with the
  routing table: a default route already names its WANs. A second source of
  truth for the same fact would drift from the routes it mirrors, and it adds
  a config field the engine can derive.

## Consequences

- Frames egressing a non-default WAN are now translated; dual-WAN traces may
  gain a `nat` hop they previously lacked.
- A hairpin flow round-trips on one run context: request DNAT'd and SNAT'd,
  reply matched by session and delivered to the client.
- Session shape unchanged; hairpin sessions store the ingress iface IP as
  `outsideIp`.
