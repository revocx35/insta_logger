# insta_logger — notes for Claude sessions

Read these first, every session:
- `ARCHITECTURE.md`: the design source of truth (containers, security model, crypto, DB schema, API, config, operations).
- `docs/instagram-notes.md`: facts about Instagram Web the code relies on (stream format, Slide JSON, GraphQL doc ids).
- `docs/DEVLOG.md`: what was done when and lessons. Append a section for each session.
- `progress.md`: checklist of what's done and open.

## Rules
- Security first: this app stores private messages. Never log or print message content, names, usernames, Instagram
  tokens (`fb_dtsg`, `lsd`, `csrftoken`, `sessionid`) or media links (not even while debugging). Never render message
  text as HTML. Never weaken CSP, cookie flags, network isolation, the Chromium sandbox or its URL policy.
- `shared/api.d.ts` is the server↔web contract. Change it deliberately and update both sides.
- The app only *reads* Instagram's message stream (CDP Network events). Never send frames on it.
- While Instagram is logged out or on a login/challenge page, nothing may be attached to the tab (`ig/loginwatch.ts`):
  no puppeteer Page, no CDP domains in the page or its frames. Instagram's login notices debuggers and loops on captchas.
- Keep the browser looking normal: WebGL (Mesa llvmpipe), the server's time zone (`TZ`), no automation flags.
- A session pasted by the owner (`POST /api/ig/session`, `ig/cookies.ts`) is a credential: never log it, never echo a
  value in an error, never store it outside the Chromium profile.
- GraphQL requests run inside the Instagram tab (`IgPage.graphql`); tokens stay in the page. Doc ids come from
  `ig/docs.ts` (defaults) or are learned from the tab — never hard-code them elsewhere.
- Instagram's signed media links live only in memory (`MediaSources`). Media is fetched only from Instagram/Meta CDN
  hosts (`isInstagramCdn`), only by the browser.
- Keep the account safe: one tab, paced requests (`IG_REQUEST_GAP_MS`), no bulk actions, no polling loops that hit
  Instagram more than the reconcile does. Don't add features that open threads in the tab.
- View-once / allow-replay media is never downloaded (wa_logger's policy).
- DB migrations are append-only (`server/src/db/db.ts`). Encrypted columns are AAD-bound to their row id.
- Commits end with the Co-Authored-By trailer. CI must stay green: it publishes the GHCR images on `main`.

## Commands
- Server: `cd server && npm test && npm run typecheck` (install with `PUPPETEER_SKIP_DOWNLOAD=true npm ci`).
- Web: `cd web && npm test && npm run build`.
- Full stack from source: `scripts/smoke.sh` (23 checks). Standalone layout: `scripts/smoke.sh --deploy`.
- Fake Instagram end to end: `cd server && npx tsx ../scripts/dev/fake-e2e.mts [--keep]` (49 checks).
- UI screenshots: `scripts/dev/README.md` (`ui-shots.mts`). Sample data: `server/src/testutil/seed.ts`.

## Gotchas learned the hard way
- Dev scripts import packages by path (`../../server/node_modules/...`) and TS files with `.ts` extensions; run them
  with `npx tsx` from `server/`.
- `pkill -f <pattern>` inside a shell command whose own text contains the pattern kills that shell. Kill by pid.
- `npx` doesn't forward SIGTERM to its child: spawn it `detached` and kill the process group (fake-e2e does).
- The fake Instagram serves plain-http media links; only the configured `IG_WEB_ORIGIN` (test) may do that
  (`setTestMediaOrigin`); real media links must be https.
- Messages the owner sends come back through the stream before or after the mutation's answer; the uploaded file is
  stored for them and the media queue skips them meanwhile (`Sender.isUploading`).
- Inside `page.evaluate()` run via `tsx` (dev scripts), named helpers get wrapped with `__name` (undefined in the page).
  The app itself is compiled by `tsc`, where this doesn't happen; keep evaluated functions free of named helpers anyway.
- Compose `configs.content` fails for `read_only` services, so the Caddyfiles are baked into the caddy image.
- Opening the site by IP means no SNI, so Caddy needs `default_sni`.
- `TRUST_PROXY` is a hop count and must equal the real number of proxies (bundled Caddy = 1, + Nginx Proxy Manager = 2).
