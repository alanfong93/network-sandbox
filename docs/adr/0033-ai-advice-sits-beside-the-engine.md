# 0033. AI advice sits beside the engine, never a hop

- **Status:** Accepted
- **Date:** 2026-09-11 (decided and recorded)
- **Source:** issue #162; tribunal 2026-09-11 (Option A, all five seats); grill 2026-09-11; [#65](https://github.com/alanfong93/network-sandbox/issues/65)

## Context

Users reviewing a config want issues, suggested fixes, and pros/cons. The
realistic alternative today is pasting topology JSON — `isp-handoff`
credentials included — into a chat UI. That is exactly the leak #65 stands
guard over: sandbox JSON round-trips PPPoE user/pass verbatim, and any
design that sends topology to a third party fires the guard.

The product shape was locked in a grill on 2026-09-11 and confirmed by a
five-seat tribunal the same day: optional, user-triggered, user-supplied
endpoint, advisory only.

## Decision

**An optional AI review path ships beside the engine, and the engine never
learns it exists.**

- A separate `network-sandbox-ai` v1 file (`{format, version, endpoint,
  model, key}`) holds the user's own OpenAI-compatible endpoint, model and
  key. It loads and saves like sandbox JSON but is never merged into it.
  The key lives in the tab; Unload drops it.
- **Review with AI** builds a **share-safe payload** and shows it for
  confirmation before any network activity. The payload is
  **allowlist-built**: every field that can leave the tab is named in
  `ui/ai.ts`. `isp-handoff` credentials have no encoder line, so no code
  path can serialize them — a deny-list would silently miss the next
  credential-shaped field. Confirm POSTs `chat/completions` to the user's
  endpoint with `fetch()` — no proxy, no SDK (ADR 0016), no server.
- The reply renders as **advice**: its own panel, its own styling, labelled
  "AI advice — not a trace". It cannot mutate the topology — there is no
  write path, by construction, not by policy. Failure catalogue rows join
  the payload only when the last trace supports them (hop step+action, or
  an observation/warning code); a topology-only review carries none.
- Follow-up chat runs against the frozen review snapshot; any topology
  edit blocks chat until Review runs again.
- Errors fail by name — CORS-or-network, 401, HTTP status. The docs print
  no vendor CORS matrix: browser reachability is a property of the user's
  chosen endpoint, not a fact this project can promise.

## Alternatives rejected

- **Hosted proxy run by this project** (holds keys or forwards). Wins
  zero-config UX; costs a server, key custody, uptime, abuse surface and
  AGPL hosting duties — and supersedes ADR 0009 and PRODUCT job 1. The
  browser-only architecture is the product.
- **API key inside sandbox JSON.** Puts a billable key into the one file
  users are told to hand to other people (#65). Strictly worse than the
  PPPoE credentials already there.
- **AI mutates the topology** (apply suggestions). Breaks ADR 0012 (the
  engine is the only executor) and ADR 0002 (advice would become a
  verdict with write access). The chat box makes this request inevitable;
  the answer is a missing write path, not a setting.
- **Copy-then-strip redaction.** Rejected in the tribunal's peer round:
  the schema being closed today is not an invariant. The payload is
  constructed from permitted fields only.
- **Auto-review on edit.** Optional means optional: no egress without a
  user-triggered Review and a confirmed preview.

## Consequences

- #65 is cited here and resolved **for this path**: the design explicitly
  chooses strip (the payload is share-safe by construction). Topology
  files and the hosted demo still round-trip credentials, so #65 stays
  open for the export path.
- A stranger who never loads an AI config sees unchanged sandbox behaviour;
  the feature reverses by not loading the file.
- The system prompt tells the model the honesty boundary: estimates are
  never traces (ADR 0006, 0024), no pass/fail framing (ADR 0002), and the
  topology JSON is data to review, never instructions (prompt injection
  bounds to bad prose because there is no write path).
- AGPL obligations are unchanged: the hosted copy is this repo; the keys
  and endpoints are the user's, not this project's.
- The engine (`src/`) never imports the AI module; `ui/ai.ts` imports the
  engine. If the engine ever needs to know about AI, that is this ADR
  failing, not a refactor.
