# 0017. Structure in engine tests; wording against the catalogue table

- **Status:** Accepted
- **Date:** 2026-08-26
- **Source:** GitHub issue #1 (definition of done); issue #2 (formatter and table)

## Context

The failure catalogue in `docs/SPEC.md` §4 is both a test suite and user-facing
copy. Mixing those jobs in one assertion is how a wording tweak silently
relaxes a structural check, and how a pipeline bug gets "fixed" by editing a
sentence.

Two independent reviewers also read `Flow.outcome` names as aggregate
verdicts sitting next to ADR 0002. That is a different question (it affects
#7). This decision is about how tests are written, not about those names.

## Decision

**Two kinds of assertion, never in the same expect.**

1. **Structural.** Engine tests name device, function, pipeline step, reason
   code, VLAN, port and action. They contain no prose. A reason code is
   `step:outcome` from `src/reasons.ts` — adding one requires adding a step
   or an outcome, never a scenario (ADR 0001).
2. **Wording.** A separate check compares `format(...)` to the checked-in
   string on the matching catalogue row in `src/catalogue.ts`. That table is
   the copy source; the spec's §4 table is the human-readable original and
   must stay in sync.

`format` lands in this slice so later issues can assert catalogue wording as
each row's engine behaviour lands. Deferring it would discover whether the
sentences are renderable only after the engine is finished.

The formatter is presentation. Observation names it uses (`vlan-leak`,
`dual-offer`, …) are not reason codes and must not appear in the engine.

## Alternatives rejected

- **Embedding the expected sentence in each engine test.** Convenient, and
  it would make a single file the whole test. Rejected because the sentence
  then drifts from the spec table, and a developer can make a failing row
  "pass" by editing the string next to the `expect`.
- **Snapshot files.** They would catch wording drift. Rejected because a
  snapshot is an unreviewed blob; the catalogue is numbered, cited from ADRs,
  and has to stay readable.
- **One `format` call that keys off catalogue row ids.** That would be a
  rulebook of copy selected by scenario, which is ADR 0001 wearing a
  different hat. The engine produces hops; `format` turns structured hops
  (or a trace/flow/warning built from them) into a sentence.

## Consequences

- Every Stage 1 issue that closes catalogue rows must go green **both**
  structurally and verbatim.
- Changing a catalogue sentence is a product-copy change. It updates
  `docs/SPEC.md` §4 and `src/catalogue.ts` in the same commit.
- `Hop.reason` is the formatted sentence (ADR 0002: user-facing copy).
  `Hop.reasonCode` is the structured claim the engine tests read.
