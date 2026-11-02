# insta_logger — development log

## 2026-10-18 — first version

- Requested by phone: "an Instagram version of wa_logger, same functionality, server version only (no mobile app)".
- Started from a clean `git archive` of wa_logger (f70c928). Kept: auth, crypto, DB layer, API style, web UI,
  containers, Caddy, setup/smoke scripts. Removed: whatsapp-web.js, calls (WhatsApp-only), Android client, WA dev tools.
- Instagram has moved its web DMs to a new protocol in 2026 ("Slide" deltas over the DGW gateway, see mautrix-meta
  v26.07 "new Instagram bridge"); end-to-end-encrypted Instagram chats are gone from the web (mautrix removed them in
  v26.04). Design: keep the real Instagram Web logged in in the Chromium container (like WhatsApp Web), read its stream
  passively over CDP, and run Instagram Web's own GraphQL requests inside the tab for history/reconcile/sending.
- Verified without an account: Instagram's login page loads fully in the locked-down container Chromium; page modules
  (`getAsyncParams`, `DTSGInitData`, `LSD`, `CurrentUserInitialData`, `PolarisViewer`, `IGDMqttWebDeviceID`) exist.
- Built a fake Instagram (`scripts/dev/fake-instagram.mts`) speaking the same wire format, and an end-to-end test of the
  real stack against it (37 checks). The decoder was cross-checked against mautrix-meta's Go frame/protobuf encoder.
- Found while testing: npx doesn't pass SIGTERM on (stale fake server reused by the next run); own sent photos were
  downloaded back from the CDN before the upload bytes were stored (queue now skips them); sticky day labels overlapped
  with a transparent background.
- Not done yet: a run with the owner's real account.

## 2026-10-18 (later) — published and deployed

- Public repo + GHCR images (CI green on the first push). `npm audit --omit=dev` reports high advisories in
  puppeteer's browser-download chain (basic-ftp, extract-zip); the app only uses `puppeteer.connect` over CDP, so those
  code paths never run. The audit step stays non-blocking; revisit when moving to puppeteer 25.
- First deployment with the prebuilt images in an unprivileged Proxmox LXC (Ubuntu 26.04, Docker 29, `nesting=1,keyctl=1`):
  all three containers healthy, and Chromium runs with its sandbox (zygote + sandboxed renderers, no `--no-sandbox`)
  under the bundled seccomp profile.
- First real login hit Instagram's captcha page (`/auth_platform/recaptcha/`). Its reCAPTCHA frame
  (`www.google.com/recaptcha/enterprise/…`) was blocked by the URL policy and showed only a grey icon. The policy now
  allows the reCAPTCHA paths only (`www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`, `www.recaptcha.net/recaptcha/`).
- Next: solving the captcha led straight back to the login page. A CDP trace (paths and cookie names only) showed
  Chromium blocking reCAPTCHA's `_GRECAPTCHA` cookie as a third-party cookie (reason `UserPreferences`: this Chromium
  blocks third-party cookies by default). Added `CookiesAllowedForUrls` pairs `https://[*.]<google/gstatic/recaptcha.net/
  facebook/fbsbx>,https://www.instagram.com`. Checked in the container: a google.com frame inside an instagram.com page
  could not keep a cookie before, and can after.
