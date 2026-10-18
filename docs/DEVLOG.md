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
