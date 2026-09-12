# Architecture

Headless TypeScript engine. Nothing here talks to a server. Persistence is a
JSON file the user keeps — there is no database. GitHub Pages serves the
Vite `ui/dist` bundle at https://alanfong93.github.io/network-sandbox/
([ADR 0032](adr/0032-host-the-static-ui-on-github-pages.md)); that host is
static files, not an API. The in-memory Topology is
that file: `toJson` / `fromJson` round-trip it through the version-1 sandbox
envelope `{format, version, topology}`. A config grammar
(`network-sandbox-config-grammar` v1) is data the engine interprets:
`importConfig(grammar, text)` maps key=value lines onto Topology fields the
engine already has (ADR 0012, ADR 0015). Unknown format, version, and mapping
target fail by named errors. Sandbox JSON remains the export. An optional `layout` sibling
(device id → `{x,y}`) is UI-owned; the engine never reads it (ADR 0029).

This slice is the floor, the run context, one pass through a bridging
function, the topology walk that follows links, L3: hosts, ARP, routing
and the inter-VLAN firewall, the flow driver that traces a request
and its reply against one run context, NAT (masquerade plus port
forwards), DHCP as a message exchange (no leases), the ISP handoff
(PPPoE and a tagged WAN), a versioned profile document and registry, the reference
scenario (SPEC.md §9, including AP, mesh and a second WAN), wireless
dispatch: classify at `ssid-vlan`,
then follow `InternalEdge` onto the chassis bridge, a tagged AP
uplink, AP management as existing host delivery on the chassis
VLAN, and untagged-only as `canTag: false` on bridging (catalogue
row 20). `Link.up` (omitted is up) makes down a link property: the walk
does not traverse a down link, STP computes as if it were not drawn, and
a route whose via sits behind one is not a candidate — failover as two
runs of one topology (ADR 0003, ADR 0020; catalogue row 25). The estimate
seam keeps assumed output out of the trace's language: an `Estimate` is
not a `FormatInput` and formats only through `formatEstimate` (ADR 0024).

## Modules

```mermaid
flowchart LR
    M[model.ts<br>SPEC section 2 types] --> F[format.ts]
    M --> J[json.ts<br>v1 sandbox envelope]
    R[reasons.ts<br>step x outcome] --> F
    F --> C[catalogue.ts<br>25 rows]
    D[defaults.ts<br>built-in profile] --> PF[profile.ts<br>v1 profile envelope]
    PF --> U[run.ts<br>one context per run]
    D --> S[stp.ts]
    M --> S
    S --> U
    U --> B[bridge.ts<br>802.1Q one hop]
    U --> W[walk.ts<br>dispatch and flood tree]
    U --> O[route.ts<br>L3 and firewall]
    U --> NA[nat.ts<br>masquerade and forwards]
    U --> DH[dhcp.ts<br>server and relay]
    U --> ISP[isp.ts<br>PPPoE tagged WAN]
    U --> WL[wireless.ts<br>ssid-vlan classify]
    U --> N[send.ts<br>originate and ARP]
    U --> L[flow.ts<br>request and reply]
    U --> RS[resolver.ts<br>name table lookup]
    W --> B
    W --> O
    W --> ISP
    W --> WL
    O --> NA
    O --> DH
    N --> W
    N --> DH
    L --> N
    L --> RS
    B --> F
    W --> F
    O --> F
    L --> F
    ISP --> F
    style M color:#000
    style J color:#000
    style R color:#000
    style F color:#000
    style C color:#000
    style D color:#000
    style PF color:#000
    style S color:#000
    style U color:#000
    style B color:#000
    style W color:#000
    style O color:#000
    style NA color:#000
    style DH color:#000
    style ISP color:#000
    style WL color:#000
    style N color:#000
    style L color:#000
    style RS color:#000
```

