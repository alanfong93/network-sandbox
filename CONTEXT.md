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

### Failure catalogue

The numbered table in `docs/SPEC.md` §4. Each row is a reproducible mistake plus the
exact wording the trace should produce. Refer to entries as **catalogue row N**, and
keep the numbering stable — rows are referenced from ADRs and tests.

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

### Radio

A shared transmitter on a chassis. It exists **so that several `wireless` functions can
name the same one** — an extender is an AP and a client on one radio, and guest wifi is
two SSIDs on one radio landing in different VLANs.

- It deliberately carries **no power, channel quality or coverage fields**. Those are
  stage 4 estimates ([ADR 0006](docs/adr/0006-radio-is-an-estimate-not-a-result.md)).
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

### Service

A `Frame.payload.kind`. It carries `proto` and `dstPort` so a port-forward and a
reachability query are comparable. Arrival is modelled; application replies
are not ([ADR 0018](docs/adr/0018-services-are-reached-not-answered.md)).

- **Do not call it:** *dns*, *application*, *session*.
- The DHCP scope field that holds the advertised resolver address is
  `resolver`, not `dns`. Nothing in the codebase resolves a name.
