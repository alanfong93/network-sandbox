# 0030. The table answers after arrival

- **Status:** Accepted
- **Date:** 2026-09-07
- **Source:** issue #126; [ADR 0018](0018-services-are-reached-not-answered.md)
  (partially superseded); [ADR 0001](0001-execute-the-8021q-pipeline.md);
  [ADR 0002](0002-trace-not-verdict.md);
  [ADR 0013](0013-devices-are-a-chassis-plus-functions.md)

## Context

Typing `192.0.2.1` does not match how people test a home net. `ping google.com`
failing while `ping 8.8.8.8` works is the actual outage. A local resolver on
the LAN (Pi-hole, the router, a Windows box) is how a lot of those nets are
built; a public resolver beyond the WAN is the other placement of the same
thing.

ADR 0018 refused a stub resolver sitting beside the 802.1Q pipeline: names,
zone data, and anything called `dns` were out, because catalogue row 23 is a
reachability row that happens to use UDP 53. That still holds for HTTP 200
and TLS. It does not hold for the name itself once the query *arrives*.

The temptation is to alias in the UI: type `google.com`, skip the walk, ICMP
the mapped IP. Then a down resolver is invisible.

## Decision

A name is still a frame on the 802.1Q path. The table **answers only after
delivery**. HTTP 200 / TLS stay out (ADR 0018 remainder).

1. **Function kind is `resolver`.** Records are `{name, ip}[]` — a table, not
   a zone file, not recursion, not SOA, not an NXDOMAIN engine. The UI label
   is **DNS server**. Nothing in `src/` filenames or identifiers is `dns`
   (`invariants.test.ts` still forbids that word).
2. **Placement is topology.** The same function on a LAN box or on the
   internet side. A router may carry it (home-gateway resolver). There is no
   second kind for "public" vs "local".
3. **The advertised resolver is an IP.** `Chassis.resolver` (host config) and
   DHCP `DhcpScope.resolver` are addresses, not engines. Send-by-name reads
   the sending chassis' `resolver`. If that IP is on the LAN, UDP/53 never
   leaves the house. If it is beyond the WAN, the walk goes out.
4. **The query payload is still `service`.** `proto: 'udp'`, `dstPort: 53`,
   plus `name` so `format()` can name what was asked. No new payload kind, no
   new pipeline step, no DNS reply frame.
5. **Send-by-name is two walks in one run.** UDP/53 to the advertised
   resolver; if that frame is **delivered**, look up the table on the delivery
   chassis and take the IP; then ICMP to that IP as today. If UDP/53 never
   arrives, stop. Ping-by-IP still works and does not consult the table.
6. **Internet is a host that answers ICMP** for its address once the frame
   arrives (the `NET` at `192.0.2.1` in the reference scenario). It is a
   palette box, not a second engine.

## Alternatives rejected

- **Alias the name in the UI and skip UDP/53.** Rejected: a down resolver
  would not appear in the trace, which is the outage this issue exists to
  show.
- **A stub resolver / zone / recursion / NXDOMAIN engine.** Rejected under
  ADR 0001 and the remainder of ADR 0018: that is a second engine. The table
  is consulted after arrival; a missing row is not a protocol.
- **Two function kinds (LAN vs public).** Rejected under ADR 0013: placement
  is topology. One kind, different links.
- **Calling the function or files `dns`.** Rejected: the invariant and
  CONTEXT already forbade the word so row 23 would not be misread as a DNS
  bug. The UI may say "DNS server"; `src/` may not.
- **A new pipeline step for the lookup.** Rejected under ADR 0001: the lookup
  is send/flow orchestration after `delivery`, not a step of 802.1Q.
- **Answering HTTP or TLS.** Rejected: ADR 0018 remainder. Arrival is
  modelled; application replies are not.

## Consequences

- ADR 0018 is superseded **in part**: names come from a table if the query
  arrives. Reachability of UDP 53, and the ban on HTTP/TLS, stand.
- `src/resolver.ts` holds table lookup. `runFlow` orchestrates the name
  walk, then the ICMP walk, against one run context.
- Palette: **DNS server** (resolver function) and **Internet** (host ICMP).
  Record editor and a destination field that accepts a name live in the UI.