| Module | Holds |
|---|---|
| `src/model.ts` | Topology, chassis, functions, frames, hops, flows. `nativeVlanOf` derives native VLAN from `untaggedVlans` — the field is not stored. Chassis `vlan` is the VLAN host addressing answers on. `Link.up` is omitted-is-up: down is a link property, not a device role (ADR 0020). |
| `src/json.ts` | Version-1 sandbox envelope `{format, version, topology}`. `taggedVlans` / `untaggedVlans` encode as number arrays. `fdb` and `stp.state` are omitted on write and empty Maps on parse. Extra envelope keys (a later `layout` sidecar) are ignored on parse, so they never become Topology (ADR 0029). Unknown `fn.kind` and unsupported versions fail by name (`UnknownFunctionKindError`, `UnsupportedSandboxVersionError`). No AJV, no `$set` markers (ADR 0026). |
| `src/reasons.ts` | `PIPELINE_STEPS`, `OUTCOMES`, `ReasonCode` as their product. |
| `src/defaults.ts` | Every tunable the engine will read, including encapsulation overheads. Named `ieee-defaults` v1 (ADR 0012). `unmanagedTag: 'pass'` is the built-in capability; a fixture profile may select `'strip'`. Usable MTU is computed, never stored. |
| `src/profile.ts` | Version-1 profile envelope `{format:'network-sandbox-profile', version:1, profile}` separate from sandbox JSON (ADR 0012, ADR 0026). `toProfileJson` / `fromProfileJson` round-trip `{id, version, unmanagedTag, capabilities:{}}`. Empty `capabilities` is valid; an unknown capability key fails by name. A caller-supplied registry always includes `ieee-defaults`; `createRunContext` resolves `topology.profiles` against it before any hop. Unknown format, version, missing id, unregistered id, more than one non-builtin id, and a second-argument mismatch fail by named errors. Direct object injection remains only when the id list is empty. No AJV. The strip fixture is `src/profiles/cheap-silicon.json`. |
| `src/format.ts` | Turns a structured hop, trace, flow or warning into a sentence. An `Estimate` (`kind: 'estimate'`, non-empty `assumptions`) is not a `FormatInput` and never passes through `format` — `formatEstimate` renders it, naming itself and listing its assumptions (ADR 0024). |
| `src/catalogue.ts` | The 26-row table. Row 20 is Stage 2; rows 24-26 are Stage 3. |
| `src/stp.ts` | Converged 802.1D: root, root port, designated port, else blocking. Single instance. ADR 0011 warning. An SVI bridging member (its port owned by the routing function) is not an STP port — port roles belong to link attachments only, and the SVI is the bridge's internal interface to the route processor. |
| `src/run.ts` | One context per run: FDB, resolved MACs, pending L3 sends, NAT sessions, hop budget, STP map, warnings, the active profile resolved from `topology.profiles` plus a registry. Discarded when the run ends. |
| `src/bridge.ts` | One pass through one bridging function: STP ingress, acceptable frames, PVID, ingress filtering, learn, lookup, STP egress, membership, tagging. `canTag: false` keeps the classified VLAN and emits untagged. |
| `src/walk.ts` | Dispatcher: read `Port.ownedBy`, hand the frame to that function's executor. A `wireless` function classifies at `ssid-vlan` and the walk follows `InternalEdge` onto the chassis bridge — still dispatch on the function, never `device.kind`. Floods are a tree. `hopsLeft` is one budget across every branch. Hosts with addressing answer ARP and take delivery. The fallback dispatch also answers a same-VLAN DHCP DISCOVER on a chassis whose `dhcp-server` function has a matching scope (classified VLAN is the frame's tag, else the chassis' addressing VLAN) — the OFFER leaves the arrival port; a routing chassis never runs this branch (its ports dispatch to `routing`, which keeps `decideDhcp`). A bridge-embedded DHCP server (issue #79) answers too: after bridge ingress classification, the same post-classification seam as the SVI composition consults the co-resident server — the OFFER fires while the DISCOVER still floods to every other member port (flood + answer, never answer-instead-of-flood; the predicate stays `standaloneDhcpDecision`'s narrow conditions, so the answer never steals frames the server would not take). SVI composition (issue #71): after bridge ingress classification, a chassis routing function is reachable from the bridging ports for exactly two frame shapes — an ARP for a routing iface's IP on that iface's VLAN, and a frame addressed to a routing iface's MAC; the first answers with the SVI's MAC, the second hands the frame to `routeFrame` at the SVI port (the frame carries the bridge-classified VLAN), and routed egress out an SVI re-enters the chassis bridge through the `rt`→`br` InternalEdge. Every other frame bridges exactly as before. After a bridging `destination-lookup` drop, a chassis whose host addressing is on that VLAN still takes `arp`/`delivery` — not a management step. An arrival whose `ownedBy` cannot handle the frame is named as a hop on that chassis, not swallowed. Observations are keyed by name and facts, so two VLAN leaks on one walk both surface. When the previous device classified at `ssid-vlan`, its bridging function has `canTag: false`, and the far end's PVID differs, the observation is `ssid-untagged` (mapped vs landed VLAN), not `vlan-leak`. `stp-root` is the blocked STP link plus the elected root the walk transited, not BFS hop order. Egress toward an `isp-handoff` in `pppoe` mode adds that layer; a frame larger than `usableMtu` drops at `mtu`. `peerOf` returns no peer across a link marked `up: false`, so no frame traverses a down link (ADR 0020). |
| `src/ip.ts` | IPv4 parse, subnet membership, longest-prefix match. No library. |
| `src/route.ts` | One pass through one routing function: tagged sub-interface match, ARP, DHCP, connected then static LPM - a route carrying the frame VLAN's `fromVlan` selector beats any destination-only route - inter-VLAN allow/deny, then NAT. A connected iface on a down link, and a route whose via resolves to a down-link iface, are not candidates; the drop stays `route-lookup` and names the skipped default (ADR 0020, row 25). An equal-prefix tie in the tier that decided the frame picks the first reachable route in `routes[]` order and the hop names that via - never a split ratio (ADR 0021, row 26). |
| `src/nat.ts` | NAT function on a routing function. Masquerade out any iface a default route names (ADR 0022): the selector-aware pick for the frame's VLAN, the plain default, or another WAN reached by a longer-prefix static or selector route - the set skips defaults whose via sits behind a down link, so masquerade follows failover (ADR 0020). Port-forwards match `proto` and `outsidePort` against any default-named WAN's public IP; a DNAT arrived at from an internal iface is hairpin - source rewritten to the egress iface IP, the return session recorded with the original public destination, and the reply re-enters the router (ADR 0022). Sessions live on the run context. A session from a service payload records the port tuple (proto, toPort, clientPort, outsidePort for DNAT); a return leg carrying ports matches it exactly, a portless frame matches only portless sessions first-wins - named on the hop when ambiguous - and the reply's source port is restored to the contacted port (ADR 0023). |
| `src/dhcp.ts` | DHCP server and relay as functions — siblings of routing when mounted on a router, or standalone on a host-like chassis (`standaloneDhcpDecision`, reached through the walk's fallback dispatch), and bridge-embedded: the walk's post-ingress seam consults a co-resident server after bridging classification, answering with the flood preserved (issue #79). DISCOVER/OFFER/REQUEST/ACK are frames. An OFFER is `poolStart` from the matching scope. No lease record. A standalone server with divergent multi-scope VLANs answers only on `chassis.vlan` — one identity, one VLAN (RFC 2131 s4.3.1); import warns on the shape. |
| `src/isp.ts` | ISP handoff. The named `port` faces the customer; other ports owned by the function face the provider. A missing `vlanTag` or a PPPoE IP frame without that layer drops at `isp-handoff`. |
| `src/send.ts` | Originate from a sender. ARP only when the next-hop MAC is unknown. DHCP DISCOVER is broadcast. The sender's own `origin:forwarded` hop leads every walk that left the sender (#123) - a step, not a scenario (ADR 0017). `originate` extends it to routing chassis: a router-sourced frame (#129, the flow reply) enters its own routing function at the sourcing iface — the same internal-dispatch entry the SVI punt uses (#71) — so route lookup, pending ARP, NAT, and SVI egress re-entry run unchanged. |
| `src/resolver.ts` | The name table: `matchRecord` over a resolver function's `{name, ip}` records, case-insensitive and trimmed; `lookupRecord` reads the table of the chassis the query reached. A table, not a zone, not recursion (ADR 0030). |
| `src/flow.ts` | Request then ICMP reply against one run context. The reply's sender is the chassis the request was delivered at — a host walks via `send`, a routing chassis originates through its own routing function (#129). With a name destination: a udp/53 walk to the sender's advertised resolver first, the table lookup on the chassis the query reached, then the echo leg to the resolved IP — the query frame rides on `Flow.query` (ADR 0030). Outcomes name which direction died; they are not pass/fail. |
| `src/host.ts` | Host chassis (no functions) answering ARP and taking delivery. |
| `src/wireless.ts` | One pass through a wireless function: SSID to VLAN at `ssid-vlan`, then `InternalEdge` onto the chassis bridge. Not a second forwarder. Radio may store a configured channel (not an RF claim, ADR 0025). Radio and link carry no power or coverage. |

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
    A[createRunContext topology] --> P[Resolve topology.profiles against the registry]
    P --> B[Collect chassis that have an stp function]
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

## Browser UI

The UI is a separate entry under `ui/` that imports the engine and never the
other way round (ADR 0016, ADR 0027). Behaviour lives in pure, unit-tested
modules; `main.ts` is the only DOM-glue module. Presets write functions, not a
device kind (ADR 0013): the palette includes the managed switch, the
unmanaged switch, the router (a LAN-side bridge plus one LAN SVI and routed
WAN uplinks — routing+bridging+nat,
[ADR 0031](adr/0031-router-lan-jacks-are-one-bridge.md); the inspector offers
LAN count 1-8 and WAN count 1-2: grown LAN jacks join the one LAN bridge at
the existing members' PVID, an extra WAN is a routed iface with its own
default route, and both come back off on shrink; an SVI member port is
internal wiring and is offered nowhere as a cabling jack — not on the canvas
and not in the inspector), the L3 switch (bridging+stp+routing
with SVI-shaped rt-owned bridging members — the #71 composition), the
standalone DHCP server (host-like addressing plus a `dhcp-server` scope — the
#72 composition, with scope-editing controls), the AP and the modem. Pure
managed switches start at 8 ports; pure unmanaged switches start at 5. Their
inspector uses the market-SKU select (5, 8, 16, 24, 48) to resize the chassis'
ports and the matching bridge members together; it refuses to remove a cabled
port and never silently unlinks it. The control is absent from the L3 switch:
its routed SVI ports are a composition, not spare switch ports. The inspector
keeps PVID and `untaggedVlans` as separate
controls (ADR 0008); Start link is per free port (router `wan` can be first);
router WAN VLAN is `RouterIface.vlan`, not PVID; SVI-shaped ifaces (an rt-owned
port that is also a bridging member) render no independent VLAN control on
either half — neither the sub-interface VLAN input nor the bridge-member
PVID/tagged/untagged inputs — because the SVI is one mechanism and either edit
alone would desynchronise `iface.vlan` from the member's carried VLANs (routed
egress is gated by the member's VLANs at egress-membership); editing a
dhcp-server scope's vlan moves the chassis addressing VLAN with it, because
the engine's standalone answer gates on `chassis.vlan` and a drifted scope
could never answer; the modem inspector offers the
ISP check as editable controls (`mode` pppoe/dhcp/static + required
VLAN tag, cleared for a no-tag handoff); the trace panel offers two send types —
ICMP echo to a destination IP, or DHCP DISCOVER, a broadcast that hides the
destination input and renders request hops only (the flood path and the
OFFERs; walk observations labelled by phase and the flow-level ones) — and renders the engine's
own sentences — hops
from the walk, observations and the ADR 0011 warning through `format()` — plus
the cold-trace notice (ADR 0010) and the no-timers notice. An stp-function
chassis renders an STP priority control (function presence, never preset id —
the unmanaged switch stays bare); every bridge-member port renders its
Acceptable frame types admission rule — the one admission control the engine
enforces even on a VLAN-blind bridge — and a VLAN-aware member port adds the
Ingress filtering flag, because one control edits one 802.1Q mechanism
(ADR 0008). A VLAN-blind bridge hides its inert membership controls (mode,
PVID, untagged, tagged), and each VLAN-blind bridging function states the
capability in one note carrying its own member count - an empty bridge
states nothing; the owning function's `vlanAware` flag decides, never the
preset id (ADR 0007, ADR 0013). The shipped UI is the forms editor
(#58) plus a vanilla-SVG **view and builder** of the topology (`ui/canvas.ts`):
chassis faces (from preset/functions, not a device kind), sagged cables,
port handles labelled with a readable jack name - `LAN`/`WAN` and
`LAN 2`/`WAN 2` for the router convention, the port id everywhere else,
a pure id mapping with the real `data-port` kept for linking (#121) -
select, drop/port-click/drag, and a hop-replay packet that rides the cable
between recorded hops (play/step/pause, no verdict). A live hop also
draws a marching-chevron overlay along the same cable path, traversed
from the hop's origin toward its destination (#122) - its own element,
so a live wired hop keeps the solid stroke and does not reuse the
wireless dash (#119). The SVG camera (wheel zoom toward the
cursor, empty-drag pan, Fit) is a view transform only — it is not `layout`
and is not in the sandbox file. Forms UI stays
(ADR 0029). Layout is a sandbox-envelope
sibling `{deviceId: {x,y}}`, never fields on Topology or Chassis. Missing
layout is valid — the later UI auto-places. `ui/starters.ts` plus `ui/starters/missing-return-route.json` is the ADR 0005
starter (NAT off, return route missing; catalogue row 13). Newly placed
routers still write a `nat` function. `ui/jsonio.ts` round-trips
optional `layout` as an envelope sibling (`exportSandbox(topology, layout?)`,
`importSandbox` returns `{topology, layout}`); engine `fromJson` still
receives topology only and ignores extra keys. Beside the Sandbox JSON
section sits the optional AI review panel (`ui/ai.ts`, ADR 0033): a
`network-sandbox-ai` v1 config file (endpoint, model, key) loaded in-tab,
an allowlist-built share-safe payload previewed then confirmed to the
user's own endpoint via `fetch`, and a labelled advice panel with
snapshot-frozen follow-up chat. Failure catalogue rows join the payload
only when the last trace supports them (`TraceRender.observationCodes` /
`warningCodes` / hop step+action). Without a loaded config the sandbox is
unchanged.

```mermaid
flowchart LR
    P[presets.ts<br>palette boxes] --> S[state.ts<br>EditorState edits]
    S --> R[render.ts<br>HTML strings]
    S --> CV[canvas.ts<br>SVG view]
    S --> T[trace.ts<br>createRunContext + runFlow]
    T --> R
    LY --> CV
    CV --> M[main.ts<br>DOM wiring]
    S --> J[jsonio.ts<br>envelope sibling layout]
    S --> LY[layout sidecar<br>device id to x,y]
    LY --> J
    LY --> R
    R --> M
    T --> E[engine src/<br>topology only]
    J --> E
    P --> E
    AI[ai.ts<br>optional AI review] --> E
    AI --> T
    M --> AI
    style E fill:#d7f5d7,color:#000
    style M fill:#d7f5d7,color:#000
    style LY fill:#fff3cd,color:#000
    style CV fill:#fff3cd,color:#000
    style AI fill:#fff3cd,color:#000
```

### Optional AI review (sequence)

`ui/ai.ts` is UI-side only; the engine never imports it (ADR 0033). The one
network interaction in the whole product is the tab POSTing to **the user's
own endpoint** — this system has no server on either end of that arrow.

```mermaid
sequenceDiagram
    participant U as User
    participant Tab as Browser tab
    participant E as User's endpoint
    U->>Tab: Load network-sandbox-ai file
    Tab-->>U: Shows endpoint + model (key never echoed)
    U->>Tab: Review with AI
    Tab-->>U: Preview: the exact allowlist payload (no ISP credentials, no key)
    U->>Tab: Confirm and send
    Tab->>E: POST /chat/completions (Bearer key)
    E-->>Tab: Reply text, or CORS/network, 401, HTTP n (named)
    Tab-->>U: Advice panel — not a trace, no write path
    U->>Tab: Follow-up chat (frozen snapshot)
    Tab->>E: POST with the conversation
    Note over Tab: Topology edit blocks chat until Review again
```

## Data model

The in-memory graph is the file. `toJson` writes the version-1 envelope;
`fromJson` parses topology back. Canvas coordinates are not Topology —
when present they live on the optional `layout` envelope sibling the UI
owns (ADR 0029). Missing `layout` is valid. Runtime
Maps (`fdb`, `stp.state`) are not persisted — `createRunContext` rebuilds
them.

```mermaid
erDiagram
    Topology ||--|{ Chassis : contains
    Topology ||--|{ Link : contains
    Chassis ||--|{ Port : has
    Chassis ||--o{ Radio : has
    Chassis ||--o{ Fn : has
    Chassis ||--o{ InternalEdge : has
    Fn ||--o{ BridgePort : members
    Fn ||--o{ NameRecord : records
    Frame ||--|{ Hop : produces
    Flow ||--o| Frame : query
    Flow ||--|| Frame : request
    Flow ||--o| Frame : reply
```

## Tests

Per [ADR 0017](adr/0017-structure-in-engine-tests-wording-against-the-table.md):
structural assertions name device, function, pipeline step, reason code, VLAN,
port and action, and contain no prose. Wording assertions compare `format(...)`
to `row.expected` on the catalogue table. Rows 2, 5, 6, 16 and 17 are traces
assembled from a walk. Rows 1, 4 and 18 are end-to-end walk fixtures too —
`src/walk.test.ts` builds each topology, learns what the walk would have
learned, and asserts the hop structurally plus the verbatim catalogue
sentence (row 1 egress-membership, row 4 ingress-filtering admitted with a
delivery on the trunk, row 18 tagged-only ingress drop). Row 20 is a trace assembled from a walk
(`src/mesh.test.ts`, and again in the reference fixture). Row 7 is a trace assembled from `send`. Rows 9, 13 and 15
are flows assembled from `runFlow`. Rows 10 and 12 are traces from `send`.
Rows 3, 8, 11 and 14 are traces from a DHCP DISCOVER `send`. Row 23 is a
firewall hop after a query to the advertised resolver. Rows 21 and 22 are hops.
Row 19 is a warning, not a hop. Row 25 is a `route-lookup` drop on a
multi-WAN router with WAN1's link marked `up: false` and no second default;
the failover runs (`src/wan.test.ts`) show WAN1 down with a WAN2 default
taking WAN2, and a selector route targeting the down WAN going unused.
Row 26 is the equal-cost tie: two VLAN 10 selector defaults, both up,
forward via the first in `routes[]` order — repeatable, verbatim in
`src/wan.test.ts`. The §9 fixture itself now carries WAN2 — a second
`isp-handoff` in static mode plus a second default — and the working
traces sit beside rows 24 and 25: a VLAN 30 selector forwarding out
WAN2 with WAN1 up, and WAN1 down taking WAN2 through the second
handoff.

PVID is ingress only. Egress tagged/untagged is `untaggedVlans`. A VLAN ID of
0 is priority-tagged and is classified to the PVID, matching 802.1Q; that case
is not in the catalogue. `vlanAware: false` makes membership tests vacuous
and leaves the on-wire tag untouched unless the active profile selects
`unmanagedTag: 'strip'` — then the hop carries `provenance`.
`canTag: false` is a separate capability: membership still uses VLANs,
egress is always untagged. A preset writes that field; the engine does
not branch on a vendor name. The
reference scenario (SPEC.md §9, including AP, mesh and a second WAN) is `src/wan.fixture.ts`.
Row 5 reproduces there as well as in `walk.test.ts`; row 20 reproduces
there as well as in `src/mesh.test.ts`. Tagged AP uplink and
management VLAN (issue #30, no catalogue row) are `src/ap.test.ts`.
Sandbox JSON round-trip is `src/json.test.ts`: Sets survive as arrays,
Maps stay out of the file, unknown kinds and unsupported versions fail
by name, and the §9 fixture's `send` hops match after parse. Profile
JSON is a separate envelope (`src/profile.test.ts`): `topology.profiles`
stays an id list; the body lives in a profile document.
