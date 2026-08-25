# 0014. AGPL-3.0 with a DCO, and deliberately no CLA

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

The README said the licence was "not yet chosen". The repo is public and is intended
as portfolio evidence, and the owner expects outside contributors in future.

The owner's requirement, in his words: *"I don't want anyone to sell it."* And the
reason, which turned out to be the load-bearing part: *"there might be people other
than me contribute to this project. If somebody can sell it without us, then wouldn't
that be a disrespect to those who contributes without looking for any rewards?"*

Two facts shaped the answer.

**No open source licence forbids selling.** Permitting sale is part of the definition.
What a copyleft licence does instead is make selling a *closed* version pointless,
because the buyer receives the source and may redistribute it freely.

**Copyright ownership decides who can change the licence later.** Absent an agreement,
every contributor owns their own contribution and the project becomes a patchwork.
Relicensing then requires every contributor's consent. That single fact turns the
contributor question into a licensing question.

## Decision

**AGPL-3.0** for the code. **A DCO** for contributions. **No CLA.**

AGPL rather than GPL specifically because this is a web app. Under plain GPL someone
can host a modified version without ever "distributing" it, and so never has to share
anything. AGPL's network clause closes exactly that hole.

The DCO means contributors certify they wrote what they submit and have the right to
submit it. They keep their copyright. **No party can relicense the project — including
the maintainer.** That is the point, not a side effect.

## Alternatives rejected

- **MIT or Apache-2.0.** The obvious portfolio choice: maximum reach, zero friction,
  instantly recognised. Rejected because both explicitly permit selling a closed
  derivative, which is the specific thing the owner objected to.
- **The mem0 model — permissive licence plus a paid hosted service ("open core").**
  Checked, since it was raised directly: [mem0](https://github.com/mem0ai/mem0) is
  Apache-2.0 and sells a cloud platform. It does not transfer here for two reasons.
  It permits exactly the selling the owner wants to prevent, and it needs
  infrastructure to sell — this project is browser-only with no server by
  [ADR 0009](0009-browser-only-not-a-real-dataplane.md), so there is nothing to host.
- **Dual licensing — AGPL for everyone plus a paid commercial licence** (the Qt and
  MySQL model). This is the only route to commercial revenue and it was a real option.
  Rejected because it requires the maintainer to hold all copyright, which requires a
  CLA, which would let him do the very thing he objected to: sell work that others
  contributed for free. Choosing consistency here has a price and it was chosen
  knowingly.
- **A "non-commercial" licence** (CC BY-NC or bespoke). Forbids selling outright,
  which sounds like the literal request. Rejected: not open source, unrecognised by
  tooling, "commercial" is notoriously undefined, and a bespoke licence reads badly on
  a repo meant as professional evidence.
- **Deciding contributor terms later.** Rejected because the first outside
  contribution settles it by default, and by then the choice is gone.

## Consequences

- **No commercial licensing of this project, ever, without tracking down every
  contributor.** That door is now closed, deliberately.
- Some organisations refuse AGPL code outright, so corporate adoption will be
  narrower. This affects adoption, not evaluation — someone assessing the repo reads
  it, they do not vendor it.
- Contributors are protected in the way the owner intended: their work cannot be
  enclosed by anyone, and the AGPL network clause means a hosted fork must publish
  its changes back.
- Every commit needs `git commit -s`. `CONTRIBUTING.md` carries the DCO text and the
  reasoning.
- **AGPL-3.0 covers the code, not user-authored profile content.** Under
  [ADR 0012](0012-profiles-are-data-the-engine-is-the-only-executor.md) profiles are
  data written by third parties, and this licence does not claim them. That needs
  stating plainly wherever profiles are published.
