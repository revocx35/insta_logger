# insta_logger — progress

## Done (2026-10-18, first version)
- [x] Fork of wa_logger: server core, crypto, auth, DB layout, API, web UI, containers, CI (Android client and calls removed)
- [x] Stream decoder (DGW frames → protobuf → Slide deltas), cross-checked against mautrix-meta's Go encoder
- [x] Mapper for every known Slide content type; albums split per photo/video; view-once never downloaded
- [x] Ingest: new messages, unsend (kept + flagged), edits with history, reactions (incl. removals), seen, chat changes
- [x] History import (paged, paced) and reconcile (catch up + flag messages gone while away)
- [x] Media through the browser (Network.loadNetworkResource), encrypted, link refresh on expiry
- [x] Sending: text, reply, reaction, edit, unsend, photo/video/audio, voice messages; Mercury upload
- [x] GraphQL doc ids learned from the tab; tokens stay in the page
- [x] Login/challenge detection, tab kept on the inbox, watchdog, stream-silence reload
- [x] Web UI: Instagram look, shares, music, albums, unsent badges, Instagram (VNC) page, settings
- [x] Story logging (followed accounts, never seen, retention days)
- [x] Reels section (feed through the server's session, videos through the browser, share to a chat as link)
- [x] Tests: 148 server unit/integration, 10 web, smoke 23 (real instagram.com login page), fake-Instagram e2e 61
- [x] Docs: README, ARCHITECTURE, SECURITY, AGENTS, CLAUDE, docs/instagram-notes.md

## Done (2026-10-21, multi-user)
- [x] Same multi-user design as wa_logger (2026-10-20): supervisor (root, 4 caps) → gateway (uid 10003) + one worker per
      user (uid 10001 / 10100+id) on unix sockets; system DB in /users/system; chromium container runs a Go manager with
      one Xvfb+Chromium+x11vnc per user behind per-instance bearer tokens
- [x] Admin creates users with a temporary password; the user claims it (own keys) or the admin resets (recovery/wipe);
      per-user ports the admin opens and assigns; the admin API and its audit log
- [x] Web: Users page (users, ports, admin log), choose-own-password step on login, admin nav entry
- [x] Upgrade path from a single-user install (tenant 1 keeps /data, /data/profile; the owner is adopted as admin)
- [x] Tests: 197 server (incl. 11 multi-user worker tests and the gateway/supervisor suites), Go manager suite, web build
- [x] Docs updated (AGENTS, ARCHITECTURE, README, SECURITY, CLAUDE, DEVLOG)

## Open
- [ ] First run with the owner's real Instagram account (docs/instagram-notes.md "First live check")
- [ ] Message requests folder in the history import (only INBOX is paged today; requests arrive live)
- [ ] Voice message format accepted by Instagram (MP4/AAC vs Ogg/Opus) — verify live
- [ ] Admin/Users screens in the Android client (the server supports them; the app has no user management yet)
- [x] Publish to GitHub + GHCR (public, 2026-10-18; CI green, images public)
