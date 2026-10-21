# Security

insta_logger stores private conversations. This document explains what it protects against, what it doesn't,
and how to run it safely. The design details are in [ARCHITECTURE.md](ARCHITECTURE.md) §6.

## Threat model

**Protected against**

| Threat | Mitigation |
|---|---|
| Someone on the network finds the login page | Single owner. Signup needs the one-time `SETUP_TOKEN` and closes after the first account. scrypt (N=2¹⁷) passwords. Race-free throttling: each attempt is charged before hashing. Per-IP exponential lockout means one attacker's failures don't lock your IP, and a global per-account cap bounds distributed guessing (an attacker can keep that cap engaged and delay your password logins; your sessions keep working and the recovery key bypasses it). Atomic single-use TOTP codes, optional 2FA, audit log. |
| Theft of the database, media files or backups | Envelope encryption (see below). Without the password or recovery key, stored content is unreadable. |
| Stolen database *and* the server's `.env` | `.env` holds no data keys, so this is still unreadable. |
| Malicious message content (HTML, SVG, scripts, crafted file names, links) | Never rendered as HTML (React text nodes only), strict CSP, only `http(s)` links (`rel=noopener noreferrer nofollow`). Media served with `Content-Security-Policy: sandbox`, `nosniff`, and as a download unless it is a raster image, audio or video. |
| CSRF / clickjacking / cross-site WebSocket hijacking | `SameSite=Strict` `__Host-` cookie, exact `Origin` check on every state-changing request and WebSocket, session-bound CSRF token, `frame-ancestors 'none'`. |
| A stolen session cookie | Enough to read logs **and send messages as you** until it expires or is revoked, but not enough to add 2FA (needs the password) or to wipe data or rotate the recovery key (needs the password + 2FA code). Sending is rate-limited per route and capped at 200 sends per hour (protects the Instagram account too), and every send is in the audit log (type only, no content). |
| Abuse of sending | Same session, CSRF token and `Origin` checks as every other change. Uploads are raw bodies only on `/api/uploads` (64 MB cap, at most 4 waiting, 10 min lifetime, bound to the session that made them, kept in memory only, never on disk unencrypted). Text travels in JSON bodies, never in URLs, so it never reaches access logs. Only photos, videos and audio are accepted. |
| Crafted messages or stream frames meant to freeze or crash the server or UI | The text renderer is linear-time; the stream decoder is a bounded, defensive parser (malformed frames decode to nothing, frames above 8 MB are ignored). Tests include garbage, truncated and hostile inputs. |
| Lateral movement between containers | The app has no internet. Only Chromium talks to Instagram. CDP and VNC listen only on an internal network shared with the app. Only Caddy publishes ports. Non-root, read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`, memory and pid limits. |
| A compromised web page inside Chromium | Chromium sandbox **enabled** (seccomp profile instead of `--no-sandbox`). A managed policy blocks navigation to anything but Instagram and the Meta domains it needs (`cdninstagram.com`, `fbcdn.net`, `facebook.com`, `fbsbx.com`) plus Google reCAPTCHA's paths only (`www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`, `www.recaptcha.net/recaptcha/`: Instagram's login captcha), and blocks downloads, file pickers and extensions. |
| Instagram (or whatever the tab runs) feeding the app hostile data | Everything from the tab — stream frames, GraphQL answers, media — is treated as untrusted input: size-capped, parsed defensively, validated ids, stored encrypted, rendered as text only. Media is only fetched from Instagram's CDN hosts (`https` on `cdninstagram.com`/`fbcdn.net`/…) and only by the browser. |
| The Instagram session the owner pastes ("log in with your own browser") | It is a credential. Accepted only from the logged-in owner (session, CSRF token, `Origin`), size-capped (32 KB), rate-limited; only Instagram's own cookie names are kept and their values checked; the cookies go straight into the browser's cookie jar. The pasted text is never logged or stored, and errors never repeat a value. The end-to-end test checks the app log and database for the pasted session. |
| Instagram's signed media links leaking from storage | They are bearer links to private photos, so they are kept **in memory only** (never in the database or logs) and dropped once the file is stored. |
| Log leakage | Logs never contain message content, names, usernames, cookies or Instagram tokens (`fb_dtsg`, `lsd`, `csrftoken`, session cookies stay inside the browser or in memory). URLs are logged without query strings, and long ids are masked. The end-to-end test checks the app log for planted content and tokens. |

**Not protected against** (out of scope, or inherent)

- A **fully compromised host or root on the host**. It can read process memory (the current data key and plaintext
  as it is captured), the Chromium profile, and everything a logged-in session decrypts.
- **The Instagram login in `chromium_profile`.** Whoever has this volume can use your Instagram account. Protect it.
- **Metadata**: Instagram thread, message and account ids, timestamps, message types, flags (unsent, edited, from-me)
  and media sizes are stored unencrypted, so lists can be sorted and paginated without the key.
- A stolen, still-valid **session cookie** gives access until it expires (idle 8 h, absolute 7 days by default) or is revoked.
- Instagram's Terms of Use: this automates the Instagram website. Account restrictions or extra login checks are possible.
- **Kernel attack surface from user namespaces.** Keeping Chromium's sandbox on means the chromium container's
  seccomp profile must allow `clone`/`unshare` with namespace flags. That is the trade-off for not using `--no-sandbox`.
- The Chromium URL policy restricts **navigation** only. Scripts running inside Instagram Web can still fetch other
  URLs, and anything that controls CDP (the app) could too. The app refuses every request coming from Chromium.
- **Anyone who can open the VNC view** (a logged-in owner session) can use the Instagram account in the browser.

## Multiple users

- Every user is a separate tenant: own unix user, own directories, own SQLite database, own keys, own Chromium profile.
  The gateway (the only network listener) owns only the user list and an audit log — no keys, no content.
- A worker's socket lives in a `tenant:front 0710` directory and every request to it must carry that worker's random
  token; the `/internal/*` routes additionally need a scope header only the gateway sets. The tenant cookie is a
  routing hint, not a credential — the worker validates its own session cookie.
- A user can only sign in on the port the admin assigned (the admin only on the default port); a session is rejected on
  every other port, on HTTP requests and WebSocket upgrades alike.
- The admin never sees message content, contact names or media. It can reset or delete a user's account and thereby
  take it over (with a wipe) or deny service, but cannot read what was logged: the data keys are wrapped by the user's
  own password/recovery key. Destructive admin actions ask for the admin password again (and 2FA when on).
- Each Chromium runs under the owning user's unix user with its own X display, VNC password and profile. A full browser
  sandbox escape as one user could reach the other browsers' loopback DevTools ports (shared network namespace in the
  chromium container); separate containers per user would close that and are not implemented.

## Encryption at rest

```
password ──scrypt──► master ─HKDF─► authHash (stored)       recovery key ─HKDF─► recovery KEK
                              └HKDF─► KEK ──AES-GCM──► owner X25519 private key ◄──AES-GCM── recovery KEK
                                                         ▲
                                     session secret (cookie only) ──HKDF──► session copy of the private key
owner X25519 public key ──ECIES──► wrapped DEK (rotated at start + every 24 h)
DEK ──AES-256-GCM (AAD = table|column|row)──► message text, shared-post details, names, usernames, edit history, reactions
DEK ──chunked AES-256-GCM (64 KiB chunks, index + final flag in AAD)──► media files
```

- The logger only needs the **public key** to write, so it logs while you are logged out, but it cannot read
  anything written under earlier data keys.
- The database stores `sha256(sid‖secret)` for sessions. A database dump cannot be turned into a working cookie or unlock the private key.
- A password change re-wraps the private key. Recovery sets a new password, rotates the recovery key, disables 2FA
  and revokes all sessions.
- If you lose **both** the password and the recovery key, the data is gone. Nobody can recover it.

## Running it safely

1. Keep `.env` private (`chmod 600`, which `setup.sh` sets) and don't commit it (`.gitignore` covers it).
2. Prefer LAN/VPN-only access. If you must expose it, use a real domain with Let's Encrypt and enable **2FA**.
   Behind your own reverse proxy (e.g. Nginx Proxy Manager), use `setup.sh --http-only`, keep `TRUST_PROXY=2`
   (`3` if another proxy such as Cloudflare sits in front), and let only the proxy reach port 80.
3. Store the recovery key offline (password manager or paper).
4. Encrypt the host disk (LUKS / encrypted ZFS dataset). It protects the metadata and the Instagram login.
5. Update regularly: `docker compose pull && docker compose up -d`. Instagram's website changes often.
6. Review **Settings → Security log** and **Sessions** now and then.
7. Back up `app_data` (encrypted). Treat `chromium_profile` backups like a password.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Advisories), or contact the
repository owner directly. Please don't file public issues for vulnerabilities.
