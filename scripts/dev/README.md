# Developer test tools

## fake-instagram.mts — a fake Instagram Web

Serves what insta_logger reads from instagram.com: an inbox page with Instagram Web's page modules and login cookies,
the DGW message stream WebSocket (`/ws/lightspeed`), GraphQL (`/api/graphql`, answers prefixed `for (;;);`), Mercury
uploads and CDN files. Sample chats come from `server/src/testutil/igfixtures.ts`. A control API on 127.0.0.1 lets
tests deliver messages, push deltas, change the stored history and log the browser out.

```bash
cd server && npx tsx ../scripts/dev/fake-instagram.mts 18555
```

## fake-e2e.mts — the real stack against the fake (53 checks)

Builds and starts all three images in an isolated compose project (ports 29443/29080), points `IG_WEB_ORIGIN` at the
fake, gives Chromium a test-only URL policy that also allows the fake host, and checks login detection, history import,
live messages, unsend, edits, reactions, media downloads, sending, doc id learning, the downtime reconcile, and that
neither the database files nor the app log contain content or tokens.

```bash
cd server && npx tsx ../scripts/dev/fake-e2e.mts          # --keep leaves the stack running
```

## ui-shots.mts — screenshots of the web UI

Needs a running stack with data (`fake-e2e.mts --keep`, then start `fake-instagram.mts` again) and a test browser with
DevTools on 127.0.0.1:9333 (the chromium image without the URL policy):

```bash
mkdir -p /tmp/emptypol
docker run -d --name uitest --network host --shm-size 512m \
  --security-opt seccomp=chromium/seccomp-chromium.json \
  -v /tmp/emptypol:/etc/chromium/policies/managed:ro --entrypoint chromium \
  ghcr.io/revocx35/insta_logger-chromium:latest --headless=new --remote-debugging-port=9333 \
  --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/p --no-first-run --ignore-certificate-errors about:blank
cd server && npx tsx ../scripts/dev/ui-shots.mts https://localhost:29443 /tmp/shots
```
