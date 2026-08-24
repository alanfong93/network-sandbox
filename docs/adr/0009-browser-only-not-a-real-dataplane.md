# 0009. Browser-only simulator, not a real Linux dataplane

- **Status:** Accepted
- **Date:** 2026-08-24 (decided), 2026-08-25 (recorded here)
- **Source:** `Idea - Game & Sandbox Concepts.md` §"REFRAMED 24 Aug 2026" (Obsidian vault)

## Context

On 24 Aug 2026 a 3-model council reviewed this project's scope and ruled **3/3
against a browser-based simulator**. Their finding was serious and specific: a
hand-written config-level state machine cannot carry a fidelity guarantee, STP in
particular "forces a real forwarding plane," and the recommendation was a **hybrid** —
a real dataplane on Linux network namespaces and bridges, with the browser as UI
only, generating and applying real config.

They also produced a falsification test: two switches, two parallel trunks, VLAN 10
and VLAN 20, STP enabled. If the sandbox cannot reproduce **per-VLAN blocking**, the
claim fails for a large class of real networks.

That recommendation was overruled the same day, and this ADR exists because the
reasoning lived only in the vault. A repo that shows the rejected architecture and
not the rejection invites the question to be reopened by anyone arriving cold.

## Decision

**Browser-only. The browser is both the UI and the sandbox.** No server, no install,
no real kernel dataplane.

The overrule came from a question about the users, not the technology: *"So what if
the user doesn't use OpenWRT, but a different router/firewall?"* If users span Cisco,
MikroTik, UniFi, pfSense and OpenWRT, then the thing to be faithful to is **IEEE
802.1Q / 802.1D — the standard** — not any one implementation.

The decisive asymmetry: **a simulator can model the standard and later add vendor
profiles ("Cisco defaults", "MikroTik defaults") that change the quirks. A real Linux
kernel can never pretend to be Cisco.** Building on the kernel would make the tool
precise about Linux, which is fidelity to the wrong thing.

## Alternatives rejected

- **The hybrid: real Linux netns/bridge dataplane, browser as UI only.** Recommended
  3/3, and it wins outright on raw fidelity — real MAC learning, real BPDUs, real
  frames. Rejected because its fidelity is to Linux. It also costs a server, which
  costs uptime, per-user contention, hosting spend, and something to self-host —
  against a distribution model of open source plus one hosted demo, where a static
  page has none of those.
- **Keeping the strong claim** ("whatever works here works in the real world") on top
  of a simulator. Rejected as dishonest under every architecture reviewed.

## Consequences

- **The claim was knowingly weakened**, and that trade is the price of this decision:
  *"If your design works here, the design is sound — you still translate it to your
  box's syntax and check its defaults."* It still catches what causes most real
  outages: untagged trunk, DHCP on the wrong VLAN, native VLAN mismatch, double NAT.
- **The falsification test is not passed; it is declined.** v1 is single-instance STP,
  so the two-trunk two-VLAN case gives an answer that differs from Cisco's default.
  That is a real limitation with a real user cost, handled in
  [ADR 0011](0011-single-instance-stp-owes-a-warning.md) rather than waved away.
- Bought in exchange: no server means no downtime; per-tab isolation means no
  multi-user contention and no per-user cost; static hosting is free.
- Vendor profiles become a credible later layer. They would be impossible under the
  hybrid, which is the whole point.
- If the claim ever needs to be stronger than the standard can support, this ADR is
  what must be superseded — not quietly patched.
