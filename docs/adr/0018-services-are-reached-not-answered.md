# 0018. Services are reached, not answered

- **Status:** Accepted
- **Date:** 2026-08-26
- **Source:** GitHub issue #1 (rows 21–23); issues #8 and #9

## Context

Port forwarding has been in the data model since the first spec
(`nat.portForwards`) and was untraceable: a `Frame` had no protocol or port
to match against. Catalogue rows 21 and 22 need that match.

Row 23 is a different temptation. DHCP handing a client a resolver on a VLAN
it cannot reach is a real outage — the gateway still answers, so the owner
reports "the internet is broken" when only lookups fail. Modelling DNS
enough to say whether a *name* resolves would be a second engine (a stub
resolver, zone data, recursion) sitting beside the 802.1Q pipeline.

## Decision

A frame may carry `payload.kind: 'service'` with a `proto` (`udp` | `tcp`)
and a `dstPort`. That is enough to:

- match `nat.portForwards` by `proto` and `outsidePort`
- ask whether a packet to a given address and port *arrives*

The trace **stops at arrival**. Whether a name resolves, whether HTTP returns
200, whether TLS completes — none of that is modelled, and it will not be.

Nothing in the codebase resolves a name, holds zone data, or is called `dns`.
The DHCP scope field is `resolver`. Catalogue row 23 is a reachability row
that happens to use UDP 53.

`nat.portForwards.proto` is narrowed to `'udp' | 'tcp'` so a forward and a
frame are the same type, not two strings that might be spelled differently.

## Alternatives rejected

- **A stub resolver that answers a few names.** Would make row 23 read as a
  DNS bug rather than a VLAN/firewall bug, which is the wrong lesson, and it
  is a second engine of the kind ADR 0001 forbids.
- **Encoding port-forwards as untraceable NAT decoration.** That is the
  status quo. Rejected because a configurable-but-untraceable forward is a
  lie in the data model: the field exists, the packet cannot name it.
- **A generic L4 payload without narrowing proto.** Flexible, and it would
  allow "icmp" in a port-forward by accident. Rejected so a forward and a
  service frame are comparable without a parser.

## Consequences

- Rows 21–23 are representable in this slice's types and formatter. The
  engine work lives in #8 and #9.
- Application protocols stay out. If a future catalogue row needs "did the
  reply come back from this port", that is still a frame on the 802.1Q path,
  not an application model.
