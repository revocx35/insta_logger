/**
 * End-to-end test of the real stack (all three images, real Chromium) against the fake Instagram
 * (fake-instagram.mts): login detection, history import, the live message stream, unsends/edits/reactions,
 * media downloads through the browser, sending (text, reply, reaction, edit, unsend, photo upload), GraphQL doc id
 * learning, and the reconcile that catches messages unsent while the app was down.
 *
 *   cd server && npx tsx ../scripts/dev/fake-e2e.mts [--keep]
 *
 * Runs in its own compose project (own volumes and ports 29443/29080), so it never touches a real deployment.
 * The Chromium container gets a test-only URL policy that also allows the fake host.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALI, CHAT, GROUP, ME, OTHER, at, delta, imageMsg, mid, textMsg } from '../../server/src/testutil/igfixtures.ts';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const KEEP = process.argv.includes('--keep');
const PROJECT = `igl_e2e_${process.pid}`;
const HTTPS = 29443;
const FAKE_PORT = 18555;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const BASE = `https://localhost:${HTTPS}`;
const ORIGIN = BASE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the stack's internal CA; test only

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'igl-e2e-'));
const envFile = path.join(work, 'e2e.env');
let pass = 0;
let fail = 0;
const ok = (m: string) => (pass++, console.log(`  \x1b[32mPASS\x1b[0m ${m}`));
const bad = (m: string) => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m ${m}`));
const check = (c: unknown, m: string) => (c ? ok(m) : bad(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dc(...args: string[]): string {
  return execFileSync('docker', ['compose', '--env-file', envFile, '-p', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'), '-f', path.join(work, 'override.yml'), ...args], {
    cwd: ROOT,
    env: { ...process.env, IGL_ENV_FILE: envFile },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* --------------------------------------------------------------- clients */

let cookie = '';
/** The session pasted in the "log in with your own browser" check: must never reach the logs or the DB. */
let pastedSession = 'not-set';
let csrf = '';
async function api(method: string, url: string, body?: unknown, raw?: { data: Buffer; type: string; name: string }): Promise<{ status: number; json: any; buf: Buffer }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined;
  if (raw) {
    headers['content-type'] = 'application/octet-stream';
    headers['x-file-type'] = raw.type;
    headers['x-filename'] = encodeURIComponent(raw.name);
    payload = raw.data;
  } else if (body !== undefined || method !== 'GET') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  const r = await fetch(`${BASE}${url}`, { method, headers, body: payload, redirect: 'manual' });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const buf = Buffer.from(await r.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(buf.toString());
  } catch {
    json = null;
  }
  return { status: r.status, json, buf };
}

