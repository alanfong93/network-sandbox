# 0007. The non-VLAN-aware switch is `unmanaged-switch`, and the name claims only a capability

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 4-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted)

## Context

One concept had two names, both already committed. `README.md` wrote
`Unmanaged ("dumb") switch`; `docs/SPEC.md` declared `kind: 'dumb-switch'`. The
original voice note that seeded the device palette said "unmanaged/'dumb' switch",
so both were the author's words and neither had been chosen.

The device exists in the product for exactly one purpose: to let a user make the
mistake of expecting per-port VLANs on a switch that has no VLAN awareness at all.

## Decision

**`unmanaged-switch`** is the type identifier and the UI label. "Dumb" survives only
in prose where the tone is doing work.

Second, and less obvious — **the name states a capability and claims nothing more**:
*no configurable per-port VLAN membership*. That definition is now written into
`docs/SPEC.md` §3 alongside the device note.

## Alternatives rejected

- **`dumb-switch` as the `kind`.** More vivid, shorter, already in the spec, and it
  names what the resulting failure feels like. Rejected on three independent grounds
  the Council converged on: it is asymmetric against the already-settled
  `managed-switch`; "unmanaged switch" is the actual vendor and retail product
  category, so it is the term a user will meet when buying one or searching for why
  theirs will not do VLANs; and this repo is public portfolio evidence, where the
  trade term reads as competence and the slang does not.
- **Leaving both in play, each in its own register.** This is the status quo, and it
  is what produced the collision. A type identifier and a README must agree.

## Consequences

- `kind: 'dumb-switch'` → `kind: 'unmanaged-switch'`; the interface renames from
  `DumbSwitch` to `UnmanagedSwitch`; failure catalogue rows 5 and 6 relabel. Row
  numbering is unchanged — rows are referenced from tests and other ADRs.
- **Accepted risk, raised independently by two seats: "unmanaged" is a
  management-plane word being used to imply data-plane behaviour.** Real unmanaged
  hardware varies in how it treats tagged frames — pass-the-tag-intact is the common
  case, not a guarantee, and some cheap silicon strips or drops them. The sandbox
  models the common case. The UI must not let the name read as a promise about the
  box on the user's desk. This is the honesty boundary of ADR 0006, one tier down.
- Because the capability definition is now pinned, a future device that *does* have
  some VLAN config is a different `kind`, not a flag on this one.
