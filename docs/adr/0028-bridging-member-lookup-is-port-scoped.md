# 0028. Bridging-member lookup is port-scoped across every bridging function

- **Status:** Accepted
- **Date:** 2026-09-05
- **Source:** issue #89 (from the #87 review's adversarial pass); semantics decided by a 2-seat tribunal (DeepSeek v4-pro + GPT-5.6, unanimous), Alan AFK-delegated

## Context

`ui/state.ts` resolved a port's bridging member through the FIRST
bridging function only (`functions.find`, port-blind). Two consequences,
both derived by the #87 review and unreachable by any palette preset:

1. `renderPortControls`' multi-bridge SVI predicate was dead code: it
   scanned every bridging function, but only ran when the port was a
   member of the first bridge - where the single-bridge shape was
   already true.
2. An access port living only in a SECOND bridging function rendered no
   port controls at all, and every port-editing action (`setPvid`,
   `setUntaggedVlans`, `setTaggedVlans`, `setPortMode`, the
   acceptable-frame-types and ingress-filtering setters - all resolve
   members through the same lookup) silently no-opped on it.

No palette preset carries more than one bridging function, but
`src/json.ts` round-trips arbitrary `functions[]`, so imported
multi-bridge chassis are reachable.

The engine already resolved the same question the other way:
`src/walk.ts sviBridgeMember` walks every internal edge - "The SVI port
belongs to whichever bridge carries it as a member - not merely the
first edge drawn."

## Decision

Member lookup is port-scoped across EVERY bridging function of the
chassis. When an imported port sits in two bridges, the first matching
bridging function in `functions[]` order is canonical for member
identity - edits land there, deterministically, and the rule is pinned
by test. `owningBridgeOf` is the single port-scoped finder;
`bridgeMemberOf` and `withMember` (every port-editing action) resolve
through it. With a port-scoped lookup, "the port is a member of some
bridge" and "the member row exists" are the same question, so the
formerly dead multi-bridge predicate in `renderPortControls` collapses
into the member check itself.

## Alternatives

**First-bridge canonical (rejected).** Keep the lookup, simplify
`renderPortControls` to the single-bridge predicate, and document that
imported multi-bridge chassis expose only their first bridge in the UI.
Rejected by the 2-seat tribunal, unanimously: it enshrines a silent
editing gap as designed behaviour, contradicts the engine's own
multi-edge resolution, and reverses the direction the #81/#87 line had
already taken - a future multi-bridge UI need would pay to reverse it.

## Consequences

- Second-bridge access ports on imported chassis become editable; the
  UI now matches the engine's membership semantics.
- Every port-editing action moved at once (they share the lookup). The
  identity rule - first match in `functions[]` order - is pinned by an
  explicit test, as is second-bridge reachability for both rendering
  and `setPvid`.
- The #87 SVI suppression is unchanged in effect but now runs through
  the live guard rather than an accidental first-bridge miss.
- Detection stays function-based, never preset id (ADR 0013).
