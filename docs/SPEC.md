# v1 Spec

Design document. **Nothing is implemented yet.**

This file describes *what* v1 is, and it gets archived when the phase closes. The
*why* behind the load-bearing decisions lives in [`adr/`](adr/) and outlives it —
0001 pipeline-not-rulebook, 0002 trace-not-verdict, 0003 no-timers, 0004 one router
type, 0005 NAT on by default, 0006 radio is an estimate, 0007 unmanaged-switch names a
capability, 0008 PVID is ingress and native VLAN is egress, 0009 browser-only not a real
dataplane, 0010 ARP is modelled without a cache, 0011 single-instance STP owes a warning.
Reversing any of those means
appending a new ADR that supersedes the old one, not editing this file quietly.

## 1. Principle

Execute the **802.1Q ingress → forward → egress pipeline**, and let outcomes fall out of it. Do not write a rulebook of hand-authored error conditions — the pipeline is finite, published and vendor-neutral, so running it produces the standard's answer rather than the author's.

Ingress: acceptable frame types → assign PVID if untagged → ingress filtering (is the port a member of this VLAN?).
Forward: learn source MAC into the per-VLAN FDB → look up destination → forward to one port, or flood to VLAN member ports.
Egress: untagged member → strip tag; tagged member → send tagged; not a member → drop.

Every drop is simultaneously a teaching moment and a bug report. The UI's job is to name which step the frame died at.

## 2. Data model

```ts
type VlanId = number;            // 1..4094
type MacAddr = string;           // "aa:bb:cc:dd:ee:01"

interface Port {
  id: string;
  mode: 'access' | 'trunk';
  // INGRESS ONLY: the VLAN an accepted untagged frame enters. This is NOT the
  // native VLAN - native is an egress concept and lives in untaggedVlans below.
  // The two coincide by default but are independent. See ADR 0008.
  pvid: VlanId;
  taggedVlans: Set<VlanId>;      // EGRESS: members sent tagged (trunk only)
  untaggedVlans: Set<VlanId>;    // EGRESS: members sent untagged. A trunk's "native VLAN"
                                 // is this set's single entry - derived, never stored.
  acceptableFrameTypes: 'all' | 'tagged-only' | 'untagged-only';
  ingressFiltering: boolean;
  stpState: 'forwarding' | 'blocking' | 'disabled';
  link?: { toDevice: string; toPort: string };
}

interface ManagedSwitch {
  kind: 'managed-switch';
  id: string;
  bridgePriority: number;        // 802.1D: lower wins the root election
  baseMac: MacAddr;              // bridge ID tiebreaker
  stpEnabled: boolean;
  ports: Port[];
  fdb: Map<string, string>;      // "vlan:mac" -> port id
}

interface UnmanagedSwitch {
  kind: 'unmanaged-switch';
  id: string;
  ports: { id: string; link?: Link }[];   // no VLAN config, no STP, no priority
  fdb: Map<MacAddr, string>;              // one flat table, VLAN-blind
}

interface RouterIface {
  id: string;
  vlan: VlanId;                  // subinterface / SVI
  ip: string; prefix: number;
  dhcpServer?: { poolStart: string; poolEnd: string; gateway: string; dns: string };
  dhcpRelay?: string;            // helper address
}

// ONE router type at any depth. "Sub-router" is a position, not a device kind.
interface Router {
  kind: 'router';
  id: string;
  ports: Port[];
  ifaces: RouterIface[];
  uplink?: { port: string; mode: 'dhcp-client' | 'static'; ip?: string };  // absent = edge
  nat: boolean;                  // the real decision at each tier
  routes: { dest: string; prefix: number; via: string }[];
  firewall: { from: VlanId; to: VlanId; action: 'allow' | 'deny' }[];
}

interface Host {
  kind: 'host';
  id: string;
  mac: MacAddr;
  addressing: 'dhcp' | 'static';
  ip?: string; prefix?: number; gateway?: string;
  port: { link?: Link };
}

interface Frame {
  srcMac: MacAddr; dstMac: MacAddr;
  vlan: VlanId | null;                    // null = untagged on the wire
  payload: { kind: 'arp' | 'icmp' | 'dhcp'; srcIp?: string; dstIp?: string; dhcpType?: string };
  hops: Hop[];                            // appended at every device - this IS the explanation
}

interface Hop {
  device: string; inPort: string; outPort?: string;
  vlan: VlanId | null;
  action: 'forwarded' | 'flooded' | 'dropped' | 'delivered';
  reason: string;
}
```

