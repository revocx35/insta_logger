# insta_logger — Architecture

> Source of truth for design decisions. Read this (and `docs/instagram-notes.md`) before changing anything.
> If you change a decision, update this file in the same commit.

## 1. What it is

A self-hosted, Docker-based **Instagram direct-message logger** for one person or a few (multi-user since
2026-10-21: §3 "app container: supervisor, gateway, workers" and §6 "Multi-user isolation"), built from wa_logger
(same server core, crypto, auth, web UI and container design; the WhatsApp layer is replaced by an Instagram one). A real Chromium runs
Instagram Web in a background container. The app watches it through the Chrome DevTools Protocol and records **every
message, edit, reaction and media file** of the account's DMs, encrypted at rest. When someone unsends a message, the
logged copy stays viewable and is flagged.

The web UI looks like Instagram's DM view. It can also **send** as the account (text, replies, photos/videos/audio,
voice messages, reactions, edits, unsend). The live Chromium screen ("Instagram" in the menu) is where the owner logs in
and answers Instagram's checks — or the owner pastes a session from their own browser when Instagram keeps asking the
server's browser for a captcha.

Beyond DMs (added 2026-10-18, owner's requests): a **Reels** section (Instagram's reels feed played through the server,
like/unlike, comments and replies, share a reel into chats as its link), **story logging** (off by default: stories of
followed or chosen accounts saved encrypted for a chosen number of days, never marked as seen) and a background
**session refresh** (tab reload every N hours ± random). Everything Instagram sees comes from the server's browser and
IP, so the server can run in another country than the owner.

