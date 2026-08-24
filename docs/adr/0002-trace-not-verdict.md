# 0002. Show a trace, never a verdict

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `README.md`; `docs/SPEC.md` §1, §2 (`Frame.hops`)

## Context

The obvious output for "did my config work?" is a pass/fail result — a green tick or
a red cross. It is also the output that does the most damage. A green tick invites
blind trust, and blind trust in a simulator is how someone breaks a production
network: the user stops reading at the tick, never notices the assumption the tool
made, and ships a design whose failure mode was never on screen.

## Decision

The primary output is the **per-hop trace**, always. Every device a frame touches
appends a `Hop` recording the in port, out port, VLAN, action
(`forwarded | flooded | dropped | delivered`) and a human-readable reason.
`Frame.hops` is not diagnostic instrumentation bolted on the side — it **is** the
explanation, and it is the product.

The UI's job is to name the step the frame died at, in the standard's own terms.

## Alternatives rejected

- **Pass/fail verdict as the headline, trace behind a "details" toggle.** Friendlier,
  and it is what every connectivity checker does. Rejected because the toggle is
  the failure: nobody opens it when the answer is green, which is exactly when the
  hidden assumption matters. It reintroduces the blind trust the project exists to
  refuse.
- **Verdict plus trace, side by side.** Softer, but the verdict still wins the
  user's attention and the trace becomes decoration.

## Consequences

- Every device implementation must record a reason for every action, including
  successful ones. A hop with no reason is an incomplete implementation.
- Reason strings are user-facing product copy, not debug logs. They are held to the
  standard of the wording in the failure catalogue (`docs/SPEC.md` §4).
- The same mechanism serves both audiences without extra work: the trace is a
  teaching artifact for someone learning, and a bug report for someone debugging.
- The tool is slower to read than a tick. That is the point, and it is a real cost
  — the UI must make a long trace scannable rather than pretending it is short.
