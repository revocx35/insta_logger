# insta_logger — Architecture

> Source of truth for design decisions. Read this (and `docs/instagram-notes.md`) before changing anything.
> If you change a decision, update this file in the same commit.

## 1. What it is

A self-hosted, single-owner, Docker-based **Instagram direct-message logger**, built from wa_logger (same server core,
crypto, auth, web UI and container design; the WhatsApp layer is replaced by an Instagram one). A real Chromium runs
Instagram Web in a background container. The app watches it through the Chrome DevTools Protocol and records **every
message, edit, reaction and media file** of the account's DMs, encrypted at rest. When someone unsends a message, the
logged copy stays viewable and is flagged.

The web UI looks like Instagram's DM view. It can also **send** as the account (text, replies, photos/videos/audio,
voice messages, reactions, edits, unsend). The live Chromium screen ("Instagram" in the menu) is where the owner logs in
and answers Instagram's checks.

Out of scope on purpose: calls, multiple accounts or tenants, starting new chats, and **view-once / allow-replay media**
(logged as a placeholder, never downloaded — wa_logger's policy). No Android client (the web UI is responsive).

## 2. User flow

1. **Signup** (`/signup`): only while no owner exists; needs `SETUP_TOKEN` from `.env`. Username + password (≥ 12).
2. **Recovery key** (`/setup/recovery`): shown once; the owner ticks "I saved it".
3. **Log in to Instagram** (`/setup/link`): the live Chromium screen (noVNC) with Instagram's login page and a status pill
   (`starting → login/challenge → syncing → ready`). The owner logs in there (2FA and "was this you?" checks too).
   **Complete** is enabled once the state is `ready`/`syncing`.
4. **Main** (`/`): two-pane chat UI; menu rail **Chats**, **Unsent**, **Search**, **Instagram**, **Settings**, **Logout**.
5. Later visits: `/login` (or `/signup`), then `/` (or `/setup/link` if onboarding isn't complete).

## 3. Containers & networks

```
                internet
                   │
          ┌────────┴────────┐   network: public (bridge)      ports 80/443 published
          │      caddy      │   TLS termination (ACME or internal CA), HTTP→HTTPS
          └────────┬────────┘
                   │ network: edge (internal: true)
          ┌────────┴────────┐
          │       app       │   Node 24 · Fastify · puppeteer-core (CDP) · SQLite · serves built web UI
          │  (no internet)  │   volume app_data:/data  (db + encrypted media)
          └────────┬────────┘
                   │ network: backend (internal: true)
                   │   tcp 9223 → CDP (socat → 127.0.0.1:9222)   tcp 5900 → x11vnc
          ┌────────┴────────┐
          │    chromium     │   Debian trixie · Chromium (headful, sandbox ON via seccomp profile)
          │                 │   Xvfb :99 · x11vnc · socat · volume chromium_profile:/data
          └────────┬────────┘
                   │ network: egress (bridge) → instagram.com / Meta CDNs
                internet
```

* Two compose files: `docker-compose.yml` builds all three images from source (`Dockerfile`, `chromium/`, `caddy/`),
  and `deploy/docker-compose.yml` uses the images CI publishes to GHCR (`ghcr.io/revocx35/insta_logger-{app,chromium,caddy}`).
  The standalone variant only needs `seccomp-chromium.json` and `.env` next to it. The Caddyfile is baked into the
  caddy image so Caddy keeps a read-only root filesystem (compose `configs.content` cannot be used with `read_only`).
* HTTP mode (`CADDY_CONFIG=Caddyfile.http`, `setup.sh --http-only`): Caddy serves plain HTTP behind the user's own
  TLS reverse proxy and trusts X-Forwarded-* from private ranges. The app uses `TRUST_PROXY=2` and
  `COOKIE_SECURE=auto`: `Secure`/`__Host-` cookies and HSTS whenever the request arrived over HTTPS.
  * Client IP (used by the login throttle): Nginx Proxy Manager *appends* the address it saw to the client's
    `X-Forwarded-For` (`$proxy_add_x_forwarded_for`), and Caddy, trusting NPM's private address, appends NPM's. The
    app trusts exactly `TRUST_PROXY` hops from the right (Caddy's socket + NPM's entry), so the client IP is the
    entry NPM appended, and anything a client puts in front of it is ignored.
  * The hop count must match reality. Too low (`1` behind NPM): every client looks like NPM, and 5 failures lock the
    per-IP throttle for everyone coming through it. Too high: clients can pick their own IP. Another proxy in front of
    NPM (e.g. Cloudflare) makes it `3`.
  * Caddy trusts any private address, so a LAN host that reaches port 80 directly can claim any client IP and get
    around the per-IP limit (the global limit still applies). That's why port 80 in HTTP mode should be reachable only
    from the proxy.
* Only **caddy** publishes ports. The **app** has no route to the internet (it sits only on internal networks).
  **chromium** is the only component that talks to Instagram.
* CDP has no authentication, so it is reachable only on `backend`, where the app is the only other container.
  Chromium ignores `--remote-debugging-address` in headful mode, so it listens on 127.0.0.1:9222 and
  `socat` exposes it as `0.0.0.0:9223` inside the container.
* Chrome rejects CDP HTTP requests whose `Host` header is not an IP or `localhost`. The app therefore
  **resolves `CHROMIUM_HOST` to an IP** (`dns.lookup`) and connects to `http://<ip>:9223`.
* x11vnc is protected by `VNC_PASSWORD` (defense in depth). Its port is reachable only on `backend`, and the
  browser reaches it **only** through the app's authenticated WebSocket bridge `/api/vnc`.
* Hardening on every container: `no-new-privileges`, `cap_drop: [ALL]` (caddy re-adds `NET_BIND_SERVICE`),
  non-root users, `read_only` root filesystems with explicit tmpfs mounts, memory limits, healthchecks.
* Chromium keeps its **sandbox enabled**. Docker's default seccomp profile blocks the user-namespace syscalls
  the sandbox needs, so `chromium/seccomp-chromium.json` (Docker's default profile plus `clone`, `clone3`,
  `unshare`, `setns`, `chroot` and similar) is applied. **Never ship `--no-sandbox`.** It is available only as an
  explicit escape hatch (`CHROMIUM_NO_SANDBOX=1`) with a startup warning.

### chromium container
* `entrypoint.sh` acts as a small supervisor (bash `wait -n` plus restart loops). It removes stale
  `Singleton*` locks, then starts `Xvfb :99 -screen 0 ${SCREEN}`,
  `chromium --user-data-dir=/data/profile --remote-debugging-port=9222 --kiosk --no-first-run
  --no-default-browser-check --password-store=basic --disable-features=Translate,MediaRouter
  --noerrdialogs --hide-crash-restore-bubble --window-position=0,0 --window-size=W,H about:blank` plus
  `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
  (a throttled tab would let the message stream's keep-alives lapse),
  `x11vnc -display :99 -rfbport 5900 -rfbauth … -forever -shared`, and
  `socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222`. Crashed children are restarted.
* socat and x11vnc listen only on the container's address in the network shared with the app (`BACKEND_PEER`): the
  entrypoint resolves `app` and takes the source address of the route to it, and accepts it only if that route is
  on-link (no gateway). Before the app container exists, Docker's DNS forwards the name to the host's resolver, where a
  search domain can turn `app` into some public address; without the check the relays would listen on the egress
  network and the app could not reach them (seen on the dev host, 2026-10-17).
* The healthcheck calls `curl -fs http://127.0.0.1:9222/json/version`.
* The profile volume **contains the live Instagram login** (cookies). Anyone with it can use the account.
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

## 4. App (server) — `server/`

Node 24 LTS, TypeScript (ESM), Fastify 5, better-sqlite3 (WAL), zod, puppeteer-core (CDP only; no browser download).
Tests use vitest.

```
server/src/
  index.ts            bootstrap: config → db → crypto keyring → http → ig (only once an owner exists)
  config.ts           zod-parsed env (§9); fails fast on bad config
  log.ts              pino with redaction (cookies, auth headers, passwords, tokens, message bodies)
  db/                 connection, migrations (schema §7), repositories
  crypto/             AES-256-GCM, HKDF, X25519 ECDH, scrypt; keyring (DEKs, ECIES, field encryption); chunked media files
  auth/               signup, login, logout, recovery, TOTP, password; sessions; throttle
  http/               server factory, security headers/CSP, static web UI, error handler, ZIP streaming
  api/                chats, messages, media (Range, ZIP), search, unsent feed, SSE, settings, audit, wipe, sending
  vnc/                authenticated WebSocket ↔ TCP bridge to chromium:5900
  ig/
    service.ts        IgService: connects to Chromium, keeps one Instagram tab on the inbox, login/challenge detection,
                      watchdog, reconnects, timers (reconcile, avatars), applies deltas in order
    browser.ts        resolve host → IP, CDP reachability, tab choice, URL classification (inbox/thread/login/challenge)
    loginwatch.ts     while logged out: tab list (HTTP) + cookie jar (browser-level CDP) without attaching to the tab;
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
* **Reels section** (`igweb/`, `api/reels.ts`, `web/src/pages/Reels.tsx`). `GET /api/reels?cursor=` runs Instagram
  Web's own reels query (`PolarisClipsTabDesktopPaginationQuery`, variables copied from its /reels/ page, already-shown
  reels passed as `seen_reels`) inside the tab, paced (one at a time, ≥ 500 ms apart). Videos and pictures: the server
  replaces every CDN link with an opaque ref (`MediaRefs`, memory only, 6 h), fetches it through the browser on request
  (`GET /api/reels/media/:ref`, ≤ 40 MB, 128 MB in-memory cache, Range support, `sandbox` CSP). Nothing of it is stored
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
(strict CSP). `@novnc/novnc` for the Instagram screen, `qrcode` for TOTP enrollment.

Routes: `/signup`, `/login`, `/recover`, `/setup/recovery`, `/setup/link`, `/` (chats), `/chat/:chatId`, `/deleted`
("Unsent"), `/search`, `/instagram`, `/settings`. A route guard uses `GET /api/state`.

Chat view: date separators; sender names (+ @username) in groups; text rendered by `lib/igText.tsx` (links and
@mentions only, never HTML; line breaks kept; emoji-only messages large); quoted replies (click to jump); forwarded
label; edited badge with history; unsent badge ("Unsent · time · logged copy" or "Gone from Instagram · noticed …");
reactions; "Seen" for own messages; photos (lightbox), videos/GIFs, voice messages, music previews, stickers; shared
posts as cards (kind, title, caption, link out) with their preview image; album position; disappearing timer icon;
view-once placeholder; select photos/videos → one ZIP; infinite scroll; SSE live updates; per-chat and global search;
composer (text, reply, edit, photo/video/audio, voice recording as MP4 or Ogg/Opus). Instagram-like theme (blue/violet
gradient own bubbles, grey incoming), light and dark, single pane under 900 px.

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

## 7. Database (SQLite, `/data/insta_logger.db`, WAL, `foreign_keys=ON`, `secure_delete=ON`)

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
```
Migrations in `server/src/db/db.ts` (append-only). Bodies and edit history share the AAD context `msgbody|<id>`.
`app_state` keys: `settings`, `onboarding_complete`, `initial_sync_done`, `ig_me`, `ig_doc_ids`.

## 8. HTTP API (JSON; DTO types in `shared/api.d.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/state | – | `{hasOwner, authenticated, onboardingComplete, csrfToken?, ig?}` |
| POST | /api/auth/signup · login · logout · logout-all · recover · password | | as in wa_logger |
| GET/DELETE | /api/auth/sessions[/:id] | ✓ | list / revoke |
| POST | /api/auth/totp/setup · enable · disable · /api/auth/recovery-key/rotate | ✓ | TOTP, recovery key |
| GET | /api/ig/status | ✓ | `IgStatus` |
| POST | /api/ig/restart · /api/ig/logout | ✓ | reload the tab / log the browser out of Instagram |
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
| GET | /api/events | ✓ | SSE: `ig_state`, `message`, `message_update`, `chat_update`, `sync_progress`, `session_revoked` |
| GET/PUT | /api/settings | ✓ | `{downloadHistoryMedia, mediaMaxMb, historyPerChat, readReceipts}` |
| GET | /api/audit · POST /api/data/wipe | ✓ (+ password) | audit log · delete all logged data |

## 9. Configuration (`.env`, generated by `scripts/setup.sh`)

As wa_logger: `SITE_ADDRESS`, `CADDY_TLS`, `PUBLIC_ORIGIN`, `SETUP_TOKEN`, `VNC_PASSWORD`, `COOKIE_SECURE`,
`CADDY_CONFIG`, `HTTP(S)_PORT`, `HTTP(S)_BIND`, `IGL_VERSION` (image tag), `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`,
`MEDIA_MAX_MB` (100), `HISTORY_PER_CHAT` (100, max 2000), `RECONCILE_MINUTES` (10), `CHROMIUM_HOST`, `CDP_PORT`,
`VNC_PORT`, `SCREEN`, `LOG_LEVEL`, `TRUST_PROXY` (proxy hop count; see §3). New: `IG_REQUEST_GAP_MS` (1500, pause
between history/reconcile requests), `IG_ENABLED` (tests), `IG_WEB_ORIGIN` (only the fake-Instagram end-to-end test
changes it; a startup warning is logged; plain-http media links are accepted only from that origin).

## 10. Testing

* `server` (vitest, 107 tests): crypto, auth flows and route coverage (as wa_logger); `ig/dgw.test.ts` (frames,
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
* `scripts/smoke.sh` (23 checks): TLS (+ no SNI), headers, cookies, CSRF/Origin, signup, **the real instagram.com login
  page loads in the locked-down Chromium** (state `login`), VNC handshake, no app egress, Chromium sandbox.
* `scripts/dev/fake-e2e.mts` (54 checks; reels feed, paging, video through the browser with Range, comments, like/unlike, commenting, replying, share as link): all three real images and real Chromium against `fake-instagram.mts` —
  login detection and re-login (nothing attached to the tab while logged out; logging in with a session pasted as
  "Copy as cURL", refused while logged in, never in the logs or DB), history import (3 chats, paging, history photo), live stream message, unsend kept,
  edit history, reaction, live photo downloaded through the browser, sending (text+reply, react/unreact, edit, unsend
  with long thread id, photo upload with a > 2^53 attachment id, stored from the upload), tokens/headers on every
  GraphQL request, doc id learned from the page, downtime reconcile (missed message logged, unsent-while-down flagged),
  no plaintext in the DB files, no content or tokens in the app log.
* `scripts/dev/ui-shots.mts`: screenshots of the UI (light, dark, phone) for checking by eye.
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
  The Instagram login survives restarts (it lives in the Chromium profile). Restarting only `app` does not touch
  Chromium: `docker compose up -d --no-deps app` (the tab is reloaded so the stream socket is seen from its start;
  the reconcile on ready catches what arrived meanwhile).
* **Backups:** `app_data` (encrypted; useless without the password or recovery key) and `chromium_profile` (the live
  Instagram login: treat it as a credential).
* **When Instagram Web changes break something:** live logging depends only on the stream format (docs/instagram-notes.md
  §Stream); history/reconcile/sending depend on GraphQL document ids and response shapes. Doc ids are learned from the
  tab's own requests (`ig_doc_ids` in app_state); defaults in `server/src/ig/docs.ts`. Settings → Instagram shows the
  time of the last live update. Debug-level logs name failing queries (never content).
