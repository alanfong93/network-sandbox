# 0034. Share-safe export omits credentials behind an explicit marker

- **Status:** Accepted
- **Date:** 2026-09-25 (decided and recorded)
- **Source:** issue #168; tribunal 2026-09-19 (Option S, 4/5 seats, two rounds);
  [#65](https://github.com/alanfong93/network-sandbox/issues/65);
  [ADR 0026](0026-sandbox-json-encodes-sets-omits-maps.md),
  [ADR 0033](0033-ai-advice-sits-beside-the-engine.md)

## Context

Sandbox JSON is the format of record for PRODUCT job 5 — keep a topology
between sessions **and hand it to someone else as a file** — and it
round-trips `isp-handoff` credentials verbatim. The 2026-09-03 tribunal
(fork C, C1b) ruled the keep-file **keeps** credentials: they are topology
config, and stripping them there breaks round-trip expectations. The
2026-09-11 AI-advisor tribunal (ADR 0033) resolved the *sent-to-a-model*
path as strip-by-construction and explicitly left the file-export path to
#65, which stands guard until a share feature answers the credential
question on record.

Router config files with plaintext PPPoE logins get posted publicly; the
leak path is real even though no incident involves this format yet. The
2026-09-19 four-seat tribunal decided the export path: a **separate
share-safe artifact** built from an engine omit-mode, marked with an
explicit envelope sibling, warned once on import only when the marker is
present.

## Decision

**The keep-file keeps credentials; a second, share-safe artifact omits
them behind an explicit marker. The sharing intent lives in the UI, never
in the engine.**

- **Engine omit-mode.** `toJson(topology, { omitCredentials: true })`
  skips exactly the `credentials` write in the `isp-handoff` branch —
  nothing else moves. The option is optional and the default path is
  byte-identical; no caller changes. The decoder already tolerates absent
  credentials, so it learns nothing new. A structural property in
  `src/json.test.ts` pins the contract: omit output deep-equals default
  output minus exactly the `credentials` keys, parameterised over every
  fixture topology — it fails loudly when a future credential-shaped field
  appears, because the encoder and the property must then change together,
  in one PR, on the record.
- **UI-owned intent.** `exportSandbox(topology, layout, { shareSafe: true })`
  (ui/jsonio.ts) builds the share artifact: the same v1 envelope minus
  credentials, plus the sibling `sharing: { credentials: 'stripped' }`
  beside the optional `layout` sibling (ADR 0026 owns the envelope: the
  marker is a sibling, **not** a Topology field, no version bump, and
  `fromJson` never learns it). The share action downloads
  `sandbox-share.json`; **Export file** is untouched.
- **Marker-only honesty.** Import parses the marker only on its exact
  value; malformed `sharing` shapes are inert data. A marked import warns
  **once**, at import time, composed with the existing DHCP notice into
  the single `loadTopology` notice (#86 pattern — never a runtime nag).
  An unmarked file never receives a sanitization claim: a keep-file with
  plaintext credentials imports silently, and a hand-edited file without
  the marker is not called sanitized. This is #65's exit clause — import
  stays honest about what a loaded file lacks — delivered.

## Alternatives rejected

- **Strip on export** (fork 3b, 2026-09-01): contradicts the C1b keep
  ruling two days later — the keep-file keeps credentials, and there is
  one serializer, so there is no second path to strip.
- **Redaction with a user toggle**: puts credential safety on user
  vigilance at share time; rejected twice on record (2026-09-01 and
  2026-09-19 tribunals).
- **Copy-then-strip in the UI** (serialise, delete keys, write): rejected
  in ADR 0033 for the payload path and rejected here for the same reason —
  a deny-list silently misses the next credential-shaped field.
- **A ui/-layer second serializer**: two encoders drift apart silently and
  the drift is file corruption. One serializer (`src/json.ts`) with an
  explicit omit option is the whole point.

## Consequences

- PRODUCT job 5's hand-it-over path is safe by construction for the
  artifact designed for it, without touching the keep-file's ruling.
- **#65 closes here**: this ADR is the share-feature design that cites it,
  records the credential policy (separate share-safe artifact, explicit
  marker, marker-only import warning), and keeps import honest.
- The hosted demo and AI payload policies are unchanged (ADR 0033 remains
  scoped to its path).
- The engine (`src/`) contains no sharing-intent concept — only
  `omitCredentials`. **If the engine ever needs to know about sharing,
  this ADR has failed.**
