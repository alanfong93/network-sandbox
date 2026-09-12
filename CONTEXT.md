# Context — shared vocabulary

Words this project uses precisely, and the words it deliberately does not use.
If a term here is used loosely in code, UI copy or a commit message, fix the usage —
don't widen the definition.

## Resolved

### Trace

The ordered list of hops a frame produced while crossing the topology, from source to
its final action. A trace is the product's primary output — see ADR 0002.

- One frame produces exactly one trace. One trace has one or more hops.
- **Do not call it:** *result*, *output*, *verdict*, *report*. Each of those implies
  a conclusion the tool does not draw.

### Hop

One device's handling of one frame: in port, out port, VLAN, action
(`forwarded | flooded | dropped | delivered`) and a reason. Recorded for **every**
action, including successful ones — a hop with no reason is an incomplete
implementation.

- **Do not call it:** *step*, *log line*, *event*. "Step" is reserved for a stage of
  the 802.1Q pipeline within a single hop.

### Verdict

The pass/fail conclusion this project refuses to render. The term exists in the
glossary so it stays recognisable in review: if a design produces a verdict, that
design is wrong (ADR 0002).

### Drop

A frame failing a step of the ingress/forward/egress pipeline. **A drop is an
outcome, not an error.** It is the expected, correct behaviour of the standard, and
it is simultaneously a teaching moment and a bug report. UI copy must not style it as
a crash or a fault in the tool.

### Sub-router

A **position** in the topology — a router with an `uplink`, sitting behind another
router. It is *not* a device kind; there is one `Router` type (ADR 0004).

- **Do not use the word in code, type names, or UI labels.** Acceptable only in prose
  explaining the position. Where the concept is needed, say *downstream router*.

### Converged state

The single settled state the engine computes: STP resolved, tables populated, no
clock and no event queue (ADR 0003). "The converged state" is the *only* state the
sandbox has.

- **Do not say:** *after convergence*, *once it settles*, or anything else implying a
  before. There is no before.

### Honesty boundary

The line between output that is **derived** from a published standard (802.1Q,
802.1D, IP routing) and output that is an **estimate** (radio coverage). The two must
not share a visual language (ADR 0006). Used as a noun in design discussion: "that
crosses the honesty boundary."

### Estimate

Output that is **assumed, not derived** — radio coverage is the stage 4 case.
An `Estimate` carries its `assumptions` as a non-empty list and is rendered by
`formatEstimate`, never by `format`: `kind: 'estimate'` is not a `FormatInput`,
so handing one to `format` is a type error
([ADR 0006](docs/adr/0006-radio-is-an-estimate-not-a-result.md),
[ADR 0024](docs/adr/0024-estimates-never-pass-through-format.md)).

- **Do not call it:** *trace*, *result*, *prediction*, *verdict*. A trace is
  derived; an estimate is assumed. The two never share a formatter.

### Failure catalogue

The numbered table in `docs/SPEC.md` §4. Each row is a reproducible mistake plus the
exact wording the trace should produce. Refer to entries as **catalogue row N**, and
keep the numbering stable — rows are referenced from ADRs and tests.

### Down link

A `Link` with `up: false`. Omitted `up` is up. Down is a **link** property —
the walk does not traverse it, STP computes as if it were not drawn, and a
route whose via sits behind it is not a candidate
([ADR 0020](docs/adr/0020-down-is-a-link-property.md)). Failover is two runs
of one topology: flip the field, re-run
([ADR 0003](docs/adr/0003-converged-state-no-timers.md)).

- **Do not call it:** *WAN down* (a down inter-switch copper link is the same
  property), *interface down* (the field is on the link, not the device or the
  port), *offline*, *failover state* (failover is the comparison of two runs,
  not a field).

### Stage

A roadmap unit from `docs/SPEC.md` §6: 1 wired core, 2 access points, 3 multi-WAN,
4 radio. Distinct from a **milestone**, which is a process/delivery boundary that
triggers `/archive-milestone`. One stage may take several milestones.

### Unmanaged switch

A switch with **no configurable per-port VLAN membership**. The type identifier is
`unmanaged-switch`; the UI label is "Unmanaged switch".

- **"Dumb switch" is prose only.** Acceptable in the README or a tooltip where the
  tone is doing work; never a type name, never a UI label. `dumb-switch` was the
  spec's original `kind` and was renamed — see [ADR 0007](docs/adr/0007-unmanaged-switch-names-a-capability.md).
- The name states a **capability**, not a data-plane guarantee. "Unmanaged" is a
  management-plane word; real unmanaged hardware varies in how it treats tagged
  frames. Do not let UI copy turn the name into a promise.

