# Architecture

Headless TypeScript engine. Nothing here talks to a server. Persistence, when
it lands, is a JSON file the user keeps — there is no database.

This slice is the floor, the run context, one pass through a bridging
function, the topology walk that follows links, L3: hosts, ARP, routing
and the inter-VLAN firewall, the flow driver that traces a request
and its reply against one run context, NAT (masquerade plus port
forwards), DHCP as a message exchange (no leases), the ISP handoff
(PPPoE and a tagged WAN), a fixture profile seam, and the wired
reference scenario.

## Modules

```mermaid
flowchart LR
    M[model.ts<br>SPEC section 2 types] --> F[format.ts]
    R[reasons.ts<br>step x outcome] --> F
    F --> C[catalogue.ts<br>23 rows]
    D[defaults.ts<br>built-in profile] --> S[stp.ts]
    M --> S
    S --> U[run.ts<br>one context per run]
    U --> B[bridge.ts<br>802.1Q one hop]
    U --> W[walk.ts<br>dispatch and flood tree]
    U --> O[route.ts<br>L3 and firewall]
    U --> NA[nat.ts<br>masquerade and forwards]
    U --> DH[dhcp.ts<br>server and relay]
    U --> ISP[isp.ts<br>PPPoE tagged WAN]
    U --> N[send.ts<br>originate and ARP]
    U --> L[flow.ts<br>request and reply]
    W --> B
    W --> O
    W --> ISP
    O --> NA
    O --> DH
    N --> W
    N --> DH
    L --> N
    B --> F
    W --> F
    O --> F
    L --> F
    ISP --> F
    style M color:#000
    style R color:#000
    style F color:#000
    style C color:#000
    style D color:#000
    style S color:#000
    style U color:#000
    style B color:#000
    style W color:#000
    style O color:#000
    style NA color:#000
    style DH color:#000
    style ISP color:#000
    style N color:#000
    style L color:#000
```

| Module | Holds |
|---|---|
| `src/model.ts` | Topology, chassis, functions, frames, hops, flows. `nativeVlanOf` derives native VLAN from `untaggedVlans` — the field is not stored. |
| `src/reasons.ts` | `PIPELINE_STEPS`, `OUTCOMES`, `ReasonCode` as their product. |
| `src/defaults.ts` | Every tunable the engine will read, including encapsulation overheads. Named `ieee-defaults` v1 (ADR 0012). `unmanagedTag: 'pass'` is the built-in capability; a fixture profile may select `'strip'`. Usable MTU is computed, never stored. |
| `src/format.ts` | Turns a structured hop, trace, flow or warning into a sentence. |
| `src/catalogue.ts` | The 23-row table. Row 20 is Stage 2. |
| `src/stp.ts` | Converged 802.1D: root, root port, designated port, else blocking. Single instance. ADR 0011 warning. |
| `src/run.ts` | One context per run: FDB, resolved MACs, pending L3 sends, NAT sessions, hop budget, STP map, warnings, the active profile. Discarded when the run ends. |
| `src/bridge.ts` | One pass through one bridging function: STP ingress, acceptable frames, PVID, ingress filtering, learn, lookup, STP egress, membership, tagging. |
| `src/walk.ts` | Dispatcher: read `Port.ownedBy`, hand the frame to that function's executor. Floods are a tree. `hopsLeft` is one budget across every branch. Hosts with addressing answer ARP and take delivery. An arrival whose `ownedBy` cannot handle the frame is named as a hop on that chassis, not swallowed. Observations are keyed by name and facts, so two VLAN leaks on one walk both surface. `stp-root` is the blocked STP link plus the elected root the walk transited, not BFS hop order. Egress toward an `isp-handoff` in `pppoe` mode adds that layer; a frame larger than `usableMtu` drops at `mtu`. |
| `src/ip.ts` | IPv4 parse, subnet membership, longest-prefix match. No library. |
| `src/route.ts` | One pass through one routing function: tagged sub-interface match, ARP, DHCP, connected then static LPM, inter-VLAN allow/deny, then NAT. |
| `src/nat.ts` | NAT function on a routing function. Masquerade out the default-route iface; port-forwards match `proto` and `outsidePort`. Sessions live on the run context. |
| `src/dhcp.ts` | DHCP server and relay as sibling functions of routing. DISCOVER/OFFER/REQUEST/ACK are frames. An OFFER is `poolStart` from the matching scope. No lease record. |
| `src/isp.ts` | ISP handoff. The named `port` faces the customer; other ports owned by the function face the provider. A missing `vlanTag` or a PPPoE IP frame without that layer drops at `isp-handoff`. |
| `src/send.ts` | Originate from a sender. ARP only when the next-hop MAC is unknown. DHCP DISCOVER is broadcast. |
| `src/flow.ts` | Request then ICMP reply against one run context. Outcomes name which direction died; they are not pass/fail. |
| `src/host.ts` | Host chassis (no functions) answering ARP and taking delivery. |

