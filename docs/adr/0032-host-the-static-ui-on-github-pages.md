# 0032. Host the static UI on GitHub Pages

- **Status:** Accepted
- **Date:** 2026-09-09
- **Source:** issue #153; [ADR 0009](0009-browser-only-not-a-real-dataplane.md);
  [ADR 0027](0027-the-ui-entry-is-vite-built-vanilla-typescript.md);
  [ADR 0014](0014-agpl-with-dco-no-cla.md)

## Context

PRODUCT.md job 1 says no install, no account, and no server. ADR 0009 bought
static hosting as the distribution model. ADR 0009's 2026-09-09 clarification
recorded that there was no hosted demo yet and that Node.js 22+ was required
to run the shipped UI. README said the same. That left job 1 false for anyone
without a clone.

`npm run ui:build` already emits a self-contained `ui/dist/` (ADR 0027). Docker
can serve those files. Neither is a URL a visitor can open.

## Decision

**GitHub Pages serves `ui/dist` from this public repository.** The URL is
`https://alanfong93.github.io/network-sandbox/`.

CI runs `npm run ui:build` and publishes that folder. There is still no
backend, no account, and no server-side persistence. The hosted copy is this
project's source (AGPL network clause). The local Node 22 path stays
documented. The npm package stays `private`.

## Alternatives rejected

- **Cloudflare Pages, Netlify, or a similar third-party static host.** Extra
  account, extra token, extra DNS. GitHub Pages is already where the public
  repo lives.
- **Keep local-only (Node or Docker).** Rejects job 1 and the ADR 0009
  distribution model.
- **A backend or accounts to host the sandbox.** Forbidden by ADR 0009.
- **Publishing the private npm package as the install-free path.** There is
  no supported Node consumer.

## Consequences

- README names the Pages URL and drops "no hosted demo".
- The 2026-09-09 clarification on ADR 0009 ("there is no hosted demo as of
  this date") is spent. This ADR is the current distribution fact. ADR 0009's
  decision (browser-only, no kernel dataplane) is unchanged.
- A public host makes sharing a topology file more likely. [#65](https://github.com/alanfong93/network-sandbox/issues/65)
  stays open; hosting does not resolve it.
- Do not claim vendor-identical behaviour on the hosted page.