### PVID

**An ingress setting.** The VLAN an accepted *untagged* frame enters when it arrives
on a port. Stored as `Port.pvid`. It is the IEEE 802.1Q term and it is the field name
in code, on access ports and trunks alike.

- **PVID is not the native VLAN.** They coincide by default and are independent.
- **Do not label a control "Native VLAN (PVID)".** That single label across two
  mechanisms is the conflation this project exists to expose. See [ADR 0008](docs/adr/0008-pvid-is-ingress-native-vlan-is-egress.md).

### Native VLAN

**An egress setting.** The one VLAN a trunk sends *untagged* — the single entry in
`Port.untaggedVlans`. It is **derived for display, never stored** as its own field.

- A UI control that writes to both `pvid` and `untaggedVlans` at once is forbidden,
  however convenient. One control edits one mechanism.
- The pair separates in practice: a trunk configured to tag everything on egress
  (`untaggedVlans` empty) with `acceptableFrameTypes: 'tagged-only'` has no native
  VLAN at all while still carrying a `pvid`. Catalogue row 18.
- **Do not call it:** *default VLAN*, *untagged VLAN* alone (ambiguous — say
  "egress-untagged"), or *PVID*.

### Preset

The named box on the palette — "Home router with WiFi" — and the list of functions it
switches on. **A preset is a profile** ([ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md),
[ADR 0013](docs/adr/0013-devices-are-a-chassis-plus-functions.md)): both are declarative
data selecting capabilities the engine already implements. They are one mechanism, not
two.

- **Do not call it:** *device type*, *device class*. There are no device types — there
  is a chassis, and there are functions.

### Palette

The list of preset boxes the user places from. It shows **boxes, not functions**
([ADR 0013](docs/adr/0013-devices-are-a-chassis-plus-functions.md)): the user drags
"Managed switch", and the preset writes the functions underneath. Placing from the
palette is how a topology starts.

- **Do not call it:** *toolbox*, *toolbar*. It is the list of boxes, not a set of
  editing tools.

### Starter

