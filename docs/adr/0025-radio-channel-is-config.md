# 0025. Radio.channel is config, not an RF claim

- **Status:** Accepted
- **Date:** 2026-08-31
- **Source:** issue #54, [ADR 0006](0006-radio-is-an-estimate-not-a-result.md),
  [ADR 0013](0013-devices-are-a-chassis-plus-functions.md),
  [ADR 0024](0024-estimates-never-pass-through-format.md)

## Context

OpenWrt stores channel on `wifi-device` (ADR 0013). That number is configuration:
the user set it, the same way they set a VLAN ID. Whether two radios on that
channel actually interfere is physics — walls, distance, power — which this
model does not have.

ADR 0006 and ADR 0024 keep assumed output out of the trace's language. They do
not forbid storing a number the user typed. Mixing "same channel" with "they
interfere" would treat config as an RF result.

## Decision

`Radio.channel` is an optional positive integer. Omitted is unset. It is config,
not an RF claim.

Power and coverage stay off `Radio` and `Link`. `channel` stays off `Link`. This
slice produces no `Estimate` from radios — no producer, even one that only lists
assumptions, no hop, no catalogue row, no pipeline step (ADR 0001).

## Alternatives rejected

- **Treat same-channel as interference (option A).** That needs walls and
  distances the model does not have. A configured integer is not a site survey.
- **Put `channel` on `Link`.** A link is a path between ports. Channel belongs
  to the transmitter, which is the radio (ADR 0013's `wifi-device` split).
- **Emit an `Estimate` now, assumptions-only.** Stage 4 may still emit estimates
  once UI language exists (ADR 0006). This slice does not close that door, and
  it does not open it early with a producer that has nothing to say.

## Consequences

- A topology can record the channel the user configured without implying
  coverage or interference.
- ADR 0024's "no RF fields on Radio or Link" still holds: a configured channel
  is not an RF field. Power, coverage, and channel quality remain stage 4.
