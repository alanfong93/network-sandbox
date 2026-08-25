# Contributing

Thanks for wanting to help.

## The deal

This project is **AGPL-3.0**. Your contribution stays under that licence.

**You keep the copyright on what you write.** Nobody takes ownership of it — not
other contributors, and not the maintainer.

There is **no CLA**. Nobody here can relicense the project or take it closed. That
includes the maintainer, and it is deliberate. See
[ADR 0014](docs/adr/0014-agpl-with-dco-no-cla.md).

## Sign your commits off

Add a `Signed-off-by` line to each commit:

```bash
git commit -s -m "your message"
```

That produces:

```
Signed-off-by: Your Name <your.email@example.com>
```

By adding it you agree to the Developer Certificate of Origin below. Use your real
name — it is a statement about the origin of the work.

## Developer Certificate of Origin 1.1

> Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
>
> Everyone is permitted to copy and distribute verbatim copies of this
> license document, but changing it is not allowed.
>
> **Developer's Certificate of Origin 1.1**
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I
>     have the right to submit it under the open source license
>     indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best
>     of my knowledge, is covered under an appropriate open source
>     license and I have the right under that license to submit that
>     work with modifications, whether created in whole or in part
>     by me, under the same open source license (unless I am
>     permitted to submit under a different license), as indicated
>     in the file; or
>
> (c) The contribution was provided directly to me by some other
>     person who certified (a), (b) or (c) and I have not modified
>     it.
>
> (d) I understand and agree that this project and the contribution
>     are public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

## Before you write code

Read `docs/adr/`. It is short and it is the *why*.

Two rules matter more than the rest:

1. **Do not add a hand-written error condition to the engine.** The engine executes
   the 802.1Q pipeline and outcomes fall out of it. If a trace is wrong, the pipeline
   is wrong. See [ADR 0001](docs/adr/0001-execute-the-8021q-pipeline.md).
2. **Do not make the tool state something it cannot derive.** Estimates and
   standard-derived results must not look alike. See
   [ADR 0006](docs/adr/0006-radio-is-an-estimate-not-a-result.md).

If a change rejects a real alternative, add an ADR in the same commit.

## Profiles

Vendor and ISP profiles are data, not code. You do not need to touch the engine to
add one. See [ADR 0012](docs/adr/0012-profiles-are-data-the-engine-is-the-only-executor.md).

A profile you write stays yours. AGPL-3.0 covers this project's code, not the
profile content you contribute.
