# System flow

The product workflow from [`PRODUCT.md`](PRODUCT.md). `createRunContext`
computes spanning tree before any frame exists. `send` originates from a
host or other sender and ARPs only when that sender lacks its next-hop MAC.
`runFlow` sends a request, then — if it was delivered — the ICMP reply,
against that same context. `walkFrame` follows links and dispatches each
arrival on `Port.ownedBy`. An arrival that no executor will handle is still
a hop on that chassis — the walk does not swallow it. `bridgeFrame` is one hop through one bridging
function; `routeFrame` is one hop through one routing function, including
NAT masquerade and port-forwards when a `nat` function is present, and
DHCP when a `dhcp-server` or `dhcp-relay` function is present. `handoffFrame`
is one hop through an `isp-handoff`. `classifyWireless` is one hop through a
`wireless` function at `ssid-vlan`; the walk then follows `InternalEdge` onto
the chassis bridge. A bridging function with `canTag: false` still
classifies the VLAN and emits untagged; the far end's PVID is the
landed VLAN. After bridging, a `destination-lookup` drop on a chassis
addressed on that VLAN is existing host `arp`/`delivery`, not a management
step. A DHCP
DISCOVER is a broadcast; OFFER, REQUEST and ACK are unicast frames in the
same run. There is no lease record. Usable MTU is computed from the
encapsulation stack at egress; an oversized frame drops at `mtu`.

```mermaid
flowchart TD
    A[Describe the topology as data] --> C[createRunContext]
    C --> D[Converged STP state]
    D --> S[send from a sender]
    D --> FL[runFlow request then reply]
    FL --> S
    S --> P{Next-hop MAC<br>known?}
    P -->|no, and needed| AR[ARP request is a frame]
    AR --> Q[walkFrame queue]
    P -->|yes or not needed| Q
    D --> W{Parallel trunks<br>two or more VLANs?}
    W -->|yes| X[ADR 0011 warning<br>not a Hop]
    W -->|no| Q
    X --> Q
    Q --> B{hopsLeft?}
    B -->|0| Z[hop-budget hop]
    B -->|yes| E[executor for ownedBy<br>or host delivery]
    E --> F[One or more Hops per pass]
    F --> MTU{size > usableMtu?}
    MTU -->|yes| MD[mtu drop hop]
    MTU -->|no| T[Enqueue every transmission]
    T --> B
    MD --> G
    Z --> G[format turns hops and traces into sentences]
    F --> G
    G --> H[Caller reads the trace]
    I[Wording test] --> G
    I --> J[catalogue.ts row]
    style C fill:#d7f5d7,color:#000
    style D fill:#d7f5d7,color:#000
    style E fill:#d7f5d7,color:#000
    style Q fill:#d7f5d7,color:#000
    style G fill:#d7f5d7,color:#000
    style H fill:#d7f5d7,color:#000
    style FL fill:#d7f5d7,color:#000
    style MD fill:#ffd7d7,color:#000
```

A wireless client is a host. `send` originates from it the same way as
from a wired host; the first hop is `ssid-vlan` on the AP or mesh node
the client joined. The SPEC.md §9 reference fixture includes both boxes:
a tagged-capable AP with three SSIDs, and two consumer mesh nodes on a
`medium: 'wireless'` backhaul that cannot tag.

A link marked `up: false` is not part of any run: `walkFrame` never
enqueues a frame across one, STP computes as if it were not drawn, and a
route whose via sits behind one is not a candidate — the drop is still
`route-lookup` and names the skipped default (ADR 0020). Failover is two
runs of one topology, not a transition (ADR 0003): WAN1 down with no
second default is catalogue row 25; WAN1 down with a WAN2 default takes
WAN2, masquerade included. The §9 fixture carries both WANs — WAN1 is
PPPoE over tagged VLAN 500, WAN2 an untagged static `isp-handoff` — and
the working traces sit beside rows 24 and 25: a VLAN 30 selector route
forwarding guest traffic out WAN2 with WAN1 up, and the WAN1-down
failover delivered through the second handoff.

A drop is an outcome, not an error. The hop names the pipeline step that
produced it. There is no pass/fail field on a hop.

A flow — request plus reply sharing one run context — is how rows 9, 13 and
15 are seen. `runFlow` is that driver. The reply reads the FDB, resolved
MACs and NAT sessions the request populated; a reply traced cold floods.
The dest replies to the source address it actually received, so a masqueraded
request comes home without a return route. `Flow.outcome` names which
direction died. It is not a pass/fail field.

## UI loop

The browser UI runs the same engine, driven by clicks. The loop is: place a
preset box, link two free ports, edit in the inspector, send, read sentences,
export. The topology never leaves the tab except as the sandbox JSON file.

```mermaid
flowchart TD
    PA[Click a palette box] --> AP[addPreset writes a chassis<br>plus functions]
    AP --> SE{Link pending?}
    SE -->|yes| CL[completeLink joins<br>two free ports]
    SE -->|no| SL[select the device]
    SL --> ST[Start link on a free port]
    ST --> SE
    CL --> IN[Inspector: PVID ingress<br>untagged VLANs egress]
    IN --> SE
    SE --> SD[Send: createRunContext<br>runFlow on the topology]
    SD --> HO[Hops, STP warning,<br>cold-trace notice]
    HO --> SE
    SD --> EX[Export sandbox JSON<br>or import one]
    EX --> SE
    style SD fill:#d7f5d7,color:#000
    style HO fill:#d7f5d7,color:#000
    style EX fill:#d7f5d7,color:#000
```