- Still a captcha loop after that: the captcha passes (`is_success: true`), but the next login asks again
  (`useCDSWebLoginMutation` → error 1348009, `recaptcha_needed`; the gate is Meta's "anti-scripting" check). The browser
  looked like a bot: no WebGL at all (no GPU, no software GL), time zone UTC/unknown. Now: Mesa llvmpipe WebGL
  (`--ignore-gpu-blocklist`, Xvfb GLX; renderer "ANGLE (Mesa, llvmpipe …)" like a Linux PC without a GPU driver, sandbox
  still on), and `TZ` in `.env` (setup.sh writes the server's zone) passed to the chromium container.
- Hands off while logged out (`ig/loginwatch.ts`): puppeteer's Page enables Runtime in the page and the reCAPTCHA
  frames, which pages can detect. Now, when the tab is on a login/challenge page or there is no session, the app
  disconnects puppeteer and polls `/json/list` + browser-level `Storage.getCookies` (raw WebSocket) every 3 s; only
  single navigate/reload commands attach briefly. It attaches again once `sessionid` + `ds_user_id` exist and the tab
  left the login pages. Fake e2e (39 checks) asserts `Target.getTargets().attached === false` while logged out.
- The loop went on with nothing attached, WebGL and the right time zone (captcha passed within seconds, login asked
  again). Added logging in with a session from the owner's own browser: paste DevTools' "Copy as cURL" (or a Cookie
  header / JSON export) on the Instagram screen; `ig/cookies.ts` parses it (bash quoting incl. `$'…'`, whitelisted
  Instagram cookie names, account check), `POST /api/ig/session` puts the cookies into the browser
  (`Storage.setCookies`) and opens the inbox. The fake Instagram now checks session cookies (sessions it issued), and
  the e2e (42 checks) logs in with a pasted session and checks it never reaches the logs or the DB.
- Reels section (owner asked for an Instagram UI, then cut it down to reels + sending them to friends): Instagram
  Web's reels query inside the tab, videos via opaque refs fetched through the browser, share = send the reel link.
  Query ids/variables were read from Instagram Web's bundles and its own /reels/ requests (owner allowed it; Claude
  Code's classifier flags this kind of work, ask before more Instagram probing). e2e 49 checks.
- Owner reported: reels like/comment buttons did nothing (they were display-only), and no chats in the log. Chats: the
  inbox query had a new doc id and no longer accepts the AIGM relay provider (field_exception, mailbox null); fixed ids
  and variables from the inbox page's own request, made null mailbox an error and re-run an import that found nothing.
  Reels: like/unlike (+ double-click), comments sheet with paging and posting. e2e 53 checks.
- Owner: like/comment failed (Instagram refuses the old REST writes). Captured Instagram Web's own like/unlike/comment
  mutations by clicking in a second tab with every such request failed inside the browser (nothing sent); added replying
  to comments (+ first replies shown). Owner added narrow permission rules (CT 120 exec/push, insta_logger edits). e2e 54.
- Reels refresh button (fresh feed from the top). Setting "refresh the Instagram session": background tab reload every
  1–24 h (default on, 2 h), each time randomly up to 10 min earlier or later (refreshDelay), postponed while importing.
- Native Android client released as a separate repo: github.com/revocx35/insta_logger_android (0.1.0).
- Story logging (owner asked by voice): followed accounts' stories every ~45 min (random ±10), never marked seen, encrypted, retention in days (Settings). e2e 61.
- Story settings: check interval (15–720 min), everyone or chosen accounts (picker from accounts seen in the stories bar).
- Reels preloading: server prefetches the first 4 videos of each page; web/Android warm the next 3 while watching.
- Story logging didn't save anything live: Instagram's story query now requires the relay provider PolarisCommunityNoteStoriesLabelEnabled (captured from its viewer, seen request blocked); without it items come back empty with missing_required_variable_value. Empty answers are now reported in the status.
- Stories page: the account row was squashed under the grid (flex column + overflow-x row shrinks to 0); page children no longer shrink.

## 2026-10-21 — multi-user support (parity with wa_logger's 2026-10-20 design)

The owner asked for the same multi-user mechanism wa_logger got: the first account is the admin, the admin creates users
with a temporary password and assigns each a port (the ports are opened by the admin). The server core was already a
direct fork of wa_logger's pre-multi-user code, so the containers/gateway/supervisor were ported from that release rather
than reinvented:

- `server/src/supervisor/` (root, CAP_SETUID/SETGID/CHOWN/KILL): creates `/users`, `/run/igl`, starts the gateway and one
  worker per tenant under that tenant's unix user, restarts them, and answers a one-line-JSON control socket.
- `server/src/front/` + `front.ts`: the gateway — system DB (`users`, `listeners`, `audit`), one `http.Server` per port,
  tenant cookie (`__Host-igl_tenant`) routing, streaming/WebSocket proxy to the worker's unix socket, admin API.
- Workers: `SOCKET_PATH`/`INTERNAL_TOKEN`/`CHROMIUM_*` in `config.ts`, `/internal/*` routes (`api/internal.ts`), the
  `pending_claim` migration + claim flow in `auth/routes.ts` (signup only in single-process mode).
- chromium container: `chromium/manager/` (Go, stdlib only) replaced the bash supervisor: per-user Xvfb + Chromium +
  x11vnc under their own unix users, one token-checked API (`ensure`, `restart`, delete, VNC tunnel, CDP relay of
  `/json/version`, `/json/list` and the browser WebSocket), stale profile locks cleared as the instance's user.
- insta-specific difference: the app never used `puppeteer.connect({ browserURL })` for its login watch — `ig/loginwatch.ts`
  reads the tab list and the cookie jar directly. It now goes through `ChromiumLink.cdpTarget()` (the manager relays
  `/json/list` as well), and `BrowserCdp` connects with the `ws` package so the instance token can be sent on the
  handshake (undici's WebSocket cannot send headers). `ws` moved from devDependencies to dependencies.
- Web: `pages/Admin.tsx` (users, ports, admin log; no "blocked contacts" — that is a WhatsApp feature), the
  choose-own-password step in `Auth.tsx`, `/admin` route and rail entry, admin API client methods, `role`/`ig` in AppState.
- Compose/Dockerfile/caddy: supervisor as PID 1, `app_users:/users`, `/run/igl` tmpfs, `cap_add` in app and chromium,
  `EXTRA_PORTS` published by caddy with one generated site per port, `CONTROL_SECRET` (falls back to `VNC_PASSWORD`, so
  the CT 120 `.env` keeps working).
- Gotcha found while porting: the wa copy of `http/server.ts` was re-copied after the bulk rename, so it still checked
  `x-wal-internal`; the gateway's forwarded requests were refused with a bare 403. Grep for the old prefix after copying
  files, not just in the first batch.
- Tests: 197 server (11 new multi-user worker tests, gateway and supervisor suites), Go manager suite green
  (`CGO_ENABLED=0 go test ./...`), web 10 + build, smoke extended to 32 checks.

## 2026-10-27 — Instagram look (web + Android)

- Owner asked for the UI to look like the official Instagram app and web UI, in the web UI and the Android client.
- Web: Instagram's tokens/type scale, outline icon set, sidebar (wide/narrow) + phone tab bar with a "More" sheet,
  DM inbox layout, joined bubble runs, pill composer with a text "Send", bare media, reels actions + double-tap heart,
  stories tray/archive grid/viewer with progress bars, Instagram-style login box with a script wordmark (Grand Hotel,
  bundled, OFL). `formatAgo` ("2h", "3d") with tests.
- Checked by screenshots against the fake-Instagram stack through a local preview proxy (reels/stories mocked there).
- Lesson: `.grow` has a later `min-width: 200px` (admin tables) — don't reuse it as a flex spacer.
- Note: `fake-e2e.mts` currently fails at "Instagram ready" after the multi-user change (it polls `/api/ig/status`
  before onboarding); the stack itself comes up — needs a follow-up.

## 2026-10-31 — Automatic login with a saved password

- Owner: Instagram logs the account out every couple of weeks; wants the password saved and typed in automatically
  on the login screen, with realistic mouse movement and typing to avoid bot detection.
- Design constraint: nothing may be attached to the tab while logged out (captcha loops, 2026-10-18). So input goes
  through **VNC** (the app's own RFB client → the tenant's x11vnc → XTEST): trusted events, no debugger, same path as
  the owner's viewer. Positions come from one short **read-only DOM look** (`loginform.ts`: getDocument,
  getContentQuads, getNodeForLocation as hit test; no Runtime, no enable), detached before any input.
- `humaninput.ts`: Bézier paths + minimum-jerk timing + Fitts's law + tremor + overshoot; log-normal typing gaps,
  overlapping holds, explicit Shift, pauses, rare neighbour-key typos erased. Pure + seeded, so tests replay a plan
  like X would and check the typed text is exact (200 seeds × 5 texts with heavy typo rates).
- Node 24's OpenSSL 3 has no DES, which VNC auth needs → `vnc/des.ts` (FIPS vector + an OpenSSL-legacy cross-check).
- Restraint (account safety): settle 4–12 s, one attempt per logout, 10 min cooldown, pause after 2 failures,
  suppressed after a manual logout, never while the owner used the VNC screen in the last 2 min (the bridge spots
  noVNC pointer/key messages), checks/2FA left to the owner.
- Storage: sealed in `app_state` under `<DATA_DIR>/autologin.key` (the worker must read it unattended, so it can't be
  under the owner's password like logged data). Documented as an accepted exposure in ARCHITECTURE/SECURITY.
- Lesson: the Instagram page keeps a VNC viewer open while logged out, so "a viewer is connected" can't mean "the
  owner is busy" — owner *input* recency is the signal.
- Fake Instagram: the login page is now a real form that reports trusted-event counts, mouse moves and key gaps;
  the app's "Log out" endpoint exists. fake-e2e: automatic login checks (right credentials, trusted input only,
  human rhythm, success state, manual-logout respected, "Log in now", password not in logs/DB).
- Tests: 227 server (30 new), web 11 + build. Android client 0.8.0: Automatic login panel on the Instagram screen.
- Measured, not guessed: the first e2e runs saw only 6–15 `mousemove` events per login. A/B on a kept stack (extra
  x11vnc instances on the same display, the app's own modules playing a seeded plan): fresh x11vnc 41/58 samples,
  the same x11vnc after 75 s idle 12/58 — its naps and screen-blank throttling delivered input in ~250 ms bursts that
  Chromium merged. Manager now runs x11vnc with `-pointer_mode 1 -nonap -sb 0` (40/58 after idle; idle CPU without
  clients unchanged). TCP_NODELAY on the app's tunnel socket stays (correct, but it was not the cause).
- fake-e2e repaired (it had been failing since multi-user): a cookie jar for the gateway's two cookies, `tabAttached()`
  through the manager relay with tenant 1's instance token, IPv4-first (`localhost` → ::1 was refused), and a wait
  until Caddy serves before signup. 72/72. The "downtime unsend flagged" check is timing-sensitive (failed 2 of 5 runs).

## 2026-11-02 — automatic login: Instagram's profile picker

- Owner: "the automatic log in isn't working". CT 120 logged every attempt (every 2 min since the 10:20 logout) as
  `no_form`. A read-only look at the tab (DOM summary + `Page.captureScreenshot`, then detached) showed Instagram's
  new logged-out screen: the remembered profile with "Continue", "Use another profile", "Create new account" — no
  password field, so `pickLoginFields` found nothing.
- Fix: `pickProfileButton` (loginform.ts) finds "Continue" after a text node equal to the saved username (else "Use
  another profile"); `readLoginForm` returns `{ ok: 'picker', button }`; the attempt clicks it with `clickPlan`
  (humaninput.ts) over VNC, then looks again for the form (≤ 4 looks, 1.8–3.2 s apart) and types as before. A
  "Continue" that logs in without a password is settled by the normal verdict.
- Tests: 230 server (3 new: picker detection on the live page's shape, picker → password, picker → straight in /
  nowhere). No API/UI change, so web and Android are unchanged.
