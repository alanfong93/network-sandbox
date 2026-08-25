# 0013. A device is a chassis plus functions; the palette shows boxes

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 3-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted), then checked against a real OpenWrt configuration

## Context

The owner's product intent: *"I want this project to be able to let users create and
custom their own scenarios be it home or enterprise environment and test their
settings like LEGO blocks."* He described real boxes by what they contain — a combo
box that is modem, router, switch and wifi at once; a router whose wifi may or may not
be used; separate APs, mesh, extenders.

The model could not express that. It had fixed whole-box types (`ManagedSwitch`,
`Router`, `Host`) and no type at all for access points or L3 switches. Fixed types
force a combinatorial explosion: router, router+wifi, router+switch+wifi,
modem+router+switch+wifi, each duplicating behaviour that must then be kept in sync —
the exact objection [ADR 0004](0004-one-router-type-at-any-depth.md) raised against a
second router type.

## Decision

**A device is a chassis — an id, ports, and radios — plus a set of functions** drawn
from a fixed list the engine implements. Every real box is a combination.

**The palette shows boxes, not functions.** All three seats independently insisted on
this: the user drags "Home router with WiFi", not a set of checkboxes. Composition
lives underneath. A canvas of function toggles has no good answer to *"what do I drag
on?"*

**A device preset is a profile.** Under [ADR 0012](0012-profiles-are-data-the-engine-is-the-only-executor.md)
a profile selects among capabilities the engine implements — which is exactly what a
preset is. The device palette and the profile system are one mechanism, so "build like
LEGO" and "customise without rebuilding the engine" are the same feature, not two.

**Intra-device wiring is an explicit graph in the data model, generated from the
preset.** It is hidden by default, inspectable on demand, and **not user-rewirable**.
The trace always addresses internal hops. A frame that dies inside a combo box must
say where — a hidden internal pipeline puts a black hole in precisely the device most
likely to confuse someone, which is the false-trust failure this project exists to
prevent. Free-form internal rewiring is a separate one-way door and is not taken.

**Wireless links exist in the model now, carrying no RF semantics.** Mesh and
extenders ship as config-only blocks: they carry VLANs and can be misconfigured, and
the link is labelled as an assumption ("wireless link assumed available"), never as a
coverage or throughput claim. Deferring the link type until the radio stage would bake
wired-only assumptions into topology, persistence and the trace schema.

## The check, and what it found

Two seats independently proposed the same test before building: **express a real
OpenWrt home-router configuration in the function list, and see whether anything fails
to map.** It was run. Four things failed to map.

1. **There was no radio.** OpenWrt separates `wifi-device` (the radio — channel, band,
   power) from `wifi-iface` (SSID, mode, network), and one radio hosts several
   interfaces ([OpenWrt wireless configuration](https://openwrt.org/docs/guide-user/network/wifi/basic)).
   The proposed list had flat `wireless-ap` and `wireless-client` functions with
   nothing to attach them to. That makes "AP and client **on the same radio**"
   inexpressible — and worse, it makes **several SSIDs on one radio mapped to
   different VLANs** inexpressible, which is the guest-wifi-leak failure the README
   already promises. **A radio is now a first-class part of the chassis**, and
   wireless functions attach to a radio rather than to the device.
2. **Mesh is a third mode, not a variant of two.** `wifi-iface mode` takes `ap`, `sta`,
   `mesh`, `adhoc`, `monitor`. The wireless function's mode is now
   `ap | client | mesh`.
3. **VLAN tagging is not always inside a bridge.** OpenWrt expresses a tagged
   sub-interface on a routed port as an L3 device name (`eth0.1`) — no bridge
   involved. The function list had put VLANs inside bridging. This is exactly the TM
   unifi WAN case (tagged VLAN 500 on a routed uplink), so it is not an edge case.
4. **Routes have no source dimension.** `routes` is `{dest, prefix, via}`, which cannot
   express per-VLAN policy routing — the first item of the multi-WAN stage. Routes
   gain an optional source selector.

## Alternatives rejected

- **Keep fixed whole-box device types.** Simpler engine, no internal wiring problem,
  and a device cannot be misassembled. Rejected: the roadmap is already a
  combinatorial box list, and every combination would become a duplicate type. The
  UX argument for fixed types is real, and it is answered by presets rather than by
  the model.
- **Expose raw function composition in the UI.** The purest reading of "LEGO blocks".
  Rejected unanimously — users think in boxes, and a function palette makes the
  simple case harder for no gain.
- **Hidden canonical internal wiring** (no inspection). Cheapest. Rejected: it blinds
  the trace inside combo devices.
- **User-rewirable device internals.** Powerful and genuinely interesting. Rejected
  for now as a one-way door that commits the product to supporting physically
  meaningless constructions.
- **Defer mesh and extenders to the radio stage.** Rejected: the config half is
  standards-answerable now, and adding the wireless link type later would be a
  breaking model change rather than an addition.

## Consequences

- **Correction on the record: an extender halving throughput does NOT fall out of the
  model.** That claim was made in proposing this design and two seats rejected it.
  Real throughput loss depends on airtime, PHY rate, channel reuse and traffic
  direction — a radio **estimate**. Presenting it as a derived outcome would breach
  [ADR 0006](0006-radio-is-an-estimate-not-a-result.md). The tool may show an
  extender's VLAN and bridging behaviour; it may not tell anyone their speed.
- The internal forwarding graph must exist in the trace data model from day one.
  Styling is reversible; the model is not.
- Validation is a new cost the fixed-type model did not have: some function
  combinations are meaningless and the tool must say so clearly rather than produce a
  confusing trace.
- `Host` becomes a chassis with no functions, which is consistent rather than special.
- The function list is now: `vlan-blind-bridging`, `vlan-aware-bridging`, `stp`,
  `routing`, `nat`, `dhcp-server`, `dhcp-relay`, `wireless` (on a radio, mode
  ap/client/mesh), `isp-handoff` (mode pppoe/dhcp/static, optional VLAN tag).
- **The check is repeatable and should be re-run** whenever the function list changes:
  take a real device configuration and map every setting onto it. It found four
  defects the first time, two of which blocked already-promised behaviour.
