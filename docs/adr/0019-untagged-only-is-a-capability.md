# 0019. Untagged-only is a capability, not an access uplink

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** GitHub issue #31 (catalogue row 20)

## Context

Consumer mesh in AP mode cannot tag (`SPEC.md` §9). Catalogue row 20 is that
mistake: guest SSID maps to VLAN 30, the node emits untagged, the far end's
PVID is 10, clients land in VLAN 10. The formatter already has the sentence;
the engine has to keep `mappedVlan` 30 in the pipeline so the observation can
name both VLANs.

## Decision

**The engine implements `canTag` on the bridging function.** `false` means
egress is always untagged. Membership and SSID classification still use the
mapped VLAN. A preset writes the field (ADR 0012). There is no vendor
`if`.

The walk derives `ssid-untagged` from those facts: the previous device
classified at `ssid-vlan`, the frame arrived untagged, the far end's PVID
differs. It does not hand-author a verdict (ADR 0001).

## Alternatives rejected

- **An access uplink on VLAN 10.** The obvious port config. Rejected because
  VLAN 30 is then not a member, so the frame drops at `egress-membership` and
  `mappedVlan` 30 never reaches the formatter. Row 20 could not say the SSID
  mapped to 30.
- **Native VLAN 30 on a trunk (`untaggedVlans` contains 30).** Standard 802.1Q
  egress-untagged, available to any tagged-capable AP. Rejected because it is
  a port setting, not "this node cannot tag". The lesson is the capability.
- **A topology-wide profile flag.** Rejected because the reference scenario
  puts a tagged AP and an untagged-only mesh in one topology. The field is
  per bridging function, like `vlanAware`.
