# AGENTS.md — notes for AI coding agents

insta_logger is a self-hosted **Instagram DM logger** (wa_logger's Instagram sibling): a real Chromium runs Instagram Web
in a container, the app reads its message stream over CDP and stores every message, edit, reaction and media file
encrypted — unsent messages stay readable. It also sends, plays **Reels**, logs **Stories** and offers a native Android
client (separate repo `revocx35/insta_logger_android`).

**Multi-user:** the first account is the admin; the admin creates users (temporary password → the user chooses their own
and logs their own Instagram in) and can give each a port. Every user is a tenant with its own worker process (own unix
user, own SQLite database, own keys), own Chromium (own unix user, own profile) and own Instagram login.

Read before changing anything: [ARCHITECTURE.md](ARCHITECTURE.md) (design, security model, DB, API, operations),
[docs/instagram-notes.md](docs/instagram-notes.md) (the Instagram Web facts the code depends on), [SECURITY.md](SECURITY.md),
[docs/DEVLOG.md](docs/DEVLOG.md) (history, lessons) and [CLAUDE.md](CLAUDE.md) (the same rules for Claude sessions).

## Layout

| Path | What |
|---|---|
| `shared/api.d.ts` | The HTTP API contract (types only), shared by server, web and the Android client's `Models.kt` |
| `server/src/index.ts` | The tenant WORKER (one process per user; listens on a unix socket behind the gateway) |
| `server/src/front.ts`, `front/` | The GATEWAY: the only network listener — users, ports, admin API, proxy to workers (system DB) |
| `server/src/supervisor/` | Root process of the app container: starts the gateway + one worker per user under their own unix users |
| `server/src/api/internal.ts` | Worker routes only the gateway may call (`/internal/*`) |
| `server/src/app.ts`, `http/`, `auth/`, `crypto/`, `db/` | Fastify app, security hooks, login/2FA/sessions/claim, envelope encryption, SQLite (append-only migrations) |
| `server/src/ig/` | Instagram integration: `service.ts` (lifecycle, checks, timers, session refresh), `chromium.ts` (this tenant's browser through the manager), `loginwatch.ts` (hands-off while logged out), `page.ts` (CDP session: stream, GraphQL, REST, downloads), `dgw.ts` (stream decoder), `mapper.ts`/`ingest.ts` (messages → DB), `sync.ts` (history, reconcile), `sender.ts`, `media.ts`, `docs.ts` (GraphQL doc ids), `cookies.ts` (pasted sessions), `stories.ts` (story logging) |
| `server/src/igweb/` | Reels: `client.ts` (feed, likes, comments), `mapper.ts`, `media.ts` (opaque media refs) |
| `server/src/api/` | Routes: chats, media, send, admin (`/api/ig/*`), reels, stories, settings, audit, SSE |
| `web/src/` | React UI: `pages/` (Chats, Reels, Stories, Unsent, Search, Instagram, Settings, Admin, auth), `components/`, `lib/igText.tsx` |
| `chromium/` | Chromium image: `manager/` (Go: one Xvfb + Chromium + x11vnc per user, token-checked API), entrypoint, URL/cookie policy, seccomp profile |
| `caddy/`, `deploy/`, `scripts/setup.sh` | TLS proxy (+ one site per `EXTRA_PORTS` port), prebuilt-image compose, `.env` generator |
| `scripts/smoke.sh`, `scripts/dev/` | Full-stack smoke test (incl. multi-user); fake Instagram + end-to-end test; `multiuser-e2e.mts`; UI screenshots |

## Commands

```bash
cd server && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npm run typecheck   # 197 tests
cd web && npm ci && npm test && npm run build                                        # strict-CSP build
cd chromium/manager && CGO_ENABLED=0 go test ./...                                    # Go manager (also run in the image build)
scripts/smoke.sh                     # whole stack from source, real instagram.com login page + multi-user checks
cd server && npx tsx ../scripts/dev/fake-e2e.mts [--keep]   # real stack vs fake Instagram (61 checks; Docker, ports 29443/29080/18555)
# Against a running stack: unix users, one browser per user, ports, claim/reset/wipe (see the header of the script)
cd server && BASE=http://127.0.0.1:8080 EXTRA_PORT=8101 PROJECT=iglmulti npx tsx ../scripts/dev/multiuser-e2e.mts
```

CI (`.github/workflows/ci.yml`) runs the tests, then the image builds (the chromium image build runs `go test`), and
publishes `ghcr.io/revocx35/insta_logger-{app,chromium,caddy}` on `main`. Deploy = `docker compose pull && docker compose up -d`.

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
- Tenant 1 (the first account) keeps the single-user layout: data in `/data`, uid 10001, browser profile `/data/profile`,
  uid 10002. Tenant n>1: `/users/<n>`, `/data/u<n>/profile`, uid `10100+n`. Ids are never reused.
- When a **web** page/setting/flow changes that the Android client also has, port it to `insta_logger_android` too.

## Multi-user rules

- **Only the gateway listens on the network.** Workers listen on a unix socket in a `tenant:front 0710` directory and
  require `X-IGL-Internal`; `/internal/*` also requires `X-IGL-Scope: internal`, which only the gateway adds. Never add a
  network listener to a worker, and never forward a client's `X-IGL-*` header.
- **No shared state between tenants.** No shared files, sockets, secrets, caches or databases; the gateway holds only the
  user list (names, ports, disabled) and its audit log. New features must not need cross-tenant reads.
- **The tenant cookie (`__Host-igl_tenant`) is a routing hint**, never a credential: the worker validates its own session.
- **Port pinning is enforced on every request and WebSocket upgrade** (admin: the default port only). New routes go through
  the gateway's normal proxy; do not special-case a port.
- **Admin actions that destroy data ask for the admin password again** and are audited. The admin API never returns
  message content, contact names or media.
- **`CONTROL_SECRET` is only for the app↔chromium hop**; the supervisor derives `HMAC-SHA256(CONTROL_SECRET,
  "igl/chromium/instance/<id>")` (see `supervisor/tokens.ts` and `chromium/manager/auth.go`, same test vectors). Never
  give a worker the admin token or another tenant's token.

## Never

- Log message text, names, usernames, cookies, tokens (`fb_dtsg`, `lsd`, `csrftoken`, `sessionid`) or media links.
- Store Instagram's signed media links outside memory; serve them to clients (use media refs / `/api/media`).
- Write to Instagram's message WebSocket; open threads in the tab (sends "Seen"); mark stories as seen.
- Attach CDP to the tab while it is logged out or on a login/challenge page (`loginwatch.ts` explains why).
- Weaken CSP, cookie flags, CSRF/Origin checks, the Chromium sandbox, its URL/cookie policy or network isolation.
- Add capabilities to the app/chromium containers beyond `SETUID SETGID CHOWN KILL`, or run a worker/browser as root.
- Edit old DB migrations (add a new one), or put message text in URLs.
- Push or publish without the leak scan (IPs, secrets, history) from the global rules.

## Gotchas

- **Root has no DAC override in the two root processes** (capabilities are `SETUID SETGID CHOWN KILL` only): they cannot
  read, write, chmod or delete inside a tenant's directories. Create + chown top-level dirs, then do everything inside as
  that unix user (`runAs`, `find … -delete`). Root also cannot `chmod` a directory it already handed over (chmod first,
  chown last). `kill` of another user's process needs `CAP_KILL`.
- A worker's unix user has no passwd entry: `HOME` must be set or Node's `os.homedir()` throws.
- Stale Chromium `SingletonLock` after a container is recreated (new hostname) makes the profile "in use by another
  computer": clear it as the instance's user before every start (the manager does).
- The supervisor joins the front's group (`setgroups`) to probe worker sockets (their directories are `0710 tenant:front`).
- Unix socket paths are ≤ ~104 bytes: tests use short temp dirs.
- Origins: when a port has a configured origin (`PUBLIC_ORIGIN` for the default port) the gateway tells the worker that
  scheme and host instead of the forwarded ones.
- The look follows Instagram (ARCHITECTURE.md §5): keep new UI on the existing tokens and the `Icon.tsx` outline icons;
  the Android client generates its icons from `Icon.tsx`, so add web icons there first.
- `.grow` has a later `min-width: 200px` rule (admin tables); use a dedicated class for flex spacers.
- Behind NPM `TRUST_PROXY` must equal the real hop count (gateway counts it; workers trust one hop: the gateway).
- Port ranges: `EXTRA_PORTS` must be one range for compose (`8101-8110`); the app and caddy's script accept lists too.
- `@fastify` rate limit is per process: the gateway and each worker count separately (login routes: 10/15 min per IP).
- Test users' passwords must not contain their username (policy); test ports must not collide with a running dev stack.
- `pkill -f <pattern>` inside a command containing the pattern kills your own shell: kill by pid.
- `npx` doesn't forward SIGTERM: spawn detached and kill the process group (fake-e2e does).
- Right after a tab (re)load Instagram Web's modules aren't ready: GraphQL waits for `getAsyncParams`, the inbox for
  the device id.
- Instagram renames queries and drops variables (e.g. relay providers): a `{data: null, errors}` answer or an HTML page
  usually means a changed doc id or variables — compare with the tab's own request.
