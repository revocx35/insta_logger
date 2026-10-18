# AGENTS.md — notes for AI coding agents

The full agent notes live in [CLAUDE.md](CLAUDE.md) (rules, commands, gotchas) and the design in
[ARCHITECTURE.md](ARCHITECTURE.md); Instagram facts the code relies on are in [docs/instagram-notes.md](docs/instagram-notes.md).
Read them before changing anything. In short:

- **What it is:** wa_logger's Instagram sibling. Same server core (auth, crypto, DB, API style), web UI and containers;
  the WhatsApp layer is replaced by `server/src/ig/` (passive reading of Instagram Web's DGW message stream over CDP +
  Instagram Web's own GraphQL requests run inside its tab).
- **Build/test:** `cd server && npm test && npm run typecheck` · `cd web && npm test && npm run build` ·
  full stack `scripts/smoke.sh` (real instagram.com login page) · fake-Instagram end to end
  `cd server && npx tsx ../scripts/dev/fake-e2e.mts` (49 checks; needs Docker, ports 29443/29080/18555 free).
- **Where things are:** Instagram integration `server/src/ig/` (`service.ts` lifecycle, `page.ts` CDP/GraphQL/downloads,
  `dgw.ts` stream decoder, `mapper.ts` messages, `ingest.ts` DB writes, `sync.ts` history/reconcile, `sender.ts`),
  HTTP API `server/src/api/`, web UI `web/src`, API contract `shared/api.d.ts`, test fixtures `server/src/testutil/igfixtures.ts`.
- **Never:** log message content/names/usernames/tokens/cookies or media links; store Instagram's signed media links
  outside memory; weaken CSP/cookies/sandbox/network isolation/the Chromium URL policy; write to Instagram's
  WebSocket; open threads in the Instagram tab (sends "Seen"); edit old DB migrations; put message text in URLs.
- **Not verified with a real Instagram account yet** (only the fake): see docs/instagram-notes.md "First live check".