Clients: this web UI (responsive) and the native Android client
[insta_logger_android](https://github.com/revocx35/insta_logger_android) (separate repo, same API).

**Multi-user:** the first account is the admin; the admin creates more users in the web UI (name + temporary password)
and can give each their own port. Every user is a separate tenant: their own Instagram login (own Chromium, own
session), own encrypted database, own keys, own unix user. A user's data is invisible to the admin and to everyone
else. The admin sees names, status, ports and an admin log, never content. The web UI is shared; the native Android
client (insta_logger_android) is not updated for the extra screens yet (users are still separate accounts there).

Out of scope on purpose: calls, **several Instagram accounts for one user**, starting new chats, a full Instagram
client (feed, profiles, posting), and **view-once / allow-replay media** (logged as a placeholder, never downloaded —
wa_logger's policy).

## 2. User flow

1. **Signup** (`/signup`): only while no owner exists; needs `SETUP_TOKEN` from `.env`. Username + password (≥ 12).
2. **Recovery key** (`/setup/recovery`): shown once; the owner ticks "I saved it".
3. **Log in to Instagram** (`/setup/link`): the live Chromium screen (noVNC) with Instagram's login page and a status pill
   (`starting → login/challenge → syncing → ready`). The owner logs in there (2FA and "was this you?" checks too), or
   uses *Captcha keeps coming back? Log in with your own browser* (paste DevTools' "Copy as cURL", `POST /api/ig/session`).
   **Complete** is enabled once the state is `ready`/`syncing`.
4. **Main** (`/`): two-pane chat UI; menu rail **Chats**, **Reels**, **Stories**, **Unsent**, **Search**, **Instagram**,
   **Settings**, **Logout**.
5. Later visits: `/login` (or `/signup`), then `/` (or `/setup/link` if onboarding isn't complete).

**Other users (multi-user).** The admin opens *Users*, adds a user (username, optional temporary password, port) and hands
over the temporary password (shown once) and the address of that port. The user signs in with it and is **forced to
choose their own password** (`/api/auth/claim`; their keys are generated at that moment, so the admin, who knew the
temporary password, never held key material), saves their own recovery key, then logs **their own** Instagram in on
their own live screen (or pastes a session from their browser) and from there it is the normal experience. A forgotten
password is reset by the admin in one of two ways: *recovery* (new temporary password; the user proves they hold the
recovery key; the data stays) or *wipe* (all of the account's data, keys and browser profile are deleted and it starts
over). The admin can also disable, move to another port and delete users.


## 3. Containers & networks

```
                internet
                   │
          ┌────────┴────────┐   network: public (bridge)      ports 80/443 + EXTRA_PORTS published
          │      caddy      │   TLS termination (ACME or internal CA), HTTP→HTTPS; one site per extra port
          └────────┬────────┘
                   │ network: edge (internal: true)           :8080 = default; EXTRA_PORTS 8101-8110 = user ports
          ┌────────┴────────┐
          │       app       │   supervisor (root, 4 caps) ─┬─ gateway "front" (uid 10003)  the only listener
          │  (no internet)  │                              └─ worker per user (uid 10001 for the first account,
          │                 │   Node 24 · Fastify · puppeteer-core (CDP) · SQLite        10100+id for the others)
          └────────┬────────┘   volumes app_data:/data (first account) · app_users:/users (gateway DB + the others)
                   │ network: backend (internal: true)   tcp 9223 → chromium manager (bearer token per user)
          ┌────────┴────────┐
          │    chromium     │   manager (Go, root, 4 caps) ─ per user: Xvfb · Chromium (sandbox ON) · x11vnc,
          │                 │   each under that user's own unix user · volume chromium_profile:/data
          └────────┬────────┘
                   │ network: egress (bridge) → instagram.com / Meta CDNs
                internet
```

### app container: supervisor, gateway, workers
* **Supervisor** (`server/src/supervisor/`, the container's only root process; capabilities `SETUID SETGID CHOWN KILL`,
  nothing else, no network listener). It creates the directories, starts the gateway and one worker per tenant under that
  tenant's unix user (`spawn` with `uid`/`gid`, supplementary groups cleared), restarts them with backoff, and serves a
  one-line-JSON control protocol on `/run/igl/ctl/ctl.sock` (directory `root:front 0750`): `spawn`, `stop`, `remove`,
  `reset-browser`, `status`. Workers get a **minimal environment built from scratch** (no setup token, no control secret):
  their data directory, socket path, a random per-worker internal token, the Chromium manager URL and *their own* browser
  token. `remove` deletes a tenant's directories (emptied as that tenant: root has no DAC override) and asks the manager to
  delete its browser profile.
* **Gateway / front** (`server/src/front/`, uid 10003, `server/src/front.ts`): the only process that listens on the network.
  It owns the **system database** (`/users/system/system.db`: users, ports, admin log — no credentials, no data), serves the
  web UI, answers the routes that need to know *who is asking before there is a session* (`/api/state`, signup, login, claim,
  recover: it picks the worker by username) and the **admin API** (`/api/admin/*`), and forwards every other `/api` request
  and WebSocket upgrade to the signed-in user's worker over a unix socket. Which worker is decided by the **tenant cookie**
  (`__Host-igl_tenant`, a number set when the worker answers a sign-in with a session cookie). The tenant cookie is not a
  credential: pointing it at another tenant just makes that tenant's worker fail to find the session. It sets
  `X-Forwarded-For/-Proto/-Host` itself (client address by the `TRUST_PROXY` hop count, scheme/host from the configured origin
  of that port when there is one), drops every client `X-Forwarded-*`/`Forwarded`/`X-IGL-*` header, only forwards plain
  `/api/…` paths (no dot segments, doubled/encoded slashes, backslashes) and adds the worker's secret token.
* **Worker** (`server/src/index.ts` with `SOCKET_PATH`, one per tenant, uid per tenant): the former single-user app, unchanged
  in what it does — own SQLite database and media directory, own key ring, own puppeteer connection, own sessions, throttle
  and rate limits — listening on a unix socket `/run/igl/w/<id>/s.sock`. The socket's directory is owned by the tenant with
  group `front`, mode `0710`: only the tenant and the gateway can even reach it, and every request must carry the worker's
  token (`X-IGL-Internal`, constant-time compare, before anything else). The `/internal/*` routes (provision, info, signup,
  reset, revoke sessions, unlink) additionally need `X-IGL-Scope: internal`, which only the gateway's own calls carry.
  Workers have no `SETUP_TOKEN` and no public signup route.
* **Tenant 1** is the first account. Its data stays where the single-user releases kept it (`/data/insta_logger.db`,
  `/data/media`, uid 10001) and its browser profile stays `/data/profile` (uid 10002), so an upgrade finds everything in
  place: at startup the gateway asks worker 1 whether an owner exists and **adopts** it as the admin (`admin_adopted` in the
  admin log). Everyone else lives in `/users/<id>` (uid `10100+id`) and `/data/u<id>/profile` in the chromium volume.
  Ids come from an AUTOINCREMENT column and are never reused, so a deleted user's unix user and paths are never inherited.
* **Ports.** The default listener is `PORT` (8080). The admin opens extra ports (from `EXTRA_PORTS`, e.g. `8101-8110`,
  published by the caddy container, each forwarded 1:1 to the same port of the app) and assigns each user to one. Each port
  is its own `http.Server` around the same request handler; **the port a connection arrived on decides who may sign in**:
  a user signs in only on their port (users without one: the default port), the admin only on the default port, and a
  session is useless on any other port (checked on every request and upgrade, using the tenant cookie's user). Each extra
  port can carry the exact browser origin people use there (checked on state-changing requests and WebSocket upgrades;
  empty = derived from `Host`). This is how the admin's address can sit behind a login proxy such as authentik while a
  friend gets a separate address without one.
* Request flow for a signed-in user: browser → caddy → gateway (rate limit, Origin, port policy, tenant cookie) → worker
  (its own session, CSRF, throttle) → its Chromium through the manager.
* Two compose files: `docker-compose.yml` builds all three images from source (`Dockerfile`, `chromium/`, `caddy/`),
  and `deploy/docker-compose.yml` uses the images CI publishes to GHCR
  (`ghcr.io/revocx35/insta_logger-{app,chromium,caddy}`). The standalone variant only needs `seccomp-chromium.json` and
  `.env` next to it. The Caddyfiles are baked into the caddy image (compose `configs.content` cannot be used with
  `read_only`); the image's entrypoint (`caddy/extra-ports.sh`) writes one site per `EXTRA_PORTS` port to
  `/tmp/extra-ports.caddy`, which the Caddyfiles import.
* HTTP mode (`CADDY_CONFIG=Caddyfile.http`, `setup.sh --http-only`): Caddy serves plain HTTP behind the user's own
  TLS reverse proxy and trusts X-Forwarded-* from private ranges. The app uses `TRUST_PROXY=2` and
  `COOKIE_SECURE=auto`: `Secure`/`__Host-` cookies and HSTS whenever the request arrived over HTTPS.
  * Client IP (used by the login throttle): Nginx Proxy Manager *appends* the address it saw to the client's
    `X-Forwarded-For` (`$proxy_add_x_forwarded_for`), and Caddy, trusting NPM's private address, appends NPM's. The
    gateway trusts exactly `TRUST_PROXY` hops from the right (Caddy's socket + NPM's entry), so the client IP is the
    entry NPM appended, and anything a client puts in front of it is ignored. The gateway hands the workers that one
    address (they trust one hop: the gateway).
  * The hop count must match reality. Too low (`1` behind NPM): every client looks like NPM, and 5 failures lock the
    per-IP throttle for everyone coming through it. Too high: clients can pick their own IP. Another proxy in front of
    NPM (e.g. Cloudflare) makes it `3`.
  * Caddy trusts any private address, so a LAN host that reaches port 80 directly can claim any client IP and get
    around the per-IP limit (the global limit still applies). That's why the published ports in HTTP mode should be
    reachable only from the proxy. The extra ports are published on `EXTRA_BIND` (default `127.0.0.1`: set `0.0.0.0` or
    a LAN address only when the proxy for those users runs on another host, and firewall the range).
* Only **caddy** publishes ports. The **app** has no route to the internet (it sits only on internal networks).
  **chromium** is the only component that talks to Instagram.
* The chromium manager (below) is the only way to a browser: CDP and VNC are never exposed. Each request carries the
  bearer token of one instance, derived as `HMAC-SHA256(CONTROL_SECRET, "igl/chromium/instance/<id>")`; only the
  supervisor and the manager know `CONTROL_SECRET` (it falls back to `VNC_PASSWORD` for `.env` files from before user
  management). A worker is handed its own token only.
* Hardening on every container: `no-new-privileges`, `cap_drop: [ALL]` (caddy re-adds `NET_BIND_SERVICE`; app and chromium
  re-add `SETUID SETGID CHOWN KILL` for their root supervisor/manager, which hand nothing on to what they start),
  `read_only` root filesystems with explicit tmpfs mounts, memory and pid limits, healthchecks. This replaces "non-root"
  for the two containers that must run one process per user under different unix users: the root process is small, has no
  network listener of its own (the manager's is token-checked) and starts everything else without capabilities.
* Chromium keeps its **sandbox enabled**. Docker's default seccomp profile blocks the user-namespace syscalls
  the sandbox needs, so `chromium/seccomp-chromium.json` (Docker's default profile plus `clone`, `clone3`,
  `unshare`, `setns`, `chroot` and similar) is applied. **Never ship `--no-sandbox`.** It is available only as an
  explicit escape hatch (`CHROMIUM_NO_SANDBOX=1`) with a startup warning.

### chromium container
* `entrypoint.sh` validates the environment, makes the volume root `root:root 0711` (traversable, not listable; each
  user's directory below is `0700` and theirs) and starts the **manager** (`chromium/manager/`, Go, standard library
  only, built and tested in the image's first build stage). It answers `/healthz` on loopback at once and listens on its
  address on the network shared with the app (`BACKEND_PEER`, default `app`) as soon as that exists (the address must lie
  in one of its own subnets, so a name that resolved to some public address is never used). `LISTEN_ADDR` overrides.
* **Per user** (`instance.go`), all started on demand by `POST /i/<id>/ensure` and kept alive (restart after 2 s):
  `Xvfb :100+id -nolisten tcp -nolisten local -auth <Xauthority>` (filesystem socket only, MIT cookie in the user's
  private run directory), `chromium --user-data-dir=<profile> --remote-debugging-port=<free loopback port> --kiosk
  --ignore-gpu-blocklist …` (the same flags as the single-user entrypoint, WebGL included) and `x11vnc` on a free
  loopback port with a random per-start password. Each runs as `uid 10100+id` / own gid (tenant 1: 10002, profile
  `/data/profile`), with an environment built from scratch (no secrets), `HOME=/home/chrome/u<id>`, `TMPDIR=/tmp/u<id>`;
  directories are `0700`. Stale profile locks and X sockets are removed *as that user* (root has no DAC override).
* **API** (`server.go`, every route `/i/<id>/…` needs that instance's token or the admin token): `ensure`, `restart`,
  `DELETE /i/<id>` (admin token: stop everything and delete the profile), `GET vnc-password`, `GET vnc` (an HTTP
  `Upgrade: igl-tunnel` raw byte tunnel to x11vnc, wrapped into a WebSocket by the tenant's worker), and the DevTools relay
  `GET cdp/json/version`, `GET cdp/json/list` (the tab list insta_logger reads while logged out) and the single browser
  WebSocket `cdp/devtools/browser/<uuid>` (page-level endpoints, `/json/new`, `/json/close` and the inspector are not
  relayed). `MAX_INSTANCES` (= `MAX_USERS`) caps the browsers.
* The healthcheck calls `curl -fs http://127.0.0.1:9223/healthz`.
* The profile volume **contains the live Instagram logins** (cookies). Anyone with it can use the accounts.
* Managed policy (`chromium/policies.json`): navigation only to `instagram.com`, `cdninstagram.com`, `facebook.com`,
  `fbcdn.net`, `fbsbx.com` (login, 2FA and consent pages and media need them), plus only the reCAPTCHA paths
  `www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`, `www.recaptcha.net/recaptcha/` (Instagram's login captcha
  is reCAPTCHA Enterprise in a `www.fbsbx.com/captcha/recaptcha/iframe/` frame; blocked, it shows only a grey icon).
  This Chromium blocks third-party cookies by default; `CookiesAllowedForUrls` allows them for Google (reCAPTCHA) and
  Meta (`facebook.com`, `fbsbx.com`) frames only when the top-level page is `https://www.instagram.com`. Without the
  `_GRECAPTCHA` cookie a solved captcha is rejected and Instagram sends you back to the login page. No downloads,
  file pickers, printing, password manager, sign-in, sync, extensions, notifications, geolocation, camera or microphone.
* **Looking like a normal browser.** Instagram's login runs an "anti-scripting" check that keeps asking for a captcha
  when the browser looks automated. So: WebGL through Mesa's software renderer (`--ignore-gpu-blocklist`, Xvfb GLX;
  WebGL renderer "ANGLE (Mesa, llvmpipe …)" like a Linux PC without a GPU driver; without it there was no WebGL at all),
  the server's time zone (`TZ` from `.env`, written by setup.sh), and no debugger attached to the tab while it is logged
  out (§ 5, "Hands off while logged out").
* Residual risk (also in §6): all browsers share the container's network namespace. A renderer exploit stays inside
  Chromium's sandbox (which has no network); a full sandbox escape as uid N could reach the other browsers' loopback
  DevTools ports. Separate containers per user would close that, at the price of a Docker-socket orchestrator.

## 4. App (server) — `server/`

Node 24 LTS, TypeScript (ESM), Fastify 5, better-sqlite3 (WAL), zod, puppeteer-core (CDP only; no browser download).
Tests use vitest.

```
server/src/
  index.ts            the tenant WORKER: config → db → crypto keyring → http (unix socket) → ig (only once an owner exists)
  front.ts, front/    the GATEWAY: system DB (users, ports, admin log), listeners per port, proxy to workers, admin API
    gateway.ts          Fastify app, port/tenant policy, streaming proxy + WebSocket tunnel, response relay (tenant cookie)
    auth.ts             /api/state, signup (admin), login/claim/recover routed by username
    admin.ts            /api/admin/*: overview, create/update/reset/delete users, ports, admin log
    proxy.ts            HTTP over the worker's unix socket; forwarding-header policy
    pool.ts             talks to the supervisor's control socket · listeners.ts: the open ports · db.ts: system DB
  supervisor/         the SUPERVISOR (root, 4 capabilities): directories, gateway + worker processes, control socket, tokens
  api/internal.ts     worker routes only the gateway may call (provision, info, signup, reset, revoke, unlink)
  config.ts           zod-parsed env (§9); fails fast on bad config
  log.ts              pino with redaction (cookies, auth headers, passwords, tokens, message bodies)
  db/                 connection, migrations (schema §7), repositories
  crypto/             AES-256-GCM, HKDF, X25519 ECDH, scrypt; keyring (DEKs, ECIES, field encryption); chunked media files
  auth/               signup, login, logout, recovery, TOTP, password; sessions; throttle
  http/               server factory, security headers/CSP, static web UI, error handler, ZIP streaming
  api/                chats, messages, media (Range, ZIP), search, unsent feed, SSE, settings, audit, wipe, sending
  vnc/                authenticated WebSocket ↔ the tenant's x11vnc, through the manager's tunnel
  ig/
    service.ts        IgService: connects to Chromium, keeps one Instagram tab on the inbox, login/challenge detection,
                      watchdog, reconnects, timers (reconcile, avatars), applies deltas in order
    chromium.ts       ChromiumLink: this tenant's browser through the manager (ensure, CDP relay, VNC tunnel)
    browser.ts        tab choice, URL classification (inbox/thread/login/challenge)
    loginwatch.ts     while logged out: tab list + cookie jar (browser-level CDP through the manager) without attaching;
                      opens/reloads the login page with a one-command attach; decides when to attach (pure, tested)
    page.ts           IgPage: own CDP session on the tab — reads the stream (Network.webSocketFrameReceived, also in
                      workers), learns doc ids + headers from the tab's GraphQL requests, runs GraphQL inside the page,
                      downloads files through the browser (Network.loadNetworkResource + IO.read), login cookies check
    dgw.ts            stream decoding: DGW frames → JSON envelope → LSResponse protobuf → Slide delta JSON (pure)
    docs.ts           GraphQL document ids: defaults + ids learned from the tab (persisted)
    api.ts            IgClient: inbox, inbox pages, thread, message pages, send text/media, react, edit, unsend, seen,
                      Mercury upload (chunked into the page first)
    types.ts          the Slide JSON fields used (loosely typed: Instagram changes shapes)
    mapper.ts         Slide message → rows (pure, unit-tested): types, albums split per photo/video, shares, quotes,
                      mentions, reactions, edit history, view-once policy, media links
    ingest.ts         deltas/threads/messages → encrypted rows (idempotent upserts); unsend/edit/reaction/seen/folder;
                      MediaSources (signed links, memory only); markMissing (gone while away)
    sync.ts           history import (paged, paced) and reconcile (re-read moved chats, catch up, flag missing);
                      refetchAround (fresh media links)
    media.ts          priority download queue (live > history), retries/backoff, disk guard, encrypted storage
    sender.ts         Sender: send API (hourly cap, audit, error mapping, stores own uploads as media)
    avatars.ts        chat pictures from URLs Instagram already sent, fetched by the browser
  testutil/           harness (in-process app + cookie client), igfixtures (Slide JSON + FakeIg), seed (dev data)
shared/api.d.ts       API DTO types shared by server and web (type-only)
```

### Instagram integration rules
* **One tab.** `pickInstagramTab` reuses an Instagram tab (or a blank one) and closes other Instagram tabs; after loading,
  every other tab is closed and the Instagram tab brought to the front (VNC shows it).
* **Attach before loading.** IgPage attaches its CDP session (Network enabled) *before* navigating/reloading, so the
  stream socket's `webSocketCreated` is seen. Sockets opened earlier are recognised by trial-decoding their frames.
* **The tab stays on `/direct/inbox/`.** Right after login (feed, "save login info?") it is sent there at once;
  elsewhere (owner browsing over VNC, an open thread that would send "Seen") after 2 minutes. Login and challenge pages
  are left alone: the owner answers them over VNC (state `login` / `challenge`; the UI shows a banner).
* **Hands off while logged out** (`loginwatch.ts`). Puppeteer enables the Runtime domain in the page and in every frame
  (also the reCAPTCHA frames), which pages can detect; Instagram's login then kept asking for a captcha. So when the
  tab is (or goes to) a login/challenge page, or there is no session, the app disconnects puppeteer and only *looks*:
  every 3 s it reads `/json/list` (HTTP) and `Storage.getCookies` over a short browser-level connection. Nothing is
  attached to the tab, except for single `Page.navigate`/`Page.reload` commands (open the login page from a blank or
  stray tab; reload a login page once on (re)start). It attaches again once `sessionid` + `ds_user_id` exist and the tab
  has left the login/challenge pages. The fake e2e checks `Target.getTargets().attached === false` while logged out.
* **Story logging** (`ig/stories.ts`, `api/stories.ts`, `web/src/pages/Stories.tsx`; off by default). Every
  `storyCheckMinutes` (15–720, default 45; ± random ≤ a quarter of it, at most 10 min, `storyDelay`); whose stories:
  everyone followed or only `storySelected` (`storyAccounts`; `GET /api/stories/accounts` lists every account seen in
  the stories bar for picking; accounts unseen for 30 days without stories are forgotten) the stories bar is read (`GET /api/v1/feed/reels_tray/`, live videos and the
  owner's own reel skipped); authors with stories newer than `story_users.last_reel_at` (or unfinished downloads from
  the last 24 h) get their items from `PolarisStoriesV3ReelPageStandaloneQuery` (≤ 10 authors per request, ≥ 1.5 s
  apart, ≤ 150 authors per check). The largest photo / video version is downloaded through the browser into an
  encrypted media file (`kind 'story'`), with ≤ 3 attempts; avatars refreshed daily. Usernames/names are encrypted
  (`F.storyUsername/storyName`). Nothing is marked as seen. Retention: stories posted more than
  `storyRetentionDays` ago are deleted with their files (also when logging is off); authors without stories go too.
  Tables `story_users`, `stories` (migration 2); wiped with the rest of the logged data.
* **Reels section** (`igweb/`, `api/reels.ts`, `web/src/pages/Reels.tsx`). `GET /api/reels?cursor=` runs Instagram
  Web's own reels query (`PolarisClipsTabDesktopPaginationQuery`, variables copied from its /reels/ page, already-shown
  reels passed as `seen_reels`) inside the tab, paced (one at a time, ≥ 500 ms apart). Videos and pictures: the server
  replaces every CDN link with an opaque ref (`MediaRefs`, memory only, 6 h), fetches it through the browser on request
  (`GET /api/reels/media/:ref`, ≤ 40 MB, 128 MB in-memory cache, Range support, `sandbox` CSP). Preloading: the first
  4 videos of every reels page are fetched into the cache right away (`MediaRefs.prefetch`); the web page renders the
  next 3 reels with `preload="auto"` and the Android app requests their first bytes, which makes the server cache them. Nothing of it is stored
  or logged. "Send" posts the reel's link (`https://www.instagram.com/reel/<code>/`) through the normal send route;
  Instagram shows it as a reel card. Comments are read over REST (`IgPage.rest`: `/api/v1/media/<id>/comments/`,
  with the first replies); likes, unlikes, comments and replies use Instagram Web's own mutations
  (`usePolarisLikeMediaXIGLike/UnlikeMutation`, `PolarisPostCommentInputRevampedMutation`), variables captured from
  its pages with the requests stopped inside the browser (docs/instagram-notes.md "Reels").
  Nothing of the reels is written to the database.
* **Logging in with the owner's own browser** (`ig/cookies.ts`, `POST /api/ig/session`). When Instagram's login keeps
  looping on its captcha (first real login, 2026-10-18), the owner logs in on their own computer and pastes DevTools'
  "Copy as cURL" (or a Cookie header / JSON export). Only Instagram's cookie names are kept (`sessionid` and
  `ds_user_id` required, the session must start with that account id); values must be printable ASCII without `;`.
  They go into the cookie jar with `Storage.setCookies` (browser-level: `.instagram.com`, Secure, `sessionid` HttpOnly),
  the tab is sent to the inbox, and the login watch attaches once Instagram accepts the session. The pasted text is a
  credential: never logged (errors are generic and name at most the cookie), never stored outside the Chromium profile.
* **Logged in** = `sessionid` and `ds_user_id` cookies present for the Instagram origin (values never logged) and not on
  a login/challenge URL. The account: `CurrentUserInitialData.IG_USER_EIMU` (messaging id = sender id of own messages),
  `PolarisViewer.data` (Instagram id, username, name), `IGDMqttWebDeviceID.clientId` (needed by the inbox query);
  stored as `app_state.ig_me` (ids only) and an `is_me` contact. Another account logging in re-reads it.
* **Live events** come only from the stream (§ docs/instagram-notes.md "Stream"). Deltas that arrive before the account
  is known are buffered (≤ 5000) and applied right after. All deltas are applied strictly in order (one promise chain).
* **History/reconcile/sending** use Instagram Web's own GraphQL requests, executed *inside the page* with
  `require('getAsyncParams')('POST')` (+ `DTSGInitData.token`, `LSD.token`, `csrftoken` cookie), the doc id from
  `DocIds`, headers learned from the tab, `x-fb-friendly-name`. Answers (`for (;;);` prefix stripped, several JSON lines
  merged) are parsed with exact big integers. Logged-out answers (`error 1357001`, redirect to login) → state check.
* **Media links** are signed and expire: kept in memory (`MediaSources`, ≤ 20 000). After a restart, or when the CDN
  answers 403/404/410, `refetchAround` asks Instagram for the page containing the message (`older_than_message_id` = the
  next logged message) and the queue retries once; then `unavailable`.
* **Unsend** (`SlideUQPPDeleteMessage`) flags the row and its album parts (`deleted_by = 'sender'`). **Reconcile** flags
  logged messages missing from a complete re-read window (`deleted_by = 'missing'`); disappearing, view-once, system
  and < 60 s old rows are never judged; the window reaches the chat's start only when Instagram explicitly says there
  is nothing older on a short page.
* **Pacing:** history and reconcile wait `IG_REQUEST_GAP_MS` (1.5 s) between requests; reconcile reads at most 2 inbox
  pages and re-reads only chats whose activity moved (+ the 10 newest), ≤ 5 pages each.
* **Health:** a 10 s state check probes the page (3 failures → reconnect); no stream frame at all for 20 min while ready →
  reload the tab + reconcile; a resnapshot/failure operation from the stream → reconcile after 30 s.

### Sending
* `api/send.ts` → `ctx.ig.sender` (`ig/sender.ts`) → `IgClient` → GraphQL mutations in the page:
  `IGDirectTextSendMutation` (`ig_thread_igid`, `text.sensitive_string_value`, `reply_to_message_id`),
  `IGDirectMediaSendMutation` (`attachment_fbid` from a Mercury upload), `IGDirectReactionSendMutation`
  (`reaction_status` created/deleted — removal needs the emoji, which the route decrypts from the owner's reaction),
  `IGDirectEditMessageMutation`, `IGDMessageUnsendDialogOffMsysMutation` (needs the **long** thread id, `chats.thread_id`),
  `useIGDMarkThreadAsReadMutation` ("Seen", only on reply or with the readReceipts setting).
* Files: `POST /api/uploads` (raw body, 64 MB, 4 pending, 10 min, session-bound, memory only) → `send-media`
  (`auto` | `voice`; only image/video/audio). The bytes go into the page in 1 MiB chunks and are uploaded as multipart
  `farr` to `/ajax/mercury/upload.php` (`voice_clip=true` for voice); the attachment id is read from the answer *text*
  (ids exceed 2^53). Instagram has no captions: text typed with a file is sent as its own message after it.
* Own uploads are stored from the uploaded bytes (`storeSentMedia`); the media queue skips those rows meanwhile.
* Limits: route rate limits plus 200 sends/hour; audited as `message_sent` (type only). Text ≤ 1000 characters.
* Not verified against the live Instagram yet (only against the fake): voice messages and the Mercury answer shape.

## 5. Web UI — `web/`

React 19 + Vite + TypeScript SPA, built into the server's static assets. No CDN, no external fonts, no inline scripts
(strict CSP). `@novnc/novnc` for the Instagram screen, `qrcode` for TOTP enrollment, `@fontsource/grand-hotel` for the
script wordmark (bundled, served from `'self'`; SIL OFL, `third_party/GrandHotel-OFL.txt`).

**Look:** styled after Instagram's own app and web UI (2026-10-27). `styles.css` tokens follow Instagram's (white/black,
`#efefef`/`#262626` secondary, `#0095f6` buttons, `#ff3040` likes, 14 px base, 8 px flat buttons). `components/Icon.tsx`
holds outline icons on a 24 px grid with a 2 px round stroke (the Android client generates its `WaIcons` from them).
Layout (`pages/MainLayout.tsx`): Instagram's sidebar — 244 px with the wordmark on wide screens, 73 px icons only under
1264 px and on Messages/Reels — with "More" (Unsent, Instagram, Users, Settings, log out); under 768 px a bottom tab bar
(Messages, Search, Reels, Stories, More → bottom sheet). The DM list (account name as title, "Messages · Requests",
chips, 56 px avatars, "preview · 2h"), joined bubble runs, a rounded composer with a text "Send", bare photos/videos,
the reels page with right-hand actions and a double-tap heart, the stories tray (gradient rings) + archive grid (date
boxes) + viewer with progress bars and auto-advance (photos 5 s).

Routes: `/signup`, `/login`, `/recover`, `/setup/recovery`, `/setup/link`, `/` (chats), `/chat/:chatId`, `/reels`,
`/stories`, `/deleted` ("Unsent"), `/search`, `/instagram`, `/settings`. A route guard uses `GET /api/state`.

Reels (`pages/Reels.tsx`): vertical snap-scroll, one playing video, refresh, like (double-click too), comments sheet
with replies, share sheet (chat picker). Stories (`pages/Stories.tsx`): status + *Check now*, account rings with
counts, grid, full-screen viewer. Settings → Logging also holds the session refresh and story options (interval,
retention, everyone / chosen accounts with a picker). `components/SessionImport.tsx`: the cookie-paste login panel.

Chat view: date separators; sender names (+ @username) in groups; text rendered by `lib/igText.tsx` (links and
@mentions only, never HTML; line breaks kept; emoji-only messages large); quoted replies (click to jump); forwarded
label; edited badge with history; unsent badge ("Unsent · time · logged copy" or "Gone from Instagram · noticed …");
reactions; "Seen" for own messages; photos (lightbox), videos/GIFs, voice messages, music previews, stickers; shared
posts as cards (kind, title, caption, link out) with their preview image; album position; disappearing timer icon;
view-once placeholder; select photos/videos → one ZIP; infinite scroll; SSE live updates; per-chat and global search;
composer (text, reply, edit, photo/video/audio, voice recording as MP4 or Ogg/Opus). Instagram-like theme (screen-tall
purple→blue gradient own bubbles, grey incoming), light and dark, single pane under 768 px.

## 6. Security model

**Threats considered:** internet attackers reaching the login page, CSRF/XSS against the owner's browser,
malicious message content (HTML/SVG/scripts inside messages or media), theft of disk or backups,
lateral movement between containers, brute force, hostile data from the Instagram tab, abuse of sending, and the
owner's pasted Instagram session (a credential: only owner-authenticated + CSRF, size-capped, whitelisted cookie
names, never logged).

**Accepted / out of scope:** a fully compromised running host (it can read process memory and the live Instagram
login), and Instagram's terms of use (automated browser; restriction risk is the user's decision).

### Authentication
* Single owner. Signup is closed permanently once an owner exists and requires `SETUP_TOKEN`
  (constant-time compare, rate limited).
* Password: min 12 characters, max 256, rejected if it matches the username or a small common-password list.
  `master = scrypt(pw, salt32, N=2^17, r=8, p=1, 32B)`, `authHash = HKDF(master, "igl/v1/auth")` (stored),
  `KEK = HKDF(master, "igl/v1/kek")` (never stored).
* Optional TOTP (RFC 6238, SHA-1, 6 digits, ±1 step, replay-protected by storing the last used step). The secret is
  encrypted with a key derived from the KEK, so it is only readable after a correct password.
* Recovery key: 32 random bytes shown once as Base32 groups. It wraps a second copy of the private key
  (`HKDF(scrypt(recoveryKey, salt), "igl/v1/recovery-kek")`). Recovery = recovery key + new password.
  It disables TOTP and rotates the recovery key.
* Brute force (`auth/throttle.ts`): every credential check (login, TOTP, password re-entry, recovery) is
  *charged before* scrypt runs, synchronously, so parallel requests cannot race past a lock. The lock is **per IP**
  (after 5 failures: 30 s … 1 h exponential), so one attacker's failures don't lock the owner's IP. It is backed by a
  **global** per-account counter in the DB (after 50 consecutive failures from any IPs: one attempt per 30 s … 15 min).
  Anyone who can reach the login can keep that global lock engaged, which delays the owner's password logins too;
  existing sessions keep working, and recovery (256-bit key) only uses the per-IP limit and resets the global counter.
  Route rate limits come on top. All auth events go to `audit_log`.
* TOTP codes are consumed atomically (`UPDATE … WHERE totp_last_step < step`), so a code works once even in
  parallel requests. Enabling 2FA needs the password (a stolen session alone can't lock the owner out). Wipe and
  recovery-key rotation need the password **and** the 2FA code when 2FA is enabled.
* After password changes, recovery, 2FA changes and session revocation, the SQLite WAL is checkpointed and
  truncated (`secure_delete=ON` zeroes freed pages), so superseded key wraps don't stay on disk.

### Multi-user isolation
* **A tenant is a unix user with its own directories, database, keys and browser.** The gateway owns only the user list
  (names, ports, disabled flag); it never holds a key or a piece of message data. Nothing is shared between tenants: no
  files, no sockets, no secrets, no database, no browser profile.
* **Only the gateway listens on the network.** Workers listen on a unix socket in a directory `tenant:front 0710`, so a
  worker cannot even reach another worker's socket. Every request must carry the worker's random `X-IGL-Internal` token
  (constant-time compare in an `onRequest` hook, before routing); the `/internal/*` routes need `X-IGL-Scope: internal`
  as well, which the gateway only adds to its own admin calls, never for a client. The gateway strips every client
  `X-IGL-*` and `X-Forwarded-*` header and sets its own.
* **The tenant cookie is a routing hint, not a credential.** It names the tenant; the worker still validates the session
  cookie against its own database, so a forged or copied tenant cookie gives nothing (and a session of user A pointed at
  user B's worker is simply unknown there).
* **Port pinning.** A session only works on the port its user may use (admin: the default port only). The gateway checks
  this on every request and WebSocket upgrade, and an admin moving or disabling a user closes that user's open streams.
* **Admin actions are audited and re-authenticated.** Destructive actions (reset, delete) require the admin's password
  and, when enabled, the 2FA code. The admin log stores names, events, IPs and short details — never passwords, keys,
  message content or media.
* **The admin never sees user content.** The admin API exposes names, status (pending/active/disabled), the Instagram
  connection *state* (a short enum) and the port — not chats, messages, contacts or media. A compromised admin account
  can delete or reset users (denial of service) and take over their *accounts* (new password + wipe), but cannot read
  what was logged: the data keys are wrapped by the user's own password/recovery key.
* **Residual risk.** All browsers share the chromium container's network namespace (see §3); and the app container's root
  supervisor is trusted (it starts every worker and could read a tenant's memory). Both are trusted components, kept
  small: the supervisor has no listener and parses only its one-line control protocol.

### Sessions
* Cookie `__Host-igl_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`). Value is
  `b64url(sid32).b64url(secret32)`. The DB stores `sha256(sid)` and the owner private key encrypted under
  `HKDF(secret, "igl/v1/session")`. **A DB dump without a live cookie cannot decrypt anything.**
* Idle timeout `SESSION_IDLE_HOURS` (default 8) and absolute `SESSION_MAX_DAYS` (default 7). Sessions can be listed and revoked, including "log out everywhere".
  A password change revokes all other sessions.
* `COOKIE_SECURE=false` (dev/HTTP only) drops the `__Host-` prefix and `Secure`, and logs a loud warning.

### CSRF / request integrity
* "Is this an API request?" is decided from the **matched route** (`req.routeOptions.url`), never the raw URL.
  The router percent-decodes paths, so `/%61pi/...` must not skip the auth hook. A second `preHandler` layer
  re-checks the session for every matched non-public `/api` route. Absolute-form request targets are rejected.
* Requests whose TCP peer is the Chromium container are refused. Chromium shares the backend network with the
  app, but must never talk to the app.
* Every non-GET `/api` request must have `Content-Type: application/json` and an `Origin` that matches `PUBLIC_ORIGIN`
  (or the request `Host` when that is unset). Authenticated non-GET requests must also carry
  `X-CSRF-Token = HMAC(HKDF(secret,"igl/v1/csrf"), "csrf")`, which `GET /api/state` returns.
* The WebSocket (`/api/vnc`) and SSE (`/api/events`) require a valid session cookie and a matching `Origin`.

### Data from the Instagram tab
* The page (Instagram Web, or whatever runs in that tab) can feed the app arbitrary stream frames and GraphQL answers.
  All of it is untrusted: frames above 8 MB are ignored, the DGW/protobuf/JSON decoder never throws on garbage, ids are
  validated by pattern before they become keys or URL parts (chat ids `[A-Za-z0-9_-]{1,64}`, message ids without
  whitespace or `/?#%~`, account ids digits), JSON is parsed with exact big integers, content is stored encrypted and
  rendered as text only.
* Media is fetched **only** from `https` URLs on Instagram/Meta CDN hosts (`cdninstagram.com`, `fbcdn.net`,
  `instagram.com`, `fbsbx.com`), by the browser (`Network.loadNetworkResource`, no cookies sent), with a size cap and
  timeouts; Content-Type is only trusted when it is a known media type.
* Instagram's signed media links are bearer links to private files: they live in memory only (`MediaSources`), never
  in the database or logs, and are dropped after the download.
* Instagram tokens (`fb_dtsg`, `lsd`, the `csrftoken` cookie) never leave the tab: GraphQL requests are built and sent
  inside the page; only a few non-secret-ish headers (`x-ig-app-id`, `x-asbd-id`, …) are copied in memory.
* The tab is kept on the inbox; after two minutes elsewhere (an open conversation would send "Seen") it is sent back.

### Encryption at rest (envelope, public-key)
The logger writes while the owner is logged out, but must not be able to read old data without the owner.
* At signup: an X25519 keypair. The public key is stored in plaintext. The private key (PKCS8) is AES-256-GCM encrypted under the
  password KEK and, as a second copy, under the recovery KEK.
* **DEK (data key):** random 32 bytes, created at each process start and rotated every 24h. It is wrapped with ECIES
  to the owner's public key (ephemeral X25519 → ECDH → `HKDF(shared, salt=ephPub‖ownerPub, "igl/v1/dek")` →
  AES-256-GCM) and stored in `data_keys`. Only the current DEK is kept in memory for writing.
* **Fields:** `0x01 ‖ keyId(u32be) ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, AES-256-GCM with
  AAD = `"igl/v1|<table>|<column>|<rowId>"` (this stops ciphertexts from being swapped between rows or columns).
* **Media files:** header `"IGL1" ‖ version ‖ keyId(u32be) ‖ noncePrefix(8)`, then 64 KiB plaintext chunks, each
  AES-256-GCM with nonce = `prefix ‖ u32be(chunkIndex)` and AAD = `"igl/v1|media|<mediaId>|<chunkIndex>|<final?>"`.
  This enables HTTP Range requests (decrypt only the needed chunks) and detects truncation or reordering.
  Files are stored as `/data/media/<2 hex>/<uuid>.bin` (random names, no plaintext hashes).
* **Reading:** a session request unlocks the private key (with the session secret from the cookie) and unwraps the needed
  DEKs. Unwrapped DEKs and private keys are cached in memory for at most 10 minutes and cleared on logout,
  password change and wipe.
* **Encrypted:** message bodies, `meta` JSON (quoted snapshot, shared post title/caption/link, music, mentions, unknown
  content type names), edit history, reaction emoji, chat names, contact names and usernames, and all media (including
  avatars) with their mime type and filename.
* **Plaintext (metadata):** Instagram thread/message/account ids, the long thread id, timestamps, message types, flags
  (unsent/edited/fromMe/forwarded/view-once), album position, disappearing-message expiry, seen state, chat folder,
  pinned/muted, and media sizes/dimensions. Documented. Host full-disk encryption is recommended.
* A password change re-wraps only the private key (cheap). A lost password plus a lost recovery key means **the data is gone by design**.

### HTTP hardening
* CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:;
  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
* HSTS (when secure), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`
  (powerful features disabled; microphone for our own origin: voice messages), `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on `/api/*`.
* Media responses: a fixed allowlist of inline-safe MIME types (raster images excluding SVG, audio/*, video/*).
  Everything else is served as `application/octet-stream` with `Content-Disposition: attachment` and a
  `Content-Security-Policy: sandbox; default-src 'none'` response header. Filenames are sanitized.
* Message text is never rendered as HTML. Links get `rel="noopener noreferrer nofollow"` and `target=_blank`.
  No link previews are fetched.
* zod validates every body, query and params. Errors are generic, and internal details are logged with a
  request ID and never returned to the client.
* Logs never contain message content, names, cookies or secrets (pino `redact` plus a code discipline enforced by review).

## 7. Databases

Two SQLite databases, both WAL, `foreign_keys=ON`, `secure_delete=ON`:

* **Tenant database** — `/data/insta_logger.db` for the first account, `/users/<id>/insta_logger.db` for the others;
  owned and opened only by that tenant's worker.
* **System database** — `/users/system/system.db`, owned by the gateway (uid 10003): `users(id AUTOINCREMENT, username
  UNIQUE, role admin|user, disabled, port, created_at, last_login_at)`, `listeners(port, public_origin)`, `audit(...)`.
  No credentials, no keys, no content.

### Tenant database (per user)

```sql
owner, sessions, audit_log, app_state, data_keys, media   -- as in wa_logger (auth, keys, encrypted media files)
chats(id TEXT PRIMARY KEY /* thread_fbid */, kind /* user|group */, thread_id /* long id */, peer_id, name_enc,
      last_ts, folder /* NULL = inbox */, pinned, muted, removed_at, avatar_media_id, avatar_checked_at, created_at, updated_at)
contacts(id TEXT PRIMARY KEY /* messaging id */, ig_id, username_enc, name_enc, is_me, is_verified,
         avatar_media_id, avatar_checked_at, updated_at)
messages(id TEXT PRIMARY KEY /* message_id, album parts "<id>~n" */, alt_id, chat_id, sender_id, from_me, ts, type,
         body_enc, meta_enc, quoted_id, media_id, media_status, media_attempts, media_size, media_w, media_h,
         media_duration, album_index, album_count, is_view_once, is_forwarded, expires_at, ack, deleted_at, deleted_by,
         edited_at, last_edit_key, source, captured_at, updated_at)
  INDEX (chat_id, ts), (deleted_at), (media_status='pending'), (media_id), (alt_id)
message_edits(id, message_id, body_enc, captured_at)
reactions(message_id, sender_id, emoji_enc, ts, removed_at, PRIMARY KEY(message_id, sender_id))
-- migration 2 (story logging)
story_users(id TEXT PRIMARY KEY /* Instagram user id */, username_enc, name_enc, avatar_media_id, avatar_checked_at,
            last_reel_at /* newest story time fully captured */, updated_at /* last seen in the stories bar */)
stories(id TEXT PRIMARY KEY /* story media id */, user_id, type /* image|video */, taken_at, expires_at, media_id,
        status /* pending|downloaded|failed|too_large */, attempts, captured_at)
  INDEX (taken_at), (user_id, taken_at)
-- migration 3 (multi-user): an admin-issued temporary password (mode 'new': the account has no owner row yet;
-- mode 'reset': the owner row is kept and the data stays). It guards the account until the user claims it.
pending_claim(id CHECK (id = 1), username, mode /* new|reset */, salt, auth_hash, failed_logins, locked_until, created_at)
```
Migrations in `server/src/db/db.ts` (append-only). Bodies and edit history share the AAD context `msgbody|<id>`.
`app_state` keys: `settings`, `onboarding_complete`, `initial_sync_done`, `ig_me`, `ig_doc_ids` (`{name: {id, base}}`:
a learned id is dropped when the code's default changed since). Media `kind`: `message`, `avatar`, `story`.
Story usernames/names use AAD contexts `story_users|username|<id>` / `story_users|name|<id>`.

## 8. HTTP API (JSON; DTO types in `shared/api.d.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/state | – | `{hasOwner, authenticated, onboardingComplete, csrfToken?, ig?}` |
| POST | /api/auth/signup · login · logout · logout-all · recover · password | | as in wa_logger |
| GET/DELETE | /api/auth/sessions[/:id] | ✓ | list / revoke |
| POST | /api/auth/totp/setup · enable · disable · /api/auth/recovery-key/rotate | ✓ | TOTP, recovery key |
| GET | /api/ig/status | ✓ | `IgStatus` |
| POST | /api/ig/restart · /api/ig/logout | ✓ | reload the tab / log the browser out of Instagram |
| GET | /api/stories/status · /api/stories/accounts · /api/stories/authors · /api/stories?user=&before=&limit= | ✓ | `StoryStatus` · `StoryAuthor[]` · `StoryPage` (newest first; media via /api/media/:id) |
| POST | /api/stories/check | ✓ | check for new stories now (6 per 10 min) |
| GET | /api/reels?cursor= · /api/reels/media/:ref | ✓ | reels feed page (`WebPage<WebPost>`) · a reel's video/picture |
| GET · POST | /api/reels/:id/comments · /api/reels/:id/like · POST /api/reels/:id/comments | ✓ | comments page · `{like}` · `{text}` (≤ 2200) |
| POST | /api/ig/session | ✓ | `{cookies}`: log in with a session from the owner's own browser (cURL / Cookie header / JSON); 409 when logged in |
| POST | /api/onboarding/complete | ✓ | requires state ready/syncing |
| GET / WS | /api/vnc/credentials · /api/vnc | ✓ | noVNC password · bridge to chromium:5900 |
| GET | /api/chats | ✓ | `ChatSummary[]` |
| GET | /api/chats/:chatId/messages?before= · /messages/around/:messageId · /messages/after?after= | ✓ | `MessagePage` |
| GET | /api/messages/:messageId · /edits | ✓ | one message · edit history |
| POST | /api/messages/:messageId/media/retry | ✓ | re-queue a download |
| GET | /api/media/:mediaId (Range) · /api/media-zip?ids= · /api/media-feed?after= | ✓ | files |
| GET | /api/deleted?before= · /api/search?q=&chatId= | ✓ | unsent feed · search |
| POST | /api/chats/:chatId/send · /api/uploads (raw) · /api/chats/:chatId/send-media · DELETE /api/uploads/:id | ✓ | sending |
| POST | /api/messages/:messageId/react · unsend · edit · /api/chats/:chatId/read | ✓ | |
| GET | /api/admin/overview · /api/admin/audit | ✓ admin | users, ports, admin log (gateway) |
| POST | /api/admin/users · /api/admin/users/:id/reset · /delete | ✓ admin | create with temporary password · reset (recovery/wipe) · delete |
| PATCH | /api/admin/users/:id | ✓ admin | move to another port, disable/enable |
| PUT/DELETE | /api/admin/ports/:port | ✓ admin | open/close an extra port, set its browser origin |
| POST | /api/auth/claim · /api/auth/verify · /api/auth/ping · GET /api/auth/whoami | | claim a temporary password · re-check the admin password · gateway's session checks |
| GET/POST | /internal/* (provision, info, signup, reset, revoke-sessions, unlink) | gateway only | never reachable from outside (token + scope header) |
| GET | /api/events | ✓ | SSE: `ig_state`, `message`, `message_update`, `chat_update`, `sync_progress`, `session_revoked` |
| GET/PUT | /api/settings | ✓ | `{downloadHistoryMedia, mediaMaxMb, historyPerChat, readReceipts, sessionRefresh, sessionRefreshHours}` (refresh: reload the tab every 1–24 h ± random ≤ 10 min, default on, 2 h; waits while importing) |
| GET | /api/audit · POST /api/data/wipe | ✓ (+ password) | audit log · delete all logged data |

## 9. Configuration (`.env`, generated by `scripts/setup.sh`)

As wa_logger: `SITE_ADDRESS`, `CADDY_TLS`, `PUBLIC_ORIGIN`, `SETUP_TOKEN`, `COOKIE_SECURE`, `CADDY_CONFIG`,
`HTTP(S)_PORT`, `HTTP(S)_BIND`, `IGL_VERSION` (image tag), `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `MEDIA_MAX_MB`
(100), `HISTORY_PER_CHAT` (100, max 2000), `RECONCILE_MINUTES` (10), `SCREEN`, `LOG_LEVEL`, `TRUST_PROXY` (proxy hop
count; see §3). Multi-user: `CONTROL_SECRET` (app ↔ chromium only; `VNC_PASSWORD` from older `.env` files is the
fallback), `MAX_USERS` (10), `EXTRA_PORTS` (8101-8110), `EXTRA_BIND` (127.0.0.1), optional `APP_MEM_LIMIT`,
`CHROMIUM_MEM_LIMIT`, `CHROMIUM_SHM`. Instagram: `IG_REQUEST_GAP_MS` (1500, pause between history/reconcile requests),
`IG_ENABLED` (tests), `IG_WEB_ORIGIN` (only the fake-Instagram end-to-end test changes it; a startup warning is logged;
plain-http media links are accepted only from that origin). Per worker/user (set by the supervisor, not in `.env`):
`SOCKET_PATH`, `INTERNAL_TOKEN`, `TENANT_ID`, `CHROMIUM_URL`, `CHROMIUM_INSTANCE`, `CHROMIUM_TOKEN`.

## 10. Testing

* `server` (vitest, 197 tests): crypto, auth flows and route coverage (as wa_logger); the multi-user parts
  (`auth/multiuser.test.ts`: /internal routes, temporary-password claim, admin reset recovery/wipe;
  `front/gateway.test.ts`: setup, user creation, isolation between accounts, port pinning, disable/reset/delete, SSE and
  WebSocket forwarding, hardening; `supervisor/supervisor.test.ts`: per-tenant processes, minimal environment, tokens,
  control protocol, removal); `ig/dgw.test.ts` (frames,
  several per message, extended frames, garbage, big ints, protobuf); `ig/mapper.test.ts` (every content type, albums,
  view-once, shares, quotes, edits, reactions, bad ids); `ig/ingest.test.ts` (stream deltas end to end through the
  API: new chat fetch, unsend of messages and albums, edits, reactions incl. removals, seen, chat flags, idempotency,
  reconcile flags missing messages, history limit, refetch for fresh links, no plaintext in the DB);
  `ig/media.test.ts` (queue: download, expired link refresh, restart without links, size cap, foreign hosts; GraphQL
  answer parsing; URL classification); `api/*.test.ts` (chats, paging, media, ZIP, search, settings, SSE, VNC; send API
  incl. CSRF/Origin, uploads, reaction removal, unsend rules, error mapping, Sender chunking and caps).
* The stream decoder was cross-checked against frames encoded by mautrix-meta's Go implementation (`dgw` +
  `mdCoreSync` protobuf), including the ack bit and a trailing ping (2026-10-18).
* `web`: vitest for `igText` (links, mentions, injection attempts, hostile input speed), typecheck, production build.
* `scripts/smoke.sh`: TLS (+ no SNI), headers, cookies, CSRF/Origin, signup, **the real instagram.com login
  page loads in the locked-down Chromium** (state `login`), VNC handshake, no app egress, Chromium sandbox, the admin API
  (and no anonymous access to it), creating a user, `/internal` unreachable from outside, and one unix user per process.
* `chromium/manager` (Go, `CGO_ENABLED=0 go test ./...`, also run in the image build): token vectors shared with
  `supervisor/tokens.ts`, the route allowlist (version, tab list, browser WebSocket; nothing else), the VNC tunnel.
* `scripts/dev/fake-e2e.mts` (61 checks; story logging (off by default, check now, author avatar, no live videos, Range-served video, nothing twice, never seen), reels feed, paging, video through the browser with Range, comments, like/unlike, commenting, replying, share as link): all three real images and real Chromium against `fake-instagram.mts` —
  login detection and re-login (nothing attached to the tab while logged out; logging in with a session pasted as
  "Copy as cURL", refused while logged in, never in the logs or DB), history import (3 chats, paging, history photo), live stream message, unsend kept,
  edit history, reaction, live photo downloaded through the browser, sending (text+reply, react/unreact, edit, unsend
  with long thread id, photo upload with a > 2^53 attachment id, stored from the upload), tokens/headers on every
  GraphQL request, doc id learned from the page, downtime reconcile (missed message logged, unsent-while-down flagged),
  no plaintext in the DB files, no content or tokens in the app log.
* `scripts/dev/ui-shots.mts`: screenshots of the UI (light, dark, phone) for checking by eye.
* `scripts/dev/multiuser-e2e.mts` (against a running stack): unix users and permissions, one Chromium per user, port
  pinning, claim/reset/wipe/delete for real, no cross-tenant file access.
* **Not tested against the real Instagram account** (needs the owner's login): live stream shapes, GraphQL answers and
  sending on today's Instagram Web. First live run: see docs/instagram-notes.md "First live check".

## 11. Deployment & operations

* **Images:** CI (`.github/workflows/ci.yml`) runs tests, then builds and publishes
  `ghcr.io/revocx35/insta_logger-{app,chromium,caddy}` (tags `latest`, `x.y.z`, `sha-…`) on pushes to `main` and `v*` tags.
  The packages are public. All GitHub Actions are pinned by commit SHA.
* **Topologies:** (a) from source: `docker-compose.yml` builds the images; (b) prebuilt: `deploy/docker-compose.yml`
  plus `seccomp-chromium.json` and `.env`; (c) either one in HTTP mode behind the user's TLS proxy
  (`setup.sh --http-only`); (d) an optional `docker-compose.override.yml` binds the four volumes to a dedicated,
  size-capped filesystem (README "cap storage").
* **Update:** `docker compose pull && docker compose up -d` (prebuilt) or `git pull && docker compose up -d --build`.
  **Upgrading from a single-user release:** the new compose file is required (app and chromium get `cap_add:
  SETUID SETGID CHOWN KILL`, the app gets the `app_users:/users` volume and a `/run/igl` tmpfs, caddy gets
  `EXTRA_PORTS`). Keep the `.env`: `CONTROL_SECRET` falls back to `VNC_PASSWORD`, and `EXTRA_PORTS`/`MAX_USERS` have
  defaults. The first sign-in adopts the existing account as the admin; everybody signs in again (sessions are per
  worker).
  The Instagram login survives restarts (it lives in the Chromium profile). Restarting only `app` does not touch
  Chromium: `docker compose up -d --no-deps app` (the tab is reloaded so the stream socket is seen from its start;
  the reconcile on ready catches what arrived meanwhile).
* **Backups:** `app_data` and `app_users` (encrypted; useless without each user's password or recovery key) and
  `chromium_profile` (the live Instagram logins, one per user: treat it as a credential). The system database
  (`/users/system/system.db` inside `app_users`) holds the user list and ports — back it up with them.
* **When Instagram Web changes break something:** live logging depends only on the stream format (docs/instagram-notes.md
  §Stream); history/reconcile/sending depend on GraphQL document ids and response shapes. Doc ids are learned from the
  tab's own requests (`ig_doc_ids` in app_state); defaults in `server/src/ig/docs.ts`. Settings → Instagram shows the
  time of the last live update. Errors name the failing query and, for non-JSON answers, their size and first 12
  characters (never content). Reels/stories/like/comment query ids and variables were captured from Instagram Web's
  own pages (docs/instagram-notes.md "Reels", "Stories"); capture with the requests stopped inside the browser
  (`Fetch.failRequest`) when a write's format is needed.
* **Owner's deployment (2026-10):** prebuilt images in an unprivileged Proxmox LXC, HTTP mode behind Nginx Proxy
  Manager (`TRUST_PROXY=2`). Chromium's sandbox works in an unprivileged LXC with `nesting=1`.
