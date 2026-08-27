# Architecture

Headless TypeScript engine. Nothing here talks to a server. Persistence, when
it lands, is a JSON file the user keeps — there is no database.

This slice is the floor, the run context, one pass through a bridging
function, and the topology walk that follows links.

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
    W --> B
    B --> F
    W --> F
    style M color:#000
    style R color:#000
    style F color:#000
    style C color:#000
    style D color:#000
    style S color:#000
    style U color:#000
    style B color:#000
    style W color:#000
```

| Module | Holds |
|---|---|
| `src/model.ts` | Topology, chassis, functions, frames, hops, flows. `nativeVlanOf` derives native VLAN from `untaggedVlans` — the field is not stored. |
| `src/reasons.ts` | `PIPELINE_STEPS`, `OUTCOMES`, `ReasonCode` as their product. |
| `src/defaults.ts` | Every tunable the engine will read, including encapsulation overheads. Named `ieee-defaults` v1 (ADR 0012). |
| `src/format.ts` | Turns a structured hop, trace, flow or warning into a sentence. |
| `src/catalogue.ts` | The 23-row table. Row 20 is Stage 2. |
| `src/stp.ts` | Converged 802.1D: root, root port, designated port, else blocking. Single instance. ADR 0011 warning. |
| `src/run.ts` | One context per run: FDB, resolved MACs, hop budget, STP map, warnings. Discarded when the run ends. |
| `src/bridge.ts` | One pass through one bridging function: STP ingress, acceptable frames, PVID, ingress filtering, learn, lookup, STP egress, membership, tagging. |
| `src/walk.ts` | Dispatcher: read `Port.ownedBy`, hand the frame to that function's executor. Floods are a tree. `hopsLeft` is one budget across every branch. |

There is no `switch (device.kind)`. There are no device kinds. A chassis
carries functions; the walk dispatches on `Port.ownedBy`. A chassis with
no `stp` function never appears in the STP map, so `portState` returns
`forwarding` — the absence of a function, not a special case. A loop
through two such chassis exhausts the hop budget because nothing blocked
the redundant link.

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
assembled from a walk. Row 19 is a warning, not a hop.

PVID is ingress only. Egress tagged/untagged is `untaggedVlans`. A VLAN ID of
0 is priority-tagged and is classified to the PVID, matching 802.1Q; that case
is not in the catalogue. `vlanAware: false` makes membership tests vacuous
and leaves the on-wire tag untouched.
