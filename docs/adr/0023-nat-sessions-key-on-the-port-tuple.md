# 0023. NAT sessions key on the port tuple

- **Status:** Accepted
- **Date:** 2026-08-31
- **Source:** issue #51, the accepted cost of [ADR 0022](0022-masquerade-follows-the-wan-egress.md)

## Context

ADR 0022 shipped hairpin NAT with an accepted cost: sessions stayed
address-keyed (`device + insideIp + outsideIp + remoteIp`), and the return
lookup matched on `device + outsideIp + remoteIp`. Two consequences:

- Two simultaneous hairpin clients of one forwarded server alias to the first
  session - the second client's replies are delivered to the first.
- Any frame from the forwarded server to the router's LAN IP matches the
  session while it lives, so management and ICMP traffic to the router is
  diverted to a client. The same aliasing pre-exists for plain masquerade
  (two inside clients SNAT to one remote).

The discriminator exists in the payload: the service frame carries `proto`,
`dstPort`, and has always allowed `srcPort` - nothing populated the port
state, and no session field recorded it.

## Decision

1. **A session created from a service payload records the port tuple:**
   `proto`, `toPort` (the server-side port - the forward's `toPort` for a
   DNAT, the remote's service port for masquerade), `clientPort` (the
   client's ephemeral source port), and for port-forward DNAT `outsidePort`
   (the public port the client contacted).
2. **A return leg that carries port identity matches the session exactly**:
   `proto`, the reply's source port equals `toPort`, its destination port
   equals `clientPort`. There is no address-only fallback for ported frames -
   a service frame whose ports name no session is a new conversation with the
   router, not a hijack.
3. **A portless frame (ICMP-style) matches only sessions without port
   identity**, first-match-wins as before. Dropping such returns would break
   the masquerade ping round-trips the flow driver relies on, and the model
   has no reply port state to disambiguate them.
4. **An ambiguous portless pick is named, not implied** (ADR 0002): when
   first-match-wins chose among several address twins, the nat hop renders
   the candidate count. `matchSession` keeps its signature;
   `matchSessionDetail` exposes what it chose from.
5. **The reply's source port is restored to `outsidePort`** - the port
   analogue of the `origDstIp` restore: the client sees the reply from the
   address and port it contacted.
6. **The DNAT rewrite emits its own `nat` hop** (a pre-existing omission, in
   scope while in the file): `nat:translated` naming the rewritten
   destination, so a forward trace explains the destination change instead of
   implying it. `walk`'s double-nat observation counts outPort-bearing
   translations only - a DNAT hop and its hairpin SNAT on one device are one
   translation, not two NAT boxes.

Still `route-lookup`/`nat`/`port-forward`; no new pipeline step or outcome
(ADR 0001).

## Alternatives rejected

- **Drop ambiguous portless returns with a named reason.** More honest than
  delivering to the wrong client, but it breaks masquerade ping round-trips -
  a behaviour regression to fix a naming problem a hop sentence fixes with
  words.
- **Tuple without the `outsidePort` restore.** Two clients stop aliasing, but
  a mapped forward (8443 -> 443) still hands the client a reply from the
  server's internal source port, so the client's socket tuple mismatches.
- **Record the session at DNAT time, conntrack-style.** Real conntrack
  records the binding when the rule matches. The engine's external DNAT
  records no session today and its return leg needs none - the reply carries
  the client's real address, and recording one would change delivery for
  existing traces with no fidelity gain. SNAT time is where the engine
  actually rewrites, and that is where the key now lives.

## Consequences

- Two hairpin clients of one forwarded service each receive their own returns
  on one run context, and a server-to-router-LAN-IP frame is delivered to the
  router while hairpin sessions exist (issue #51's done-when).
- Plain masquerade service sessions gain the same precision when replies
  carry ports; ICMP returns stay address-keyed and first-match-wins, now
  named on the hop when the pick was ambiguous.
- Port-forward forward traces gain a nat hop naming the destination rewrite;
  a hairpin forward leg carries two nat hops (DNAT then SNAT) that read as
  one source translation.
- `recordSession`'s duplicate check extends to the tuple, so two connections
  from one client IP are separate sessions.
- ADR 0022's accepted cost is spent by this ADR, not edited away.
