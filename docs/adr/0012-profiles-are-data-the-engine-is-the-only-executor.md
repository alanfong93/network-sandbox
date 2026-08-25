# 0012. Profiles are data; the engine is the only executor

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 3-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted), plus the owner's scoping call

## Context

[ADR 0009](0009-browser-only-not-a-real-dataplane.md) justified browser-only on the
promise that a simulator can offer vendor profiles later while a real Linux kernel
never can. This ADR is that promise made concrete, and it is stronger than 0009
assumed: profiles are **user-authored, shareable data**, not content the author ships.

The owner's direction: *"once I set up the engine, users can build on the engine. It's
not when user want to have a new value or something, I need to rebuild the engine."*
Plus a scoping call: **get the basics of networking working first; vendor-proprietary
behaviour is a later phase.**

The driver is concrete. Malaysian ISP TM unifi uses VLAN 500 for internet, 600 for
IPTV, 400 for VoIP, over PPPoE. Under this decision those numbers never appear in the
codebase — someone writes a "TM unifi" profile.

## What actually differs between vendors

Checked, because it decides how large the engine backlog really is:

| Kind | Example | Cost |
|---|---|---|
| **Defaults** | Cisco: native VLAN 1, Rapid PVST+ on | a value in a profile |
| **Vocabulary** | Cisco "access/trunk/native"; Aruba "untagged/tagged"; MikroTik "PVID" | a label in a profile |
| **Proprietary protocol** | PVST+/Rapid PVST+, DTP, VTP | engine code |

The forwarding behaviour itself is overwhelmingly standard — 802.1Q, 802.1D/w/s, ARP,
DHCP, PPPoE — and every vendor implements it. The genuinely proprietary list is short
and is almost entirely Cisco's.

## Decision

**A profile is declarative data. It may:**

1. **Set values** — VLAN IDs, PVID defaults, encapsulation overheads, address ranges,
   whether the native VLAN is tagged by default.
2. **Select among named capabilities the engine already implements.**

**It may never define behaviour.** No rules, no predicates, no scripting, no new
pipeline stages. The engine remains the only executor.

Three supporting decisions:

- **The engine's own defaults are themselves a built-in profile.** There is no
  privileged, hidden "no profile" state, and the profile path is exercised from day
  one rather than bolted on later.
- **Provenance lives in the trace data model, not in the styling.** Every step records
  which inputs came from a profile, and which profile, at which version.
- **The mechanism is in v1; the content is not.** Schema, loader, versioning and
  provenance ship in v1. A profile editor, a public directory, signing and curation do
  not, and neither does any vendor profile written by the author.

Because no alternative behaviours exist yet, capability-selection is an **empty
section in the schema on day one**. It costs nothing now and avoids a format change
later.

## Alternatives rejected

- **Values only.** Identical to this decision in v1, since there is nothing to select
  between yet. Rejected only as a *format* choice: leaving the capability section out
  means changing the schema the first time a vendor behaviour is built, and breaking
  every profile written before then.
- **Profiles may define new rules (a small scripting language).** The flexible option,
  and it would deliver the owner's goal most completely. Rejected unanimously: it is
  precisely the hand-authored rulebook [ADR 0001](0001-execute-the-8021q-pipeline.md)
  forbids, only now the rulebook belongs to a stranger while wearing the tool's
  authority. GPT's framing: a finite, versioned capability registry keeps the engine
  as the sole executor.
- **Deferring the whole mechanism to a later phase**, per `SPEC.md` §7. Rejected
  because provenance is the one-way door: colours can change later, but adding "where
  did this come from" to every trace step, export and renderer after they exist is a
  rewrite. Zero code exists today, which makes this the cheapest possible moment.

## Consequences

- **The owner still writes engine code for new *behaviours* — just not for new values,
  places or ISPs.** All three seats raised this as the counter-case. It is accepted,
  and it is not a defect: setting up the engine is the work. A new country costs
  nothing; a new protocol costs a build.
- **When multi-instance spanning tree is built, build MSTP (IEEE 802.1s) first**, not
  Cisco's PVST+. MSTP is the standard and is correct for everyone; Rapid PVST+ then
  becomes a variant on top. This is the eventual real fix for
  [ADR 0011](0011-single-instance-stp-owes-a-warning.md).
- **Profile-influenced output is a third category** alongside derived and estimate
  ([ADR 0006](0006-radio-is-an-estimate-not-a-result.md)), marked per step rather than
  by a page banner, carrying profile name, version and source. A wrong profile
  downloaded from a stranger must never inherit the standard's authority.
- **The schema carries a version from day one.** Community config formats break on
  schema drift — cited examples were Grafana dashboards and Terraform provider
  pinning — and retrofitting versioning is worse than shipping it.
- **Still unverified, and worth settling before the schema hardens:** take ~20 real
  documented ISP/device configurations from different countries and classify every
  setting as a value, an existing capability selection, or a capability that would
  need building. If most land in the third column, this decision delivers much less
  than it promises and should be revisited. GPT proposed the test; TM unifi is one of
  the twenty.
