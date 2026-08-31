# 0024. Estimates never pass through format

- **Status:** Accepted
- **Date:** 2026-08-31
- **Source:** issue #43, [ADR 0006](0006-radio-is-an-estimate-not-a-result.md)

## Context

ADR 0006 ruled that radio coverage is an estimate, not a result, and that
estimate output must not share the tool's visual language with derived output.
The formatter is where that language lives: `format` turns hops, traces, flows
and warnings into the sentences a user reads. If an estimate could pass through
the same function, the trust the trace earns would leak onto output no standard
backs — the leak ADR 0006 exists to prevent — and it would happen quietly, at
a call site, long before anyone reviewed the wording.

The seam has to exist before stage 4 builds on it. Presentation is a
prerequisite, not polish (ADR 0006, consequences).

## Decision

1. **`Estimate` is its own type, not a `FormatInput` kind.** It carries
   `kind: 'estimate'` and a non-empty `assumptions` list
   (`[string, ...string[]]` — an estimate with no stated assumptions cannot be
   constructed). The `FormatInput` union stays four kinds: hop, trace, flow,
   warning.
2. **Estimates get their own formatter.** `formatEstimate` renders an estimate
   as an estimate: it names itself ("Estimate, not a trace") and lists the
   assumptions. It uses none of the hop verbs — forwarded, flooded, dropped,
   delivered — so the sentence cannot read as something the engine derived.
3. **The seam is enforced by the type system, not by convention.** Handing an
   `Estimate` to `format` is a compile error (TS2345), and the union is pinned
   by a type-level test so adding `kind: 'estimate'` to `FormatInput` later
   fails the suite.

No RF fields are added to `Radio` or `Link`; no catalogue row, no pipeline
step (ADR 0001). A configured `channel` integer is not an RF field
([ADR 0025](0025-radio-channel-is-config.md)).

## Alternatives rejected

- **Add `kind: 'estimate'` to `FormatInput` and branch inside `format`.** One
  formatter, one visual language — the specific trap ADR 0006 names. The
  compiler would then accept an estimate anywhere a trace goes.
- **Format estimates ad hoc at the stage 4 call site.** Leaves the seam to
  whoever writes stage 4, when it is cheapest to get wrong. The type and its
  formatter cost almost nothing now, and stage 4 cannot bypass them without a
  type error.
- **A runtime guard that throws when `format` sees an estimate.** A throw is
  discovered by users; a type error is discovered by the author. The issue's
  done-when is explicit: type error, not runtime throw.

## Consequences

- Stage 4 coverage output has a presentation seam it must use: assumptions are
  visible in every estimate sentence, and the honesty boundary (CONTEXT.md) is
  a type-level fact, not a style rule.
- `Estimate` is generic — radio coverage is the first use, not the type. Any
  future estimated output (throughput, interference) takes the same path.
- The type-level half of the seam rides on `expectTypeOf`, which `vitest run`
  does not check and the `typecheck` script excludes test files — so today it
  is verified in-editor and by review. The runtime half (the sentence, the
  absent hop verbs) is covered by ordinary assertions. Closing that gap means
  typechecking the test tree, which today carries pre-existing errors; that is
  its own issue, not this one.
