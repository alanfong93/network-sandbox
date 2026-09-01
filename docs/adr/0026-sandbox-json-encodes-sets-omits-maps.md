# 0026. Sandbox JSON encodes Sets as arrays and omits runtime Maps

- **Status:** Accepted
- **Date:** 2026-09-01
- **Source:** issue #57, [ADR 0015](0015-import-real-config-before-exporting-it.md),
  [ADR 0016](0016-typescript-vitest-no-framework.md)

## Context

`JSON.stringify` turns a `Set` into `{}` and a `Map` into `{}`. The in-memory
Topology stores VLAN membership as `Set<VlanId>` and keeps `fdb` / `stp.state`
as Maps. The file the user keeps has to round-trip the graph (SPEC §8 Q2)
without a runtime schema library (ADR 0016) and without becoming vendor CLI
(ADR 0015).

## Decision

The sandbox envelope is `{format, version, topology}` at version 1.
`taggedVlans` and `untaggedVlans` encode as sorted number arrays — they are
always Sets, so a generic `$set` marker is unnecessary. `fdb` and `stp.state`
are omitted on write and empty Maps on parse: they belong to a run, not to
the file. `createRunContext` rebuilds STP; FDB is learned during the walk.
Unknown `fn.kind` and unsupported versions fail by named errors, not a bare
`SyntaxError`. isp-handoff credentials stay — they are topology config.

## Alternatives rejected

- **Generic `$set` / `$map` markers.** Rejected: every Set field is known.
  A marker would invent a private encoding for a problem the type already
  solves.
- **AJV, JSON Schema files, or protobuf.** Rejected under ADR 0016: a
  runtime dependency is a new decision, and the failure modes that matter
  (unknown kind, wrong version) are two named errors.
- **Persisting FDB and STP Maps.** Rejected: they are run-context state.
  Writing them would freeze a cold-start lie into the file.
- **Canvas `x,y` on Topology.** Rejected: the graph is the file; layout is
  UI. Putting coordinates on Topology would make a screenshot a network.
