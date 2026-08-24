# 0010. ARP is modelled explicitly, and there is no ARP cache

- **Status:** Accepted
- **Date:** 2026-08-25
- **Decided by:** 3-model Council (Gemini 3.1 pro, DeepSeek v4-pro, GPT-5.6-terra; Grok not convened — xAI credits exhausted). Closes `SPEC.md` §8 question 1.

## Context

The spec left open whether ARP is executed as real frames or whether computing L3
reachability is enough. Two catalogue rows had already been written assuming the
former — row 7 reads *"ARP for 192.168.10.1 flooded VLAN 10 — no reply; gateway is on
VLAN 20"* — so the question was really whether to honour that or rewrite it.

## Decision

**Model ARP explicitly.** A host that needs to resolve a peer or its gateway emits an
ARP request as a broadcast frame, and that frame traverses the same 802.1Q
ingress → forward → egress pipeline as any other. A reply comes back or it does not,
and either way the hops are the explanation.

**There is no ARP cache.** Every trace starts cold. Resolution holds for the lifetime
of one trace and is never carried between traces.

## Alternatives rejected

- **Reachability-only: skip ARP, compute whether L3 connectivity exists.** Smaller,
  and it avoids simulating host behaviour. Rejected on the argument two seats reached
  independently and which is decisive here: a reachability calculator is a **second
  engine that bypasses the pipeline**, and two engines can disagree. That is exactly
  the false-trust failure this project exists to prevent, and it contradicts
  [ADR 0001](0001-execute-the-8021q-pipeline.md). It would also make row 7's text
  fiction — the trace would claim an ARP flood that never happened.
- **Modelling an ARP cache with ageing.** Realistic, and it is what real hosts do.
  Rejected because a cache that ages is a timer in disguise, which
  [ADR 0003](0003-converged-state-no-timers.md) forbids. GPT put the trade most
  sharply: *the cache is the hidden cost, not ARP itself.*

## Consequences

- ARP is cheap but **not free**, and the brief that framed it as nearly free was
  corrected by the Council. The broadcast-and-flood machinery does come free from
  DHCP, but ARP additionally requires host-side IP reasoning: subnet membership
  (is this destination local, or do I ARP the gateway?) and every IP-bearing
  interface answering for its own addresses. `Host` already carries `ip`, `prefix`
  and `gateway`, so the data is there; the responder logic is new.
- **Accepted risk, named by all three seats:** an explicit ARP exchange looks
  authoritative, and real gear has proxy ARP, static entries, dynamic ARP inspection,
  port security and duplicate-IP behaviour that this does not model. A simulated ARP
  reply is not proof a real one will arrive. Same honesty boundary as
  [ADR 0006](0006-radio-is-an-estimate-not-a-result.md).
- The cold-cache precondition is **user-visible**, not an implementation footnote.
  A trace that begins with an ARP exchange every time is correct here and would be
  odd on a real host mid-session; the UI must say so rather than let it read as a
  bug.
- Rows 7 and 8 keep their wording, and are now produced by the engine rather than by
  a special-cased string — which is the only version of them ADR 0001 permits.