const fake = async (p: string, body?: unknown) =>
  (await fetch(`${FAKE}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).text();
const fakeLog = async () => JSON.parse(await fake('/control/log')) as { log: { kind: string; name?: string; ok?: boolean; detail?: any }[]; sockets: number };

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  bad(`timed out: ${what}`);
  return null;
}

/** Whether a CDP client is attached to the Instagram tab (asked from inside the app container: CDP is internal). */
function tabAttached(): boolean | null {
  const js = `require('node:dns/promises').lookup('chromium', { family: 4 }).then(async ({ address }) => {
    const v = await (await fetch('http://' + address + ':9223/json/version')).json();
    const ws = new WebSocket('ws://' + address + ':9223' + new URL(v.webSocketDebuggerUrl).pathname);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    ws.onmessage = (m) => {
      const t = JSON.parse(m.data).result.targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://fakeig'));
      console.log(JSON.stringify(t ? t.attached : null));
      process.exit(0);
    };
  });`;
  try {
    return JSON.parse(dc('exec', '-T', 'app', 'node', '-e', js).trim()) as boolean | null;
  } catch {
    return null;
  }
}

const message = async (id: string) => {
  const r = await api('GET', `/api/messages/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.json : null;
};

/* ------------------------------------------------------------------- main */

let fakeProc: ChildProcess | null = null;
async function main() {
  console.log('== fake instagram');
  fakeProc = spawn('npx', ['tsx', path.join(ROOT, 'scripts/dev/fake-instagram.mts'), String(FAKE_PORT)], {
    cwd: path.join(ROOT, 'server'),
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // own process group: npx's child (tsx → node) must go with it
  });
  await until('fake instagram up', async () => (await fake('/control/log')).includes('log'), 20_000);

  console.log('== config + stack');
  execFileSync('bash', [path.join(ROOT, 'scripts/setup.sh'), '--site', 'localhost', '--https-port', String(HTTPS), '--http-port', '29080', '--env-file', envFile, '--force'], { stdio: 'ignore' });
  const env = Object.fromEntries(
    fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'chromium/policies.json'), 'utf8')) as { URLAllowlist: string[] };
  policy.URLAllowlist.push('fakeig');
  fs.writeFileSync(path.join(work, 'policy.json'), JSON.stringify(policy));
  fs.chmodSync(path.join(work, 'policy.json'), 0o644);
  fs.writeFileSync(
    path.join(work, 'override.yml'),
    `services:
  app:
    environment:
      IG_WEB_ORIGIN: http://fakeig:${FAKE_PORT}
      IG_REQUEST_GAP_MS: "50"
  chromium:
    extra_hosts: ["fakeig:host-gateway"]
    volumes:
      - ${path.join(work, 'policy.json')}:/etc/chromium/policies/managed/insta_logger.json:ro
`,
  );
  dc('up', '-d', '--build', '--wait', '--wait-timeout', '300');
  const started = Date.now();

  console.log('== checks');
  const su = await api('POST', '/api/auth/signup', { setupToken: env.SETUP_TOKEN, username: 'owner', password: 'correct-horse-battery-staple' });
  check(su.status === 200, 'signup');
  csrf = (await api('GET', '/api/state')).json.csrfToken;

  const ready = await until('Instagram ready', async () => {
    const s = (await api('GET', '/api/ig/status')).json;
    return s?.state === 'ready' ? s : null;
  }, 180_000);
  check(ready?.me?.username === 'owner.account', `logged-in account read from the page (${ready?.me?.username})`);
  check((await api('POST', '/api/onboarding/complete', {})).status === 200, 'onboarding completes once Instagram is ready');

  // History import.
  const chats = (await api('GET', '/api/chats')).json as any[];
  check(chats.length === 3, `history: 3 chats imported (${chats.length})`);
  const group = chats.find((c) => c.id === GROUP);
  check(group?.kind === 'group' && group?.name === 'Weekend plans', 'group chat with name');
  const ali = chats.find((c) => c.id === CHAT);
  check(ali?.name === 'Ali Veli' && ali?.username === 'ali.veli', 'one-to-one chat named after the person');
  const page = (await api('GET', `/api/chats/${CHAT}/messages?limit=200`)).json;
  check(page.messages.length >= 33, `history: older messages paged in (${page.messages.length})`);
  const hist = await until('history photo downloaded', async () => {
    const m = await message(mid(3));
    return m?.media?.status === 'downloaded' ? m : null;
  });
  if (hist) {
    const f = await api('GET', hist.media.url);
    check(f.status === 200 && f.buf.subarray(1, 4).toString() === 'PNG', 'history photo served (fetched through the browser, decrypted)');
  }

  // Live stream.
  const L1 = 'mid.$live0001';
  await fake('/control/deliver', { chatId: CHAT, message: textMsg(L1, 'a secret I will unsend', Date.now()) });
  const live = await until('live message logged', () => message(L1), 20_000);
  check(live?.text === 'a secret I will unsend' && live?.source === 'live', 'live message from the stream is logged');
  await fake('/control/delta', { delta: delta('SlideUQPPDeleteMessage', CHAT, { message_id: L1 }) });
  const unsent = await until('unsend applied', async () => {
    const m = await message(L1);
    return m?.deletedAt ? m : null;
  }, 20_000);
  check(unsent?.text === 'a secret I will unsend' && unsent?.deletedBy === 'sender', 'unsent message keeps its logged text');
  const feed = (await api('GET', '/api/deleted')).json;
  check(feed.items.some((i: any) => i.message.id === L1), 'unsent message in the "Unsent" feed');

  const L2 = 'mid.$live0002';
  await fake('/control/deliver', { chatId: CHAT, message: textMsg(L2, 'meet at 7', Date.now()) });
  await until('second live message', () => message(L2), 20_000);
  await fake('/control/delta', { delta: delta('SlideUQPPEditMessage', CHAT, { message_id: L2, text_body: 'meet at 8', slide_edit_history_entry: { timestamp_ms: String(Date.now()) } }) });
  await fake('/control/delta', { delta: delta('SlideUQPPCreateReaction', CHAT, { message_id: L2, reaction: { reaction: '🔥', sender_fbid: ALI, reaction_timestamp_ms: String(Date.now()) } }) });
  const edited = await until('edit + reaction applied', async () => {
    const m = await message(L2);
    return m?.text === 'meet at 8' && m.reactions.length ? m : null;
  }, 20_000);
  check(edited?.editCount === 1 && edited?.reactions[0]?.emoji === '🔥', 'edit (with history) and reaction applied');
  const edits = (await api('GET', `/api/messages/${encodeURIComponent(L2)}/edits`)).json;
  check(edits?.[0]?.body === 'meet at 7', 'earlier version kept in the edit history');

  const L3 = 'mid.$live0003';
  await fake('/control/deliver', { chatId: OTHER, message: imageMsg(L3, Date.now(), { chat: OTHER, sender: ALI }, ['live_photo.png']) });
  const photo = await until('live photo downloaded', async () => {
    const m = await message(L3);
    return m?.media?.status === 'downloaded' ? m : null;
  }, 30_000);
  check(!!photo && (await api('GET', photo.media.url)).buf.length > 100, 'live photo downloaded through the browser');

  // Sending.
  const sent = await api('POST', `/api/chats/${CHAT}/send`, { text: 'hello from insta_logger', quotedId: L2 });
  check(sent.status === 200 && !!sent.json?.id, 'send text (reply) accepted');
  const echo = sent.json?.id ? await until('sent message echoed by the stream', () => message(sent.json.id), 20_000) : null;
  check(echo?.fromMe === true && echo?.quoted?.id === L2, 'sent message logged as own, quoting the reply target');
  const log1 = await fakeLog();
  check(log1.log.some((e) => e.kind === 'sent_text' && e.detail.text === 'hello from insta_logger' && e.detail.reply === L2), 'Instagram got the text and the reply id');
  check((await api('POST', `/api/messages/${encodeURIComponent(L2)}/react`, { emoji: '❤️' })).status === 200, 'react');
  await until('own reaction logged', async () => ((await message(L2))?.reactions.some((r: any) => r.fromMe) ? true : null), 20_000);
  check((await api('POST', `/api/messages/${encodeURIComponent(L2)}/react`, { emoji: '' })).status === 200, 'remove reaction');
  if (echo) {
    check((await api('POST', `/api/messages/${encodeURIComponent(echo.id)}/edit`, { text: 'hello (edited)' })).status === 200, 'edit own message');
    await until('own edit logged', async () => ((await message(echo.id))?.text === 'hello (edited)' ? true : null), 20_000);
    check((await api('POST', `/api/messages/${encodeURIComponent(echo.id)}/unsend`)).status === 200, 'unsend own message');
    const gone = await until('own unsend logged', async () => {
      const m = await message(echo.id);
      return m?.deletedAt ? m : null;
    }, 20_000);
    check(gone?.text === 'hello (edited)', 'own unsent message keeps its logged copy');
  }
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const up = await api('POST', '/api/uploads', undefined, { data: pngBytes, type: 'image/png', name: 'pixel.png' });
  check(up.status === 200, 'upload a photo');
  const sm = await api('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.json?.uploadId, kind: 'auto' });
  check(sm.status === 200 && !!sm.json?.id, 'send photo accepted');
  const sentPhoto = sm.json?.id
    ? await until('sent photo stored from the upload', async () => {
        const m = await message(sm.json.id);
        return m?.media?.status === 'downloaded' ? m : null;
      }, 30_000)
    : null;
  if (sentPhoto) check((await api('GET', sentPhoto.media.url)).buf.equals(pngBytes), 'sent photo stored from the uploaded bytes');
  const log2 = await fakeLog();
  check(log2.log.some((e) => e.kind === 'upload' && e.detail.ok && e.detail.bytes > pngBytes.length), 'Mercury upload with CSRF token');
  check(log2.log.some((e) => e.kind === 'sent_media' && /^179\d{14}$/.test(String(e.detail.attachment))), 'attachment id (> 2^53) passed on exactly');
  check(log2.log.some((e) => e.kind === 'unsend' && e.detail.longThread === `long_${CHAT}`), 'unsend used the long thread id');

  // GraphQL requests: tokens, headers learned from the page, doc id learned from the page.
  const appReqs = log2.log.filter((e) => e.kind === 'graphql' && e.ok);
  check(appReqs.length > 5 && log2.log.filter((e) => e.kind === 'graphql' && !e.ok && e.name !== 'IGDThreadDetailQuery').length === 0, 'every app GraphQL request carried csrftoken, lsd and fb_dtsg');
  check(appReqs.some((e) => e.detail.asbd === '359341'), 'headers copied from the page’s own requests');
  const later = appReqs.filter((e) => e.name === 'IGDThreadDetailQuery').map((e) => e.detail.docId);
  check(later.includes('4242424242424242'), `doc id learned from the page (${[...new Set(later)].join(',')})`);

  // Reels: the feed through the server's session, videos through the server's browser, sharing as a link.
  const r1 = (await api('GET', '/api/reels')).json as { items: any[]; next: string | null } | null;
  check(r1?.items.length === 3 && r1.next === 'REELS_P2' && r1.items[0].media[0].kind === 'video', `reels feed: first page (${r1?.items.length})`);
  check(!JSON.stringify(r1).includes('fakeig') && /^\/api\/reels\/media\/[A-Za-z0-9_-]{22}$/.test(r1?.items[0]?.media[0]?.src ?? ''), 'reel links are app links, not Instagram CDN links');
  const r2 = (await api('GET', `/api/reels?cursor=${r1?.next}`)).json as { items: any[]; next: string | null } | null;
  check(r2?.items.length === 1 && r2.next === null, 'reels feed: next page');
  check((await fakeLog()).log.filter((e) => e.kind === 'reels').some((e) => String(e.detail?.seen).includes('3900000000000000001')), 'reels already shown are passed on as seen');
  const clip = await api('GET', r1!.items[0].media[0].src);
  check(clip.status === 200 && clip.buf.subarray(4, 8).toString() === 'ftyp', `reel video served through the browser (${clip.status})`);
  const part = await fetch(`${BASE}${r1!.items[0].media[0].src}`, { headers: { origin: ORIGIN, cookie, range: 'bytes=0-3' } });
  check(part.status === 206 && (await part.arrayBuffer()).byteLength === 4, 'reel video supports range requests');
  const reelId = r1!.items[0].id as string;
  const cm = (await api('GET', `/api/reels/${reelId}/comments`)).json as { items: any[]; next: string | null } | null;
  const cm2 = (await api('GET', `/api/reels/${reelId}/comments?cursor=${cm?.next}`)).json as { items: any[] } | null;
  check(cm?.items.length === 2 && cm.items[0].text === 'first!' && cm.next === 'C_P2' && cm2?.items[0]?.text === 'third', 'reel comments, paged');
  check((await api('POST', `/api/reels/${reelId}/like`, { like: true })).status === 200 && (await api('POST', `/api/reels/${reelId}/like`, { like: false })).status === 200, 'like and unlike a reel');
  const posted = await api('POST', `/api/reels/${reelId}/comments`, { text: 'great reel' });
  check(posted.status === 200 && posted.json?.comment?.text === 'great reel', 'comment on a reel');
  const replied = await api('POST', `/api/reels/${reelId}/comments`, { text: '@commenter agreed', replyTo: cm!.items[0].id });
  check(replied.status === 200 && replied.json?.comment?.text === '@commenter agreed', 'reply to a comment');
  const rl = (await fakeLog()).log;
  check(
    rl.some((e) => e.kind === 'reel_like' && e.ok && e.detail?.action === 'like') &&
      rl.some((e) => e.kind === 'reel_like' && e.ok && e.detail?.action === 'unlike') &&
      rl.some((e) => e.kind === 'reel_comment' && e.ok && e.detail?.text === 'great reel' && e.detail?.replyTo === null) &&
      rl.some((e) => e.kind === 'reel_comment' && e.ok && e.detail?.replyTo === cm!.items[0].id),
    'like, unlike, comment and reply reached Instagram as its own mutations',
  );
  const share = await api('POST', `/api/chats/${CHAT}/send`, { text: `https://www.instagram.com/reel/${r1!.items[0].code}/` });
  check(share.status === 200 && (await fakeLog()).log.some((e) => e.kind === 'sent_text' && e.detail?.text === 'https://www.instagram.com/reel/FAKEREEL1/'), 'a reel is shared into a chat as its link');

  // Story logging: off by default; once on, "check now" saves the stories of followed accounts, encrypted.
  check((await api('GET', '/api/stories/status')).json?.enabled === false, 'story logging is off by default');
  await api('PUT', '/api/settings', { storyLogging: true, storyRetentionDays: 7 });
  const sc = (await api('POST', '/api/stories/check', {})).json;
  check(sc?.enabled === true && sc?.stories === 2, `story check saved the stories (${sc?.stories}, ${sc?.lastResult})`);
  const sa = (await api('GET', '/api/stories/authors')).json as any[];
  check(sa?.length === 1 && sa[0].username === 'story.teller' && sa[0].count === 2 && /^\/api\/media\/\d+$/.test(sa[0].avatarUrl ?? ''), 'story author with avatar (live videos skipped)');
  const sp = (await api('GET', '/api/stories')).json as { items: any[] };
  check(sp.items.map((i) => i.type).join(',') === 'video,image' && sp.items.every((i) => i.status === 'downloaded'), 'stories listed newest first, downloaded');
  const sv = await api('GET', sp.items[0].url);
  check(sv.status === 200 && sv.buf.subarray(4, 8).toString() === 'ftyp', 'story video served from the encrypted store');
  const sc2 = (await api('POST', '/api/stories/check', {})).json;
  check(sc2?.stories === 2 && sc2?.lastResult === 'No new stories', 'a second check saves nothing twice');
  check(!(await fakeLog()).log.some((e) => /Seen|seen/.test(e.name ?? '')), 'stories are never marked as seen');

  // Downtime: a message arrives and an older one is unsent while the app is stopped.
  while (Date.now() - started < 65_000) await sleep(1000);
  dc('stop', 'app');
  await fake('/control/store', { op: 'add', chatId: CHAT, message: textMsg('mid.$while_down', 'sent while you were away', Date.now()) });
  await fake('/control/store', { op: 'remove', chatId: CHAT, messageId: mid(2) });
  dc('start', 'app');
  await until('app back', async () => (await api('GET', '/api/ig/status')).json?.state === 'ready', 120_000);
  const away = await until('message from downtime logged by reconcile', () => message('mid.$while_down'), 60_000);
  check(away?.text === 'sent while you were away', 'reconcile logs messages that arrived while the app was down');
  const missing = await until('downtime unsend flagged', async () => {
    const m = await message(mid(2));
    return m?.deletedAt ? m : null;
  }, 60_000);
  check(missing?.deletedBy === 'missing' && missing?.text === 'Yes, see you there', 'message unsent while the app was down is flagged, text kept');

  // Logged out on Instagram.
  await fake('/control/logout', {});
  await api('POST', '/api/ig/restart', {});
  const lo = await until('login state', async () => ((await api('GET', '/api/ig/status')).json?.state === 'login' ? true : null), 60_000);
  check(!!lo, 'logged-out Instagram is reported as "login"');
  // Hands off while logged out: Instagram's login and its captcha can notice a debugger in the page.
  const off = await until('tab left alone while logged out', async () => tabAttached() === false, 20_000);
  await sleep(4000); // a few login-watch polls later: still nothing attached
  check(!!off && tabAttached() === false, 'nothing is attached to the Instagram tab while logged out');

  // Log in with a session from another browser, pasted as DevTools' "Copy as cURL".
  const pasted = (JSON.parse(await fake('/control/issue-session', {})) as { cookie: string }).cookie;
  pastedSession = /sessionid=([^;]+)/.exec(pasted)![1]!;
  const imp = await api('POST', '/api/ig/session', { cookies: `curl 'http://fakeig:${FAKE_PORT}/direct/inbox/' \\\n  -H 'accept: text/html' \\\n  -b '${pasted}'` });
  check(imp.status === 200, `session pasted from another browser accepted (${imp.status})`);
  const viaPaste = await until('ready with the pasted session', async () => ((await api('GET', '/api/ig/status')).json?.state === 'ready' ? true : null), 60_000);
  check(!!viaPaste, 'ready with a session pasted from another browser');
  check((await api('POST', '/api/ig/session', { cookies: `curl 'http://fakeig/' -b '${pasted}'` })).status === 409, 'pasting a session is refused while logged in');

  // Logged out again; this time the owner logs in on the login page.
  await fake('/control/logout', {});
  await api('POST', '/api/ig/restart', {});
  await until('login state again', async () => ((await api('GET', '/api/ig/status')).json?.state === 'login' ? true : null), 60_000);
  await fake('/control/login', {});
  await api('POST', '/api/ig/restart', {});
  const back = await until('ready again after login', async () => ((await api('GET', '/api/ig/status')).json?.state === 'ready' ? true : null), 90_000);
  check(!!back, 'ready again after logging back in');
  check(tabAttached() === true, 'the app attaches to the tab again once logged in');

  // No plaintext in the data volume.
  const dump = execFileSync('docker', ['compose', '--env-file', envFile, '-p', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'), '-f', path.join(work, 'override.yml'), 'exec', '-T', '-u', '10001', 'app', 'sh', '-c', 'cat /data/*.db* | base64 -w0'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const db = Buffer.from(dump, 'base64');
  const leaks = ['a secret I will unsend', 'meet at 8', 'Ali Veli', 'ali.veli', 'Weekend plans', 'hello from insta_logger', 'fakeig', 'story.teller', 'Story Teller', pastedSession].filter((s) => db.includes(Buffer.from(s)));
  check(leaks.length === 0, `no plaintext content, names or links in the database files${leaks.length ? ` (found: ${leaks.join(', ')})` : ''}`);

  const logs = dc('logs', '--no-color', 'app');
  const logLeaks = ['a secret', 'meet at', 'Ali Veli', 'DTSG_TOKEN', 'CSRF_TOKEN', pastedSession].filter((s) => logs.includes(s));
  check(logLeaks.length === 0, `no content or tokens in the app logs${logLeaks.length ? ` (found: ${logLeaks.join(', ')})` : ''}`);
  void ME;
  void at;
}

main()
  .catch((e) => {
    bad(`crashed: ${(e as Error).stack ?? e}`);
  })
  .finally(() => {
    console.log(`== result: ${pass} passed, ${fail} failed`);
    if (fail) {
      try {
        console.log(dc('logs', '--no-color', '--tail', '60', 'app').split('\n').filter((l) => !/healthz|incoming request|request completed/.test(l)).slice(-40).join('\n'));
      } catch {
        /* ignore */
      }
    }
    if (!KEEP) {
      try {
        dc('down', '-v', '--remove-orphans');
      } catch {
        /* ignore */
      }
      fs.rmSync(work, { recursive: true, force: true });
    } else console.log(`== stack left running: project=${PROJECT} url=${BASE} env=${envFile}`);
    if (fakeProc?.pid) {
      try {
        process.kill(-fakeProc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    process.exit(fail ? 1 : 0);
  });