A shipped sample topology the **Starters** picker loads into the editor:
the home network (first look — modem, router with 1 WAN and 4 LAN jacks,
two hosts, and the send form's defaults already point H1 at H2) and the
missing-return-route broken reply (catalogue row 13, ADR 0005 content).
The picker calls the registry factory (`starter.load()` in
`ui/starters.ts`) directly; the documents under `ui/starters/` are
sandbox-JSON envelopes asserted equal to the built starter in tests —
they are the shareable artifacts, not runtime inputs. Loading replaces
the editor state and resets the send form to its shipped defaults; it
never auto-Sends — **Send stays the user's action** (PRODUCT job 3).

- **Do not call it:** *template*, *scene*, *scenario*, *preset* (a preset
  is a palette box, not a file), *profile* (engine capability data,
  [ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md)).

### Inspector

The editor for one placed device: its address fields, and one group of controls per
port. A bridging port shows **PVID (ingress)** and **Untagged VLANs (egress)** as
separate controls, because they are separate mechanisms
([ADR 0008](docs/adr/0008-pvid-is-ingress-native-vlan-is-egress.md)). One control
edits one mechanism.

- **Do not call it:** *properties panel*, *device editor*.
- **Do not label a control** "Native VLAN (PVID)" — the fused label is forbidden by
  ADR 0008.

### Untagged-only

A **capability** on a bridging function (`canTag: false`). The engine still
classifies the SSID's mapped VLAN; it cannot emit an 802.1Q tag. The far end's
PVID is where clients land. Catalogue row 20.
[ADR 0019](docs/adr/0019-untagged-only-is-a-capability.md).

- Analogous to `vlanAware: false`: preset data selects the field; the engine is
  the only executor ([ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md)).
- **Not an access uplink.** An access port that is not a member of the mapped
  VLAN drops the frame, so `mappedVlan` never stays in the pipeline.
- **Do not call it:** *access mode*, *native VLAN*, a vendor name.

### Radio

A shared transmitter on a chassis. It exists **so that several `wireless` functions can
name the same one** — an extender is an AP and a client on one radio, and guest wifi is
two SSIDs on one radio landing in different VLANs.

- **`channel` is config**, an optional positive integer, like a VLAN ID. Same-channel
  is a number the user set. They-interfere is physics the model cannot know
  ([ADR 0025](docs/adr/0025-radio-channel-is-config.md)).
- It deliberately carries **no power, channel quality or coverage fields**. Those are
  stage 4 estimates ([ADR 0006](docs/adr/0006-radio-is-an-estimate-not-a-result.md)).
- **Do not call `channel`:** *interference*, *coverage*, an RF result.
- **A shared radio does not let the tool state a throughput cost.** That needs airtime
  and PHY rate. Saying "an extender halves your speed" is an estimate wearing the
  clothes of a derived result — the exact mistake ADR 0013 records.

### Cold trace

Every trace starts with nothing resolved. There is no ARP cache, and nothing carries
between traces ([ADR 0010](docs/adr/0010-arp-is-modelled-without-a-cache.md)) — a
cache that ages is a timer, and [ADR 0003](docs/adr/0003-converged-state-no-timers.md)
forbids timers.

- So a trace that opens with an ARP exchange **every single time** is correct, not a
  bug. It would look odd on a real host mid-session, which is why the cold-cache
  precondition is user-visible rather than an implementation detail.
- **Do not add a cache** — not "just for realism", not keyed on the trace id. If
  resolution ever needs to persist, that supersedes ADR 0010 in writing first.

### Run context

One invocation of a trace or a flow. It holds the per-VLAN forwarding
tables, resolved next-hop MACs, the hop budget, and the converged STP
port map. It is created at the start of the run and discarded at the end.
Nothing in it survives to the next run ([ADR 0010](docs/adr/0010-arp-is-modelled-without-a-cache.md)).

- **Do not call it:** *session*, *simulation*, *world*, *cache*, *global state*.
- Within one run, later frames (the reply) read the tables the request built.
  That is the flow driver, not a cache.

### Hairpin

A DNAT whose frame **arrived from an internal iface** - one no default route names -
so the client reached a forwarded service through the router's public IP from the
inside. The request is DNAT'd and SNAT'd to the resolved egress iface's IP, and the
return session restores the public source on the reply; see
[ADR 0022](docs/adr/0022-masquerade-follows-the-wan-egress.md).

- **"NAT loopback" is the industry alias; use hairpin.** "Reflection" appears in
  vendor docs and means the same mechanism; neither name appears in engine code or
  trace copy.
- Sessions from a service payload carry a port tuple (ADR 0023): two simultaneous
  hairpin clients of one forwarded service each receive their own returns, and
  frames from the server to the router's own IP reach the router.
### Flow

A request and the reply it elicited, sharing one run context. Catalogue rows
9, 13 and 15 cannot be seen from one direction.

- `outcome` names which direction died (`request-failed`, `reply-failed`) or
  that both arrived (`round-trip`). It is not pass/fail — there is no verdict
  field ([ADR 0002](docs/adr/0002-trace-not-verdict.md)).
- **Do not call it:** *ping*, *session*, *verdict*, *result*.

### Walk

The dispatcher that follows links. At the far port it reads `Port.ownedBy`,
finds that function, and hands the frame to that executor. A `wireless`
function classifies at `ssid-vlan` and the walk follows `InternalEdge` onto
the chassis bridge. An unknown or
broadcast destination goes out every eligible port, so the walk is a **tree**.
`hopsLeft` is one budget across every branch, not a per-path depth limit.

- **Do not call it:** *simulate*, *flood loop*, *path finder*. A unicast can
  still be a tree once something floods.
- There is no `switch (device.kind)`. Adding a palette box selects functions;
  it does not add a branch here.

### Pipeline step

A stage of the 802.1Q (or subsequent) pipeline **within a single hop**. One pass
through a device is one hop; the hop names the step that decided it.

- **Do not call it:** *hop* (that is the whole device handling), *event*, *check*.

### Reason code

The product of a pipeline step and an outcome (`step:outcome`). Adding a code
requires adding a step or an outcome, never a scenario ([ADR 0001](docs/adr/0001-execute-the-8021q-pipeline.md),
[ADR 0017](docs/adr/0017-structure-in-engine-tests-wording-against-the-table.md)).

- **Do not call it:** *error code*, *verdict*, *diagnosis id*, *row id*.
- Engine tests read the reason code. Humans read `format`'s sentence.

### Sender

A chassis that originates a packet in a run (`send`). A host is one sender; a
router forwarding out an iface is another. It ARPs for its next hop only when
it lacks that MAC. Resolution is per-sender and lives only on the run context.

- **Do not call it:** *cache*, *session*, *host* (a host is a chassis with no
  functions; not every sender is a host).

### NAT

A function attached to a routing function (`kind: 'nat'`, `on` names that
routing function). Presence is NAT on; absence is NAT off. A newly placed
router includes it ([ADR 0005](docs/adr/0005-nat-on-by-default.md)). Masquerade
rewrites the source out the default-route iface (the selector-aware default for the
frame's VLAN - see Selector); a port-forward matches
`proto` and `outsidePort` on the way in ([ADR 0018](docs/adr/0018-services-are-reached-not-answered.md)).

- **Do not call it:** *sub-router NAT*, *firewall* (the inter-VLAN allow/deny
  list is a different function), *PAT* in user-facing copy.
- Sessions live on the run context. They do not persist between runs.

### DHCP

A pair of functions on a chassis (`dhcp-server` with `scopes`, `dhcp-relay`
with a `helper` address). DISCOVER, OFFER, REQUEST and ACK are frames with
their own hops. An OFFER's address is `poolStart` from the matching scope.
There is no lease record, lease time or expiry ([ADR 0003](docs/adr/0003-converged-state-no-timers.md)).

- **Do not call it:** *allocator*, *lease table*, *dns* (the scope field is
  `resolver`; [ADR 0018](docs/adr/0018-services-are-reached-not-answered.md)).

### Provenance

Present on a hop when a profile influenced that step. Carries the profile id,
version, and the field names that were read ([ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md)).
The built-in profile's common path does not set it; a fixture that selects a
different capability does.

- **Do not call it:** *source*, *attribution* as a field name. The field is
  `provenance`.

### Selector

The optional `Route.fromVlan` field - a route's source-VLAN match. Present, the
route belongs to the frame VLAN's selector tier: for a frame arriving on that
VLAN's sub-interface, only routes carrying its selector are consulted first, and
a selector default outranks even a more-specific destination-only route. That is
how policy routing behaves on real gear (a Linux `ip rule` source lookup
consults its own table, never the main one; Cisco PBR sets the next-hop and
bypasses the RIB). Absent - no route carries the frame VLAN's selector - lookup
is destination-only LPM exactly as before. Catalogue row 24 is the multi-WAN box
where the selector was never installed and the frame falls through to the plain
default.

- **Do not call it:** *source routing*, *PBR* (a vendor feature name), *tag*.
  "Policy routing" is the accepted prose; the field name is `fromVlan`.

### ECMP

Equal-cost multi-path: two or more routes whose prefixes tie in the tier that
decided the frame. The engine resolves the tie deterministically — the first
reachable match in `routes[]` order — and names that via on the `route-lookup`
hop (catalogue row 26,
[ADR 0021](docs/adr/0021-ecmp-is-a-named-hop-not-a-split.md)). There is no
clock ([ADR 0003](docs/adr/0003-converged-state-no-timers.md)), so no split
ratio can be a result.

- **Do not call it:** *load balancing*, a *50/50 split*, or *hashing* as a
  behaviour of this engine. Real gear may hash flows; this model names one
  next-hop, stable across runs.

### ISP handoff

A function (`kind: 'isp-handoff'`) on the provider-facing chassis. Mode is
`pppoe | dhcp | static`. `vlanTag` is the VLAN the customer WAN must carry.
PPPoE is an encapsulation layer; usable MTU is computed from the stack and
never stored.

- **Do not call it:** *modem* or *ONT* as a device kind. The ONT is a chassis
  carrying this function.

### Management VLAN

The VLAN chassis host addressing answers on (`Chassis.vlan`). The uplink
trunk carries it like any other VLAN. Missing it from the trunk dies at
`ingress-filtering` or `egress-membership`. Reaching the address is
`arp`/`delivery`. There is no management pipeline step.

- **Do not call it:** *management plane*, *CPU port*, *mgmt hop*. Those
  names imply a special execution path.

### Sandbox JSON

The versioned envelope `{format, version, topology, layout?}` that is the
format of record ([SPEC.md](docs/SPEC.md) §8 Q2,
[ADR 0015](docs/adr/0015-import-real-config-before-exporting-it.md),
[ADR 0026](docs/adr/0026-sandbox-json-encodes-sets-omits-maps.md),
[ADR 0029](docs/adr/0029-canvas-is-a-ui-view-and-editor.md)).
`toJson` / `fromJson` in the engine round-trip `topology`. VLAN Sets encode
as number arrays. FDB and STP Maps are omitted on write and empty after
parse. Unknown function kinds and unsupported versions fail by a named
error. `layout` is an optional UI sidecar; missing is valid. Version stays 1.

- **Do not call it:** *vendor config*, *export* as if it were CLI to paste,
  a `$set`-tagged blob. Canvas `x,y` is not Topology.

### Profile JSON

A separate version-1 envelope `{format:'network-sandbox-profile', version:1, profile}`
for a shareable profile *document* ([ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md)).
`toProfileJson` / `fromProfileJson` round-trip it. Sandbox JSON still stores only
`profiles: string[]` ids; the engine resolves those ids against a caller-supplied
registry before any hop. `ieee-defaults` is always registered. Empty `capabilities`
is the day-one schema; an unknown capability key fails by name.

- **Do not call it:** *sandbox JSON*, *vendor config*, embed the body in the
  sandbox envelope. Do not silently default an unknown id to `ieee-defaults`.

### Canvas

The vanilla-SVG view of the topology that is both the **builder** (drop,
port-click link, drag) and the **hop-replay** surface
([ADR 0029](docs/adr/0029-canvas-is-a-ui-view-and-editor.md)). It is a UI of
the file, not a second network. The shipped forms editor (#58) stays. The
canvas is not shipped as of ADR 0029.

- **Do not call it:** *screenshot-as-network*, *the network*, a *simulator
  clock*. Drawing boxes does not make coordinates Topology.

### Layout

The optional sandbox-envelope sibling `layout`, keyed by device id to
`{x,y}` ([ADR 0029](docs/adr/0029-canvas-is-a-ui-view-and-editor.md)). Missing
is valid — the later UI auto-places. Never a field on `Topology` or
`Chassis`. Version stays 1.

- **Do not call it:** *localStorage map*, *coordinates on Topology*,
  *screenshot*. A tab-only map cannot round-trip with the file.

### Hop replay

Playing the completed `Hop[]` from a send on the canvas. It consumes hops
the walk already produced. It is not a clock
([ADR 0003](docs/adr/0003-converged-state-no-timers.md)) and not a verdict
([ADR 0002](docs/adr/0002-trace-not-verdict.md)). Flood multiplying-tokens
is a later issue.

- **Do not call it:** *timer*, *timed simulation*, *verdict*, *pass/fail
  overlay*.

### Service

A `Frame.payload.kind`. It carries `proto` and `dstPort` so a port-forward and a
reachability query are comparable. Arrival is modelled; application replies
are not ([ADR 0018](docs/adr/0018-services-are-reached-not-answered.md)).

- **Do not call it:** *dns*, *application*, *session*.
- A query that asks a name is a `service` payload with `dstPort: 53` plus a
  `name` format fact — no second payload kind. The resolver table answers
  only after the query is delivered
  ([ADR 0030](docs/adr/0030-the-table-answers-after-arrival.md)).

### Resolver

Two fields, one word ([ADR 0030](docs/adr/0030-the-table-answers-after-arrival.md)):
the **function** (`kind: 'resolver'`) whose `records` are a flat
`name -> IP` table, and the **advertised address** — `Chassis.resolver`,
and the same word on the DHCP scope. The address is an IP, not an engine:
send-by-name walks udp/53 to the chassis it names. There is no zone file,
recursion, or NXDOMAIN engine. The UI label is "DNS server"; the word
`dns` stays out of `src/` identifiers and filenames.

- **Do not call it:** *dns*, *DNS server* in code, a *zone*.
- **Placement is topology.** The same function on a LAN box or beyond the
  WAN; a router may carry it. There is no second "public" kind.

### Hosted UI

The GitHub Pages copy of `ui/dist` at
https://alanfong93.github.io/network-sandbox/ ([ADR 0032](docs/adr/0032-host-the-static-ui-on-github-pages.md)).
Static files only. The source of that copy is this repository.

- **Do not call it:** *the server*, *SaaS*, *the backend*.
- Sharing a downloaded topology is still [#65](https://github.com/alanfong93/network-sandbox/issues/65).

### AI config file

The version-1 envelope `{format:'network-sandbox-ai', version:1, endpoint,
model, key}` a user keeps **beside** their sandbox JSON
([ADR 0033](docs/adr/0033-ai-advice-sits-beside-the-engine.md)). It loads and
saves like sandbox JSON but is never merged into it: `exportSandbox` has no
key field, and Unload drops the key from the tab. A blank file is a valid
template (empty strings parse; use fails by name).

- **Do not call it:** *AI settings in the sandbox file*, *the key file* as
  if topology export could carry it. Two files, two formats, one rule:
  sandbox JSON is topology; the AI file is credentials.

### Advice

The AI panel's output: prose beside the trace, labelled "AI advice — not a
trace" ([ADR 0033](docs/adr/0033-ai-advice-sits-beside-the-engine.md)).
It cannot mutate the topology (no write path exists), it is not produced by
`format()`, and it never renders in the hop list's visual language
(ADR 0002). Follow-up chat is frozen to the reviewed snapshot; a topology
edit blocks chat until Review runs again.

- **Do not call it:** *trace*, *verdict*, *report*, *diagnosis*, a *hop*.
  Those words belong to the engine's outputs.