## 3. Device notes

**Unmanaged switch.** Zero configuration. Forwards by MAC only; tagged frames pass straight through with the tag intact. One flat FDB. Sends and understands no BPDUs, so a loop through unmanaged switches is invisible to spanning tree. Consequences worth reproducing: trunk → unmanaged switch → trunk usually works (which is why people wrongly believe it "supports VLANs"), and every port on it shares one broadcast domain.

The name states a *capability* — no configurable per-port VLAN membership — and deliberately claims nothing more. "Unmanaged" is a management-plane word, and real unmanaged hardware varies in the data plane: pass-the-tag-intact is the common behaviour, not a guarantee, and some cheap silicon strips or drops tagged frames. The sandbox models the common behaviour; the UI must not let that read as a promise about the box on the user's desk. Same honesty boundary as ADR 0006, one tier down.

**Managed switch.** Full port config per §2.

**L3 switch.** Managed switch plus router interfaces — reuses `RouterIface`.

**Router at any depth.** The NAT flag is the decision that matters at each tier:
- **NAT on** (home/SMB, router behind router): downstream hides behind one address, upstream needs no routes. Fails at inbound connections and port forwarding, and is hard to debug three tiers deep.
- **NAT off** (proper routed hierarchy): real subnets and real routing. Fails at the **missing return route** — the downstream can reach up, the upstream has no route back down, so replies never come home. This is invisible from the downstream side, which is exactly why a trace beats a ping.

Default: **NAT on** for a newly placed router. This matches consumer gear and user expectation. Consequence to design around: the missing-return-route case then never appears unless a user turns NAT off, so surface it through a starter scenario rather than by changing the default.

**Access point.** Wired device with a trunk uplink; SSIDs map to VLANs; management VLAN. Clients join an SSID and then behave as ordinary hosts. Radio is stage 4 and carries a weaker claim — see §6.

## 4. Failure catalogue

The product is really this table. Each row is a reproducible mistake with a specific diagnosis.

| # | Device | Mistake | Trace should say |
|---|---|---|---|
| 1 | Managed switch | VLAN missing from the trunk's allowed list | *"Dropped at SW2 port 3 (egress): port is not a member of VLAN 20"* |
| 2 | Managed switch | Trunk's egress-untagged VLAN ≠ far end's ingress PVID | *"Untagged frame entered VLAN 10 at SW1, arrived as VLAN 20 at SW2 — VLAN leak"* |
| 3 | Managed switch | Access port on the wrong PVID | *"Host got 192.168.20.51 — expected VLAN 10"* |
| 4 | Managed switch | Ingress filtering off, tagged frame on an access port | *"Admitted only because ingress filtering is disabled"* |
| 5 | Unmanaged switch | Expecting per-port VLANs on it | *"This device has no VLAN awareness — all 5 ports are one broadcast domain"* |
| 6 | Unmanaged switch | Loop through two unmanaged switches | *"Frame has looped 50x — no BPDUs on this path, STP cannot break this loop"* |
| 7 | Router | Gateway IP on the wrong VLAN subinterface | *"ARP for 192.168.10.1 flooded VLAN 10 — no reply; gateway is on VLAN 20"* |
| 8 | Router | DHCP server on another VLAN, no relay | *"DHCP DISCOVER flooded VLAN 30 — no server is a member. Add a relay on the VLAN 30 interface"* |
| 9 | Router | Firewall denies inter-VLAN return traffic | *"ICMP reached VLAN 20; reply dropped by rule VLAN20 -> VLAN10 deny"* |
| 10 | Downstream router | Overlapping subnet with a tier above | *"Destination 192.168.1.50 matches the local subnet — never sent upstream"* |
| 11 | Downstream router | Second DHCP server on the upstream LAN | *"Two DHCP OFFERs for the same DISCOVER — from R1 and R2"* |
| 12 | Downstream router | Double NAT | *"Two NAT translations on this path — inbound connections cannot be initiated"* |
| 13 | Downstream router | **Missing return route** (NAT off) | *"Reached 10.20.0.5 via R2. Reply to 192.168.50.10 dropped at R1: no route — add 192.168.50.0/24 via R2"* |
| 14 | Multi-tier | DHCP relay chain broken at a middle tier | *"DISCOVER relayed R3->R2, stopped at R2: no helper address toward R1"* |
| 15 | Multi-tier | Asymmetric path | *"Request R1->R2->R4; reply R4->R3->R1 — return path differs"* |
| 16 | STP | Redundant link, STP off | *"MAC aa:..:01 seen on port 1 and port 2 within one step — MAC table is flapping"* |
| 17 | STP | Bridge priority makes the wrong switch root | *"Root is SW3 (priority 4096). Traffic SW1->SW2 now transits SW3"* |
| 18 | Managed switch | Trunk set to tag everything on egress, far end still sends untagged | *"SW1 port 2 admits tagged frames only; the untagged frame from SW2 was dropped at ingress"* |
| 19 | STP | Two parallel trunks, two VLANs, expecting per-VLAN load balancing | *"This model runs one spanning tree: port 2 is blocked for every VLAN. Gear defaulting to Rapid PVST+ may forward VLAN 10 here and VLAN 20 on the other trunk"* |

