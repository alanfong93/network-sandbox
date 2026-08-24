# 0003. Compute the converged state; model no timers

- **Status:** Accepted
- **Date:** 2026-08-25
- **Source:** `docs/SPEC.md` §5, §6

## Context

Much of what makes real networks painful is temporal: spanning tree takes ~30
seconds to reconverge, DHCP leases expire, ARP caches age out, failover has a
duration during which traffic is black-holed. Modelling any of that means a clock,
an event queue, and a decision about how fast simulated time runs.

## Decision

The sandbox computes the **converged state** and nothing else. There is no clock and
no event queue.

- STP is solved deterministically: root election by bridge ID, root port by lowest
  path cost, designated port per segment, everything else blocking.
- Multi-WAN failover (stage 3) is modelled as **state comparison** — "all lines up"
  versus "WAN1 down" are two computed states the user switches between — not as a
  timed transition.

## Alternatives rejected

- **A discrete-event simulator with a clock.** It would cover convergence time,
  lease expiry, ARP ageing and failover duration — genuinely valuable answers.
  Rejected because timing fidelity is precisely where a browser model would be
  making things up: real reconvergence time depends on hardware, vendor timer
  defaults, port types and CPU load, none of which the standard fixes. The sandbox
  would be inventing seconds and presenting them with the same confidence as the
  parts it can actually derive — the failure mode ADR 0002 exists to prevent.
- **Approximate timers using published default values** (e.g. the 802.1D 15s
  forward delay). Cheaper, but a number sourced from a default the user's switch may
  not use is a wrong answer wearing a citation.

## Consequences

- **This limit belongs in the UI, not only in the docs.** A design that settles
  cleanly here can still black-hole traffic for ~30 seconds on real hardware, and
  the user must be told that where they will see it.
- Questions the sandbox cannot answer, by construction: how long the network is down
  during reconvergence; whether existing sessions survive a failover; what happens
  when a lease expires; whether an ARP entry ages out in time.
- Failover answers *will it work*, never *how fast*.
- The engine stays a pure function of topology + config → state, which makes every
  outcome reproducible and testable without time-dependent flakiness.
- If timing is ever wanted, it is a new engine, not a parameter. Reopen this ADR
  rather than adding a clock alongside.
