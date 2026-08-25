# 0015. Read real device config; do not generate it

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

`SPEC.md` §7 listed "importing a real device config" as out of scope for v1. The owner
asked to reverse that: *"I think we should make the real config file able to import and
export with this system."*

It is a good idea and it changes what the tool is. Today it is a place to build a
topology by hand. With config import it becomes a place to understand **the network you
already have** — which is much closer to the stated job of testing a change before
touching real gear.

But import and export are not the same risk, and treating them as one feature is the
mistake to avoid.

## Decision

**Reading real config is in scope. Generating real config is not.**

- **Import** — read a device's configuration and build the topology from it.
- **Export** — the sandbox's own JSON format only. **Not** vendor config a user pastes
  into a live switch.

Both are **profile-shaped**. A config grammar is data, not engine code, so under
[ADR 0012](0012-profiles-are-data-the-engine-is-the-only-executor.md) a profile author
supplies the grammar and the mapping. The maintainer does not write a parser per
vendor.

## Why the asymmetry

**Import is reading.** If it misreads a config, the user sees a topology that does not
match the network they know. They notice, immediately and by themselves. The error is
self-announcing.

**Export is writing.** The tool hands a user commands to paste into production
equipment. If those are subtly wrong, the tool causes the exact outage it exists to
prevent.

This is the worst false-trust surface in the whole project — worse than a wrong trace.
A wrong trace can be argued with, because the reasoning is on screen and
[ADR 0002](0002-trace-not-verdict.md) forces it to be. Generated config is just pasted.

It also runs straight into [ADR 0009](0009-browser-only-not-a-real-dataplane.md).
Browser-only was chosen precisely because the sandbox should be faithful to the
standard rather than to any vendor. Generating vendor syntax means claiming to know
that vendor's syntax *and* its defaults — the claim ADR 0009 declined to make.

## Alternatives rejected

- **Keep both out of scope for v1** (the status quo). Rejected: import is genuinely
  valuable, is much safer than export, and fits the profile mechanism already decided.
- **Ship both together.** The natural reading of the request, and rejected on the
  asymmetry above. Symmetry is aesthetically appealing and would be the expensive kind
  of wrong.
- **Export with a warning banner.** Rejected on the same grounds as
  [ADR 0011](0011-single-instance-stp-owes-a-warning.md)'s warning-fatigue finding: a
  banner does not survive contact with someone in a hurry, and here the failure mode is
  a production outage rather than a confusing trace.

## Consequences

- The sandbox's own JSON export stays, and stays the format of record.
- Config **import** needs a grammar per vendor, supplied as profile data. This becomes
  one of the strongest reasons for the profile system to exist.
- An imported topology is **profile-influenced output** and inherits ADR 0012's
  provenance rule: the trace must show which parts came from a third party's grammar,
  not from the standard.
- Export of vendor config is not refused forever. It is refused **until there is a way
  to make it safe** — which likely means verified profiles, a diff against the device's
  current config, and something considerably stronger than a warning. Reopening this
  means superseding this ADR, not quietly adding a button.
