# network-sandbox — working rules

## Project

Browser-only 802.1Q sandbox. **No server, no backend, no accounts** — so the
`docs/API_Reference.md` rule below will probably never fire. Everything else does.

Design intent lives in `docs/SPEC.md`. The durable *why* lives in `docs/adr/`.
When the spec is archived at a phase close, the ADRs stay — so a decision that
rejected a real alternative goes in an ADR, not only in the spec.

The engine executes the standard's pipeline. Before adding a branch to it, check
`docs/adr/0001-execute-the-8021q-pipeline.md`: a hand-authored error condition is
almost always the wrong fix, and every `if` that isn't in IEEE 802.1Q/802.1D is a
claim this project has promised not to make.

## Docs (humans + agents)

Update docs in the same commit as the behaviour change. Mermaid only. No empty scaffolds.

Required when they apply:

- `docs/architecture.md` — what changed (ER if persisted; sequence if 2+ services talk)
- `docs/system_flow.md` — the workflow, as a mermaid flowchart
- `docs/API_Reference.md` and/or `docs/API_OpenAPI.json` — every endpoint add/change/remove
- `docs/adr/NNNN-slug.md` — why, if we rejected a real alternative
- `CONTEXT.md` — new business term, plus the alias we will not use

Required only if an entity has >3 states with illegal transitions: a state diagram in `docs/architecture.md`.

Never generate: class, use case, or DFD diagrams.

GitHub issues may discuss a decision. The durable copy is the ADR in this repo.

## Mermaid

`<br>` inside node text, never `\n`. Styled nodes set `color:#000`.
