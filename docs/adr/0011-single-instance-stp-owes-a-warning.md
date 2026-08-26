# 0011. Single-instance STP stays in v1, and it owes the user a warning

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 3-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted)

## Context

`SPEC.md` §5 scopes v1 to a single spanning-tree instance and says so plainly. As
*scope*, that is honest. The problem is what it does to a specific, ordinary topology.

Build two switches with two parallel trunks carrying VLAN 10 and VLAN 20, turn STP
on, and the sandbox blocks one trunk for both VLANs. A user reads that as "my
redundant link is wasted." On Cisco Catalyst gear it would not have been — both
trunks would carry traffic, one VLAN each.

**This is not an exotic case.** Cisco Catalyst devices **default** to Rapid PVST+,
which runs a separate spanning-tree instance per VLAN
([Cisco, *Configuring Spanning Tree Protocol*, Catalyst 9200](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-10/configuration_guide/lyr2/b_1610_lyr2_9200_cg/configuring_spanning___tree_protocol.html)).
For that user the sandbox is not missing an edge case — it is backwards from the
default they will meet. The base IEEE 802.1D standard does define one instance for
the whole network, so the sandbox is faithful to the standard and Cisco's default
deviates from it. That is precisely the kind of vendor difference where real outages
live.

Note the asymmetry this exposes in the spec's own text: for the no-timers limit §5
says *"This limit belongs in the UI, not just in this file."* For per-VLAN STP it
said only "not modelled" — no obligation attached. Same class of limitation, half the
honesty.

## Decision

**v1 stays single-instance.** PVST+/MSTP is not modelled.

Three obligations attach, and they are requirements rather than nice-to-haves:

1. **A visible limitation notice**, of the same standing as the no-timers notice.
2. **A contextual warning**, fired by detecting the shape rather than by a general
   disclaimer: any two **direct** links between the same pair of STP bridges that
   share two or more VLANs. A third link that does not share those VLANs must not
   suppress it. Paths that meet only through a chassis with no `stp` function are
   one shared LAN (one segment), not parallel trunks, and do not fire this warning.
   It appears on the affected trace, at the moment the user would otherwise draw
   the wrong conclusion.
3. **A failure catalogue row** (row 19), so the divergence is a first-class,
   reproducible, traceable case rather than a footnote.

## Alternatives rejected

- **(a) Nothing — it is declared in the spec.** Rejected unanimously. A spec line
  does not reach the user holding a wrong forwarding picture, and the picture carries
  the same visual confidence as every correct answer the tool gives.
- **(e) Model PVST+ after all.** It is the only option that removes the ambiguity
  rather than labelling it, and the Contrarian case for it is strong. Rejected
  because per-VLAN STP turns port state into a VLAN × port matrix and changes
  convergence, UI and the whole test surface — a one-way door, and a reversal of
  settled v1 scope. It also needs an explicit vendor/control-plane model, which is
  the vendor-profile layer this project has deliberately deferred.
- **A general disclaimer alone.** Rejected in favour of contextual detection: a
  standing notice is read once and then never again, while the warning that matters
  is the one attached to the trace that is actually wrong.

## Consequences

- **Accepted risk, raised by all three seats and overridden by all three: warning
  fatigue.** Users habituate to disclaimers and click past them, and a warning still
  leaves a possibly-wrong forwarding result on screen. Contextual firing is the
  mitigation — it stays rare because the shape is specific — but it is a mitigation,
  not a fix. If the warning ever becomes routine, that is the signal this decision
  needs revisiting.
- This is the template for every future vendor-quirk divergence: **detect the shape,
  warn on the affected trace**, rather than either modelling every vendor or issuing
  blanket disclaimers.
- It creates a clean path to a PVST+ mode later without pretending v1 has one.
- Still uncollected, and worth having before the warning text is finalised: a real
  two-switch/two-trunk capture showing VLAN 10 and VLAN 20 selecting different
  forwarding trunks under Rapid PVST+, so the warning describes observed behaviour
  rather than inferred behaviour. All three seats independently asked for this.
