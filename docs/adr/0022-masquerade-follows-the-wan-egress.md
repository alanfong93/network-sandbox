# 0022. Masquerade follows the WAN egress, not the default pick

- **Status:** Accepted
- **Date:** 2026-08-30
- **Source:** issue #46, review cycles on PR #49

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

The first review cycle of this PR also showed the first-cut hairpin rule
(target inside the *ingress* VLAN's subnet) was too narrow: a client on one
internal VLAN reaching a forwarded server on another internal VLAN is the same
hairpin flow, and the hairpin SNAT source had to be the *resolved egress*
iface, not the ingress one, or a private source could land on a WAN.

## Decision

1. **The masquerade candidate set is every iface a default route names** —
   the selector-aware pick for the frame's VLAN, the plain default, or any
   other WAN reached through a longer-prefix static or selector route. The
   SNAT source is the egress iface's own address. Reachability applies as
   everywhere else (ADR 0020): a default whose via sits behind a down link
   names nothing.
2. **A DNAT arrived at from an internal iface — one no default route names —
   is hairpin.** The source is rewritten to the resolved egress iface's IP
   (for the same-VLAN case that is the ingress iface itself) and the return
   session records the original public destination as `origDstIp`, so the
   reply re-enters the router and is delivered with its source restored to the
   address the client contacted. A DNAT from an external client (ingress is a
   default-named WAN) keeps `skipSnat` — its public source is what the server
   must reply to.
3. **The port-forward candidate set matches the masquerade set.** A service
   frame to any default-named WAN IP attempts `matchForward`, so a WAN that
   masquerades outbound also accepts forwards on its public IP.

Still `route-lookup`/`nat`; no new pipeline step (ADR 0001). `matchSession`
lookup keys stay device + outsideIp + remoteIp; `origDstIp` is additive data
on the session, not a key change.

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
- **Hairpin by ingress-subnet membership of the DNAT target** (this PR's first
  cut). It missed cross-VLAN hairpin entirely, and it pinned the SNAT source
  to the ingress iface even when the resolved egress differed. Internal
  ingress is the invariant real hairpin turns on.

## Consequences

- Frames egressing a non-default WAN are now translated; dual-WAN traces may
  gain a `nat` hop they previously lacked.
- A hairpin flow round-trips on one run context with the client-visible source
  restored; the reply no longer leaks the server's direct path.
- With three or more default-named WANs, forwards on every WAN IP are now
  reachable; previously only the two-tier `wanIface` picks answered.
- **Accepted cost: sessions stay address-keyed.** Two simultaneous hairpin
  clients of one forwarded server alias to the first session, and any frame
  from the forwarded server to the router's LAN IP matches the session while
  it lives. The same aliasing already exists for plain masquerade (two inside
  clients to one remote). Disambiguating per connection needs ports in the
  session table — a SPEC-level change tracked in the follow-up issue, out of
  this issue's boundary by design.
- The port-forward DNAT itself still emits no hop of its own (pre-existing);
  the hairpin SNAT hop is the only `nat` hop on the forward leg.
