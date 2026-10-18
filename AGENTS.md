# AGENTS.md — notes for AI coding agents

insta_logger is a self-hosted, single-owner **Instagram DM logger** (wa_logger's Instagram sibling): a real Chromium
runs Instagram Web in a container, the app reads its message stream over CDP and stores every message, edit, reaction
and media file encrypted — unsent messages stay readable. It also sends, plays **Reels**, logs **Stories** and offers a
native Android client (separate repo `revocx35/insta_logger_android`).

Read before changing anything: [ARCHITECTURE.md](ARCHITECTURE.md) (design, security model, DB, API, operations),
[docs/instagram-notes.md](docs/instagram-notes.md) (the Instagram Web facts the code depends on), [SECURITY.md](SECURITY.md),
[docs/DEVLOG.md](docs/DEVLOG.md) (history, lessons) and [CLAUDE.md](CLAUDE.md) (the same rules for Claude sessions).

## Layout

| Path | What |
|---|---|
| `shared/api.d.ts` | The HTTP API contract (types only), shared by server, web and the Android client's `Models.kt` |
| `server/src/app.ts`, `http/`, `auth/`, `crypto/`, `db/` | Fastify app, security hooks, login/2FA/sessions, envelope encryption, SQLite (append-only migrations) |
| `server/src/ig/` | Instagram integration: `service.ts` (lifecycle, checks, timers, session refresh), `loginwatch.ts` (hands-off while logged out), `page.ts` (CDP session: stream, GraphQL, REST, downloads), `dgw.ts` (stream decoder), `mapper.ts`/`ingest.ts` (messages → DB), `sync.ts` (history, reconcile), `sender.ts`, `media.ts`, `docs.ts` (GraphQL doc ids), `cookies.ts` (pasted sessions), `stories.ts` (story logging) |
| `server/src/igweb/` | Reels: `client.ts` (feed, likes, comments), `mapper.ts`, `media.ts` (opaque media refs) |
| `server/src/api/` | Routes: chats, media, send, admin (`/api/ig/*`), reels, stories, settings, audit, SSE |
| `web/src/` | React UI: `pages/` (Chats, Reels, Stories, Unsent, Search, Instagram, Settings, auth), `components/`, `lib/igText.tsx` |
| `chromium/` | Chromium image: entrypoint (Xvfb, Mesa WebGL, VNC, CDP relay), URL/cookie policy, seccomp profile |
| `caddy/`, `deploy/`, `scripts/setup.sh` | TLS proxy, prebuilt-image compose, `.env` generator |
| `scripts/smoke.sh`, `scripts/dev/` | Full-stack smoke test; fake Instagram + end-to-end test; UI screenshots |

## Commands

```bash
cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npm run typecheck   # 151 tests
cd web && npm ci && npm test && npm run build                                        # strict-CSP build
scripts/smoke.sh                     # whole stack from source, real instagram.com login page (23 checks)
cd server && npx tsx ../scripts/dev/fake-e2e.mts [--keep]   # real stack vs fake Instagram (61 checks; Docker, ports 29443/29080/18555)
```
CI (`.github/workflows/ci.yml`) runs the tests and publishes `ghcr.io/revocx35/insta_logger-{app,chromium,caddy}` on
`main`. Deploy = `docker compose pull && docker compose up -d` where it runs.

## Conventions

- Change the API deliberately: `shared/api.d.ts` first, then server, web, and the Android client's `Models.kt`.
- Everything from Instagram is untrusted input: validate ids (`^\d+$`), cap sizes, parse defensively (shapes are
  Instagram's internal formats and change).
- Instagram requests run inside the tab (`IgPage.graphql` / `IgPage.rest`), paced, one at a time; doc ids come from
  `ig/docs.ts` defaults or are learned from the tab — never hard-code them elsewhere.
- New query or mutation: capture Instagram Web's own request (names, doc id, variables) from a second tab; for writes,
  stop the request inside the browser (`Fetch.failRequest`) so nothing is sent. Record it in docs/instagram-notes.md.
- Every feature gets unit tests and, when it touches Instagram, a fake-Instagram endpoint plus e2e checks
  (`scripts/dev/fake-instagram.mts`, `fake-e2e.mts`), including "no content/tokens in logs or DB".
- Update ARCHITECTURE.md, this file, README and docs/DEVLOG.md in the same change. Commits end with the
  `Co-Authored-By` trailer; scan with gitleaks before pushing.

## Never

- Log message text, names, usernames, cookies, tokens (`fb_dtsg`, `lsd`, `csrftoken`, `sessionid`) or media links.
- Store Instagram's signed media links outside memory; serve them to clients (use media refs / `/api/media`).
- Write to Instagram's message WebSocket; open threads in the tab (sends "Seen"); mark stories as seen.
- Attach CDP to the tab while it is logged out or on a login/challenge page (`loginwatch.ts` explains why).
- Weaken CSP, cookie flags, CSRF/Origin checks, the Chromium sandbox, its URL/cookie policy or network isolation.
- Edit old DB migrations (add a new one), or put message text in URLs.

## Gotchas

- `pkill -f <pattern>` inside a command containing the pattern kills your own shell: kill by pid.
- `npx` doesn't forward SIGTERM: spawn detached and kill the process group (fake-e2e does).
- Right after a tab (re)load Instagram Web's modules aren't ready: GraphQL waits for `getAsyncParams`, the inbox for
  the device id.
- Instagram renames queries and drops variables (e.g. relay providers): a `{data: null, errors}` answer or an HTML page
  usually means a changed doc id or variables — compare with the tab's own request.
- `TRUST_PROXY` is a hop count (bundled Caddy = 1, + Nginx Proxy Manager = 2).
