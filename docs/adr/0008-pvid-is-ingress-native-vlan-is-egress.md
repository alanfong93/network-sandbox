# 0008. PVID is ingress, native VLAN is egress, and no single control may edit both

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 4-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted)

## Context

This started as a naming question — "one field, `Port.pvid`, carries two vendor-facing
names: the port's VLAN on an access port, the native VLAN on a trunk" — and the
proposed fix was mode-dependent UI labels: "VLAN" on access, "Native VLAN (PVID)" on
a trunk.

**The premise was false, and the check that caught it is the finding.** PVID and
native VLAN are not two names for one thing. They are two mechanisms:

- **PVID is an ingress setting** — the VLAN an accepted untagged frame *enters*.
- **Native VLAN is an egress setting** — the one VLAN a trunk *sends* untagged.

They coincide by default and are separable. Cisco's global `vlan dot1q tag native`
separates them: trunk egress becomes fully tagged, and untagged frames arriving on
the trunk are **dropped** rather than classified into the native VLAN.

Sources: ["the native VLAN is an egress setting, while the PVID is an ingress
setting"](https://lkml.iu.edu/hypermail/linux/kernel/2010.3/10935.html) (Linux kernel
mscc/ocelot patch discussion); [Cisco, *Configuring Access and Trunk
Interfaces*](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5000/sw/layer2/503_n2_1/503_n2_1nw/Cisco_n5k_layer2_config_gd_rel_503_N2_1_chapter6.html);
[Pierky, *Remember the "vlan dot1q tag native" command: untagged ingress frames are
dropped!*](https://blog.pierky.com/remember-the-vlan-dot1q-tag-native-command-untagged-ingress-frames-are-dropped/).

The data model was already right — `pvid`, `taggedVlans`, `untaggedVlans` and
`acceptableFrameTypes` express all of this. Only the **code comment** conflated them,
and the comment was about to be promoted into a UI label.

## Decision

Three parts.

1. **`pvid` keeps its name and means ingress only.** Its definition is now: *the VLAN
   an accepted untagged frame enters*. It is the 802.1Q term, on access ports and
   trunks alike.
2. **"Native VLAN" is derived for display, never stored.** It is the single entry in
   `untaggedVlans` on a trunk. **No UI control may write to `pvid` and
   `untaggedVlans` at once** — one control edits one mechanism. The proposed
   "Native VLAN (PVID)" label is forbidden by this.
3. **v1 models the decoupled case.** A trunk with `untaggedVlans` empty and
   `acceptableFrameTypes: 'tagged-only'` — everything tagged out, untagged dropped
   on the way in — is representable and traced. Added as catalogue row 18.

## Alternatives rejected

- **A single fused "Native VLAN (PVID)" control, split only behind an advanced
  toggle.** The friendliest option, and the one seat that argued for it made the
  adoption case: users arrive expecting the Cisco-shaped single knob. Rejected
  because a fused control must write to two independent mechanisms from one box —
  it would teach the exact conflation the tool exists to expose, and ADR 0002
  already settled that this project does not trade trust for friendliness. That
  seat's own First-Principles lens made the same objection and its override did not
  answer it.
- **Renaming the field to `ingressUntaggedVlan`.** Unambiguous, and it would make
  the direction impossible to miss. Rejected because `pvid` is the standards term
  the user will meet in every manual and MIB; inventing a clearer private name puts
  a translation layer between the model and the documents users must eventually
  read. The clarity belongs in the definition and the UI copy, not in a new word.
- **Deferring the decoupled case as vendor-specific edge behaviour.** Tempting,
  since vendor syntax is explicitly out of scope for v1. Rejected unanimously: the
  fields already exist, so support costs nothing, and omitting it would not make the
  case unrepresentable — it would make the sandbox produce a **confidently wrong
  trace** for a real configuration. That is the false-trust failure this project
  exists to prevent.

## Consequences

- The trunk port editor has separate ingress and egress sections. This is more UI
  than a fused control, and that cost is accepted deliberately.
- Catalogue row 2 is restated in mechanism terms — *trunk's egress-untagged VLAN ≠
  far end's ingress PVID* — which is what the failure actually is.
- Row 18 is appended, not inserted. Row numbers are stable.
- A trunk can carry a `pvid` and have no native VLAN at all. Any UI that assumes a
  trunk always has a native VLAN is wrong.
- **Where this decision came from is itself the lesson.** Both the original question
  and its proposed answer inherited a conflation that no amount of model consensus
  would have caught, because every seat was handed the same bad premise. It was
  caught by checking the premise against the standard and vendor documentation
  before ruling.