There is no `switch (device.kind)`. There are no device kinds. A chassis
carries functions; the walk dispatches on `Port.ownedBy`. A chassis with
no `stp` function never appears in the STP map, so `portState` returns
  `forwarding` — the absence of a function, not a special case. A loop
through two such chassis exhausts the hop budget because nothing blocked
the redundant link. The `loop` observation is gated on chassis that took
the most revisits in that storm, not every chassis the walk touched — an
STP box on the way in does not hide an unmanaged cycle.

## Run

```mermaid
flowchart TD
    A[createRunContext topology] --> B[Collect chassis that have an stp function]
    B --> C[Elect a root per connected component]
    C --> D[Root port by lowest path cost]
    D --> E[Designated port per segment]
    E --> F[Everything else blocking]
    F --> G[Shape check: parallel trunks, two or more VLANs in common]
    G --> H[Return context]
    style H fill:#d7f5d7,color:#000
```

STP port state is three values that exist without a clock: `forwarding`,
`blocking`, `disabled` (ADR 0003). Listening and learning are absent.
Disabled means the member port has no link. A linked port that is the only
STP attachment on its LAN (an edge port facing a host or a chassis with no
`stp` function) is designated and forwards — blocking exists to remove
redundant bridge-to-bridge paths, not to black-hole access ports. The
computed map lives on the run context; the topology is not mutated.

## Data model

In-memory today; the same graph is what a JSON export will round-trip.

```mermaid
erDiagram
    Topology ||--|{ Chassis : contains
    Topology ||--|{ Link : contains
    Chassis ||--|{ Port : has
    Chassis ||--o{ Radio : has
    Chassis ||--o{ Fn : has
    Chassis ||--o{ InternalEdge : has
    Fn ||--o{ BridgePort : members
    Frame ||--|{ Hop : produces
    Flow ||--|| Frame : request
    Flow ||--o| Frame : reply
```

## Tests

Per [ADR 0017](adr/0017-structure-in-engine-tests-wording-against-the-table.md):
structural assertions name device, function, pipeline step, reason code, VLAN,
port and action, and contain no prose. Wording assertions compare `format(...)`
to `row.expected` on the catalogue table. Rows 2, 5, 6, 16 and 17 are traces
assembled from a walk. Row 7 is a trace assembled from `send`. Rows 9, 13 and 15
are flows assembled from `runFlow`. Rows 10 and 12 are traces from `send`.
Rows 3, 8, 11 and 14 are traces from a DHCP DISCOVER `send`. Row 23 is a
firewall hop after a query to the advertised resolver. Rows 21 and 22 are hops.
Row 19 is a warning, not a hop.

PVID is ingress only. Egress tagged/untagged is `untaggedVlans`. A VLAN ID of
0 is priority-tagged and is classified to the PVID, matching 802.1Q; that case
is not in the catalogue. `vlanAware: false` makes membership tests vacuous
and leaves the on-wire tag untouched unless the active profile selects
`unmanagedTag: 'strip'` — then the hop carries `provenance`. The wired
reference scenario (SPEC.md §9 minus AP and mesh) is `src/wan.test.ts`. Row 5
reproduces there as well as in `walk.test.ts`.