## 5. STP

Modelled, deterministically: root election by bridge ID, root port by lowest path cost, designated port per segment, everything else blocking. Loop behaviour falls out — STP on blocks the redundant link; STP off lets frames circulate and the tracer counts the loop.

**Not modelled: timers.** The converged state is computed. Listening/learning delays, BPDU timeouts and topology-change notifications are absent, so the sandbox cannot tell you how long a real network is down while reconverging. This limit belongs in the UI, not just in this file.

**Not modelled: per-VLAN spanning tree** (PVST+/MSTP). Single instance only — which is what
IEEE 802.1D itself defines, one instance for the whole network.

**This limit belongs in the UI too, and more urgently than the timer one.** Cisco Catalyst gear
*defaults* to Rapid PVST+, a separate instance per VLAN, so for those users the sandbox is not
missing an edge case — it is backwards from their default. Two parallel trunks carrying two VLANs
will load-balance on their gear and block one path here. v1 therefore owes a visible limitation
notice, a contextual warning fired by detecting that exact shape, and catalogue row 19. See
[ADR 0011](adr/0011-single-instance-stp-owes-a-warning.md).

## 6. Staging, and the honesty boundary

1. **Wired core** — the pipeline above, all devices, DHCP both ways.
2. **Access points as wired devices** — SSID to VLAN, management VLAN, wireless clients. Reuses stage 1; no new engine.
3. **Multi-WAN** — policy routing per VLAN first (a routing-table decision, no clock), then failover modelled as **state comparison** ("all lines up" vs "WAN1 down") rather than a timed transition, then load balancing. This answers *will failover work* without simulating seconds; it does not answer how long the outage lasts or whether sessions survive.
4. **Radio** — last, and presented differently.

Stages 1–3 execute published standards. **Radio coverage does not.** Whether an AP covers a given space depends on walls, materials, antenna patterns and interference; no standard answers it, and a real answer comes from a site survey. Any coverage model here is an estimate built on assumptions. It should therefore not share a visual language with the rest of the tool — otherwise trust leaks from the reliable half to the unreliable half. A confident-looking coverage heatmap is the most dangerous thing this app could render.

## 7. Out of scope for v1

Vendor profiles and vendor CLI syntax · per-VLAN STP · convergence timing · LACP · VRRP · VXLAN/EVPN · IPv6 · QoS · ACLs beyond simple inter-VLAN allow/deny · routing protocols (OSPF/BGP) · server-side persistence (local storage plus JSON export/import instead) · accounts · multi-user collaboration · importing a real device config.

## 8. Open questions

1. ~~Is ARP modelled explicitly, or is reachability enough?~~ **CLOSED 2026-08-25 — yes, explicitly, and with no ARP cache.** See [ADR 0010](adr/0010-arp-is-modelled-without-a-cache.md).
2. Topology sharing: URL-encoded state vs JSON download. URL sharing is free reach for a teaching tool but may not survive large topologies.
3. Broadcast storm representation: a hop counter is cheap and honest; an animation teaches harder. Cheap first.
