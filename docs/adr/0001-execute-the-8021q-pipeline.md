# 0001. Execute the 802.1Q pipeline, not a rulebook of error conditions

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `docs/SPEC.md` §1

## Context

A network simulator's credibility problem is that it encodes *the author's beliefs*
about networking. If the engine is a list of hand-written checks — `if trunk &&
!tagged then error` — then every diagnosis it produces is an assertion by whoever
wrote that line, and a user has no way to tell a real standards-derived outcome
from a plausible-looking guess. For a tool whose whole purpose is *"test the change
before you make it on real gear"*, that is fatal: a confident wrong answer is worse
than no tool.

## Decision

The engine executes the **IEEE 802.1Q ingress → forward → egress pipeline** and lets
outcomes fall out of it:

1. **Ingress** — acceptable frame types → assign PVID if untagged → ingress filtering
   (is this port a member of this VLAN?)
2. **Forward** — learn source MAC into the per-VLAN FDB → look up destination →
   forward to one port, or flood to VLAN member ports
3. **Egress** — untagged member: strip tag; tagged member: send tagged; not a
   member: drop

Drops are not authored. They are what happens when a frame fails a step of the
pipeline. The failure catalogue in `docs/SPEC.md` §4 is therefore a list of
*expectations to verify*, not a list of rules to implement.

## Alternatives rejected

- **A rulebook of hand-authored error conditions.** Faster to start, and it would
  cover the first dozen cases in the catalogue. Rejected because it inverts the
  guarantee: every diagnosis becomes an opinion, the rules drift out of agreement
  with each other as they accumulate, and cases nobody thought of produce silence
  rather than a correct answer. It also cannot be defended — there is no document
  to check it against.
- **Embedding a real switching stack / vendor emulation.** Maximum fidelity, but it
  would tie the project to specific vendor behaviour, which is explicitly what the
  README promises *not* to claim, and it cannot run in a browser with no install.

## Consequences

- The pipeline is finite, published and vendor-neutral, so its output is what the
  standard says happens — checkable by a third party against 802.1Q.
- **A missing diagnosis is an engine bug, not a missing rule.** If a catalogue row
  produces the wrong trace, the fix is in the pipeline, not a new special case.
  Adding an `if` that isn't in the standard is how this project loses its only
  real claim.
- The cost is paid up front: the full pipeline must work before *any* failure case
  is correct. There is no useful half-built version.
- Vendor-specific syntax, defaults and edge cases are out of scope by construction
  — the sandbox is faithful to the standard, not to any one box.
