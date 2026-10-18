/**
 * A fake Instagram Web for end-to-end tests of the real stack (no Instagram account needed).
 *
 * It speaks what insta_logger reads from the real site: an inbox page with Instagram Web's page modules
 * (`require('getAsyncParams')`, `CurrentUserInitialData`, `PolarisViewer`, `IGDMqttWebDeviceID`), login cookies
 * (`sessionid`, `ds_user_id`, `csrftoken`; a browser is logged in only with a session the fake issued), the message stream WebSocket at /ws/lightspeed (DGW frames → JSON envelope →
 * LSResponse protobuf → Slide deltas, built with the same encoder the unit tests check against mautrix-meta's Go
 * implementation), the GraphQL queries/mutations at /api/graphql (answers prefixed with "for (;;);" like Instagram),
 * Mercury uploads, and CDN files at /cdn/*. The page itself sends one GraphQL request with a *changed* doc id so the
 * app's doc id learning is exercised.
 *
 *   cd server && npx tsx ../scripts/dev/fake-instagram.mts [port]
 * Control API (for the test driver, host only): GET /control/log · POST /control/deliver {chatId, message} ·
 * POST /control/delta {delta} · POST /control/store {op: add|remove, chatId, message|messageId} · POST /control/logout
 * (ends every session; the login page stops logging in) · POST /control/login (the login page logs in again) ·
 * POST /control/issue-session (a login made in another browser: answers its Cookie header)
 */
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer, type WebSocket } from '../../server/node_modules/ws/wrapper.mjs';
import { encodeDeltaMessage } from '../../server/src/ig/dgw.ts';
import type { IgMessage } from '../../server/src/ig/types.ts';
import { ALI, AYSE, CAN, CDN, CHAT, FakeIg, GROUP, ME, ME_IG, OTHER, USERS, adminMsg, albumMsg, at, delta, imageMsg, mid, shareMsg, textMsg, thread, videoMsg, voiceMsg } from '../../server/src/testutil/igfixtures.ts';

const PORT = Number(process.argv[2] ?? 18555);
const HOST = process.env.FAKE_IG_HOST ?? 'fakeig';
const ORIGIN = `http://${HOST}:${PORT}`;
const CDN_FAKE = `${ORIGIN}/cdn`;

/* ------------------------------------------------------------------- data */

const ig = new FakeIg();
const now = Date.now();
const T = (minAgo: number) => now - minAgo * 60_000;
ig.add(CHAT, [ME, ALI], [
  textMsg(mid(1), 'Hey! Are we still on for Saturday? 🎉', T(300)),
  textMsg(mid(2), 'Yes, see you there', T(299), { sender: ME }),
  imageMsg(mid(3), T(298), {}, ['history_photo.png']),
  ...Array.from({ length: 30 }, (_, i) => textMsg(mid(100 + i), `older message ${i}`, T(1000 - i))),
]);
ig.add(GROUP, [ME, ALI, AYSE, CAN], [adminMsg(mid(50), T(400), 'Ali created the group.', { chat: GROUP }), textMsg(mid(51), 'Who brings the tent?', T(200), { chat: GROUP, sender: AYSE })], {
  group: true,
  title: 'Weekend plans',
});
ig.add(OTHER, [ME, AYSE], [shareMsg(mid(60), T(100), { chat: OTHER, sender: AYSE }, 'look at this')]);

const fakeUrls = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll(CDN, CDN_FAKE)) as T;

/* ------------------------------------------------------------------- page */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Instagram (fake)</title></head>
<body style="font-family:sans-serif"><h1>Fake Instagram inbox</h1><p id="s">connecting…</p>
<script>
  const ME = ${JSON.stringify(ME)}, ME_IG = ${JSON.stringify(ME_IG)};
  const modules = {
    getAsyncParams: () => ({ __a: 1, __user: ME_IG, __req: 'a', lsd: 'LSD_TOKEN_x', jazoest: '2900', __comet_req: 7 }),
    DTSGInitData: { token: 'DTSG_TOKEN_x' },
    LSD: { token: 'LSD_TOKEN_x' },
    CurrentUserInitialData: { IG_USER_EIMU: ME, NON_FACEBOOK_USER_ID: ME_IG, USER_ID: ME_IG },
    PolarisViewer: { data: { id: ME_IG, username: 'owner.account', full_name: 'Owner Person', fbid: '1784' } },
    IGDMqttWebDeviceID: { clientId: 'device-1234' },
  };
  window.require = (n) => { if (!(n in modules)) throw new Error('Requiring unknown module ' + n); return modules[n]; };
  function connect() {
    const ws = new WebSocket('ws://' + location.host + '/ws/lightspeed?cid=device-1234');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { document.getElementById('s').textContent = 'stream open'; };
    ws.onclose = () => setTimeout(connect, 2000);
  }
  connect();
  // Like Instagram Web loading a thread: a GraphQL request with this build's doc id.
  fetch('/api/graphql', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459', 'x-asbd-id': '359341' },
    body: 'fb_api_req_friendly_name=IGDThreadDetailQuery&doc_id=4242424242424242&variables=%7B%22thread_fbid%22%3A%22${CHAT}%22%7D', credentials: 'include' });
</script></body></html>`;

const LOGIN = `<!doctype html><html><body><h1>Log into Instagram (fake)</h1><form method="post" action="/accounts/login/ajax/"><button>Log in</button></form></body></html>`;

/* --------------------------------------------------------------- helpers */

function png(seed: string): Buffer {
  const h = crypto.createHash('sha256').update(seed).digest();
  const w = 64;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([h[0]!, h[1]! ^ x, h[2]! ^ y], y * (w * 3 + 1) + 1 + x * 3);
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sockets = new Set<WebSocket>();
const log: { kind: string; name?: string; ok?: boolean; detail?: unknown }[] = [];
/** Whether the login page logs a browser in (as if the owner typed the password). */
let loggedIn = true;
/** Valid `sessionid` values: a browser is logged in when it sends one of them. */
const sessions = new Set<string>();
let counter = 1000;

function push(...deltas: object[]): void {
  const frame = encodeDeltaMessage(fakeUrls(deltas));
  for (const s of sockets) s.send(frame);
}

function deliver(chatId: string, m: IgMessage): void {
  ig.push(chatId, m);
  push(delta('SlideUQPPNewMessage', chatId, { message: m }));
}

function findMsg(id: string): { chatId: string; m: IgMessage } | null {
  for (const [chatId, t] of ig.threads) {
    const m = t.messages.find((x) => x.message_id === id);
    if (m) return { chatId, m };
  }
  return null;
}

async function body(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** A new login session ("<user id>%3A<random>%3A1", like Instagram's). */
function newSession(): string {
  const s = `${ME_IG}%3A${crypto.randomBytes(9).toString('hex')}%3A1`;
  sessions.add(s);
  return s;
}

/** The request's session, when it is a valid one. */
function sessionOf(req: http.IncomingMessage): string | null {
  const m = /(?:^|;\s*)sessionid=([^;]+)/.exec(req.headers.cookie ?? '');
  return m && sessions.has(m[1]!) ? m[1]! : null;
}

function cookies(session: string | null): string[] {
  return session
    ? [`sessionid=${session}; Path=/; HttpOnly`, `ds_user_id=${ME_IG}; Path=/`, 'csrftoken=CSRF_TOKEN_x; Path=/']
    : ['csrftoken=CSRF_TOKEN_x; Path=/', 'sessionid=; Path=/; Max-Age=0', 'ds_user_id=; Path=/; Max-Age=0'];
}

function gql(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(`for (;;);${JSON.stringify({ data: fakeUrls(data) })}`);
}

/* ---------------------------------------------------------------- graphql */

async function graphql(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const form = new URLSearchParams((await body(req)).toString());
  const name = form.get('fb_api_req_friendly_name') ?? '';
  const vars = JSON.parse(form.get('variables') ?? '{}') as Record<string, unknown>;
  const headersOk = req.headers['x-csrftoken'] === 'CSRF_TOKEN_x' && req.headers['x-fb-lsd'] === 'LSD_TOKEN_x' && form.get('fb_dtsg') === 'DTSG_TOKEN_x' && form.get('lsd') === 'LSD_TOKEN_x';
  log.push({ kind: 'graphql', name, ok: headersOk, detail: { docId: form.get('doc_id'), appId: req.headers['x-ig-app-id'] ?? null, asbd: req.headers['x-asbd-id'] ?? null } });
  if (!sessionOf(req)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('for (;;);{"error":1357001,"errorSummary":"Not logged in"}');
    return;
  }
  const otid = () => `mid.$sent${(++counter).toString(16)}`;
  switch (name) {
    case 'PolarisDirectInboxQuery': {
      const page = await ig.inbox();
      return gql(res, { get_slide_mailbox_for_iris_subscription: { id: ME, threads_by_folder: { edges: page.threads.map((t) => ({ node: { as_ig_direct_thread: t } })), page_info: { has_next_page: false } } } });
    }
    case 'IGDThreadDetailQuery':
      return gql(res, { get_slide_thread_nullable: { as_ig_direct_thread: await ig.thread(String(vars.thread_fbid)) } });
    case 'IGDMessageListOffMsysQuery': {
      const p = await ig.messages(String(vars.id), { after: (vars.after as string) ?? null, olderThan: (vars.older_than_message_id as string) ?? null });
      return gql(res, {
        fetch__SlideThread: { as_ig_direct_thread: { slide_messages: { edges: p.messages.map((m) => ({ node: m })), page_info: { end_cursor: p.cursor, has_next_page: p.hasMore } } } },
      });
    }
    case 'PolarisClipsTabDesktopPaginationQuery': {
      // Two pages of reels (videos from the fake CDN), like Instagram's /reels/ feed.
      const page = vars.after === 'REELS_P2' ? 2 : 1;
      log.push({ kind: 'reels', detail: { page, seen: (vars.data as { seen_reels?: string })?.seen_reels ?? null } });
      const reel = (n: number) => ({
        node: {
          __typename: 'XDTClipsItem',
          media: {
            pk: String(3900000000000000000n + BigInt(n)),
            code: `FAKEREEL${n}`,
            taken_at: Math.floor(Date.now() / 1000) - n * 60,
            product_type: 'clips',
            media_type: 2,
            caption: { text: `Reel number ${n}` },
            like_count: 1000 * n,
            comment_count: 10 * n,
            original_width: 720,
            original_height: 1280,
            video_versions: [{ width: 720, height: 1280, url: `${CDN}/reel${n}.mp4` }],
            image_versions2: { candidates: [{ width: 720, height: 1280, url: `${CDN}/reel${n}.jpg` }] },
            user: { pk: '777', username: 'reel.maker', full_name: 'Reel Maker', is_verified: true, profile_pic_url: `${CDN}/maker.jpg` },
          },
        },
        cursor: '',
      });
      return gql(res, {
        xdt_api__v1__clips__home__connection_v2: {
          edges: page === 1 ? [reel(1), reel(2), reel(3)] : [reel(4)],
          page_info: { end_cursor: page === 1 ? 'REELS_P2' : null, has_next_page: page === 1 },
        },
      });
    }
    case 'IGDirectTextSendMutation': {
      const chatId = String(vars.ig_thread_igid);
      const text = (vars.text as { sensitive_string_value: string }).sensitive_string_value;
      const id = otid();
      const reply = vars.reply_to_message_id ? findMsg(String(vars.reply_to_message_id)) : null;
      const m = textMsg(id, text, Date.now(), { chat: chatId, sender: ME, reply: reply ? { id: String(reply.m.message_id), message: reply.m } : undefined });
      setTimeout(() => deliver(chatId, m), 150);
      log.push({ kind: 'sent_text', detail: { chatId, text, reply: vars.reply_to_message_id ?? null } });
      return gql(res, { xig_direct_text_send_with_slide_messaging_response: { message_id: id, id, timestamp_ms: String(Date.now()) } });
    }
    case 'IGDirectMediaSendMutation': {
      const chatId = String(vars.thread_id);
      const id = otid();
      const m = imageMsg(id, Date.now(), { chat: chatId, sender: ME }, [`upload_${String(vars.attachment_fbid)}.png`]);
      setTimeout(() => deliver(chatId, m), 150);
      log.push({ kind: 'sent_media', detail: { chatId, attachment: vars.attachment_fbid } });
      return gql(res, { xig_direct_media_send_with_slide_messaging_response: { message_id: id, id, timestamp_ms: String(Date.now()) } });
    }
    case 'IGDirectReactionSendMutation': {
      const input = vars.input as { emoji: string; message_id: string; reaction_status: string; thread_id: string };
      push(delta(input.reaction_status === 'created' ? 'SlideUQPPCreateReaction' : 'SlideUQPPDeleteReaction', input.thread_id, { message_id: input.message_id, reaction: { reaction: input.emoji, sender_fbid: ME, reaction_timestamp_ms: String(Date.now()) } }));
      log.push({ kind: 'react', detail: input });
      return gql(res, { xig_direct_reaction_send_with_slide_messaging_response: { id: input.message_id, reactions: [] } });
    }
    case 'IGDirectEditMessageMutation': {
      const text = (vars.body as { sensitive_string_value: string }).sensitive_string_value;
      push(delta('SlideUQPPEditMessage', String(vars.thread_id), { message_id: vars.target_message_id, text_body: text, slide_edit_history_entry: { timestamp_ms: String(Date.now()) } }));
      log.push({ kind: 'edit', detail: { id: vars.target_message_id, text } });
      return gql(res, { direct_edit_message_with_slide_messaging_response: { message_id: vars.target_message_id } });
    }
    case 'IGDMessageUnsendDialogOffMsysMutation': {
      const id = String(vars.message_id);
      const f = findMsg(id);
      if (f) {
        ig.remove(f.chatId, id);
        push(delta('SlideUQPPDeleteMessage', f.chatId, { message_id: id }));
      }
      log.push({ kind: 'unsend', detail: { id, longThread: (vars.send_data as { thread_id?: string })?.thread_id } });
      return gql(res, { direct_unsend_message: true });
    }
    case 'useIGDMarkThreadAsReadMutation':
      log.push({ kind: 'mark_seen', detail: vars });
      return gql(res, { xig_direct_item_seen_mutation_with_slide_messaging_response: { participant_fbid: ME } });
    default:
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`for (;;);${JSON.stringify({ data: null, errors: [{ message: `unknown query ${name}` }] })}`);
  }
}

/* ----------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', ORIGIN);
    const p = url.pathname;
    if (p.startsWith('/control/')) {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
        res.writeHead(403).end();
        return;
      }
      const b = req.method === 'POST' ? (JSON.parse((await body(req)).toString() || '{}') as Record<string, unknown>) : {};
      if (p === '/control/log') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ log, sockets: sockets.size }));
      } else if (p === '/control/deliver') {
        deliver(String(b.chatId), b.message as IgMessage);
        res.writeHead(200).end('ok');
      } else if (p === '/control/delta') {
        push(b.delta as object);
        res.writeHead(200).end('ok');
      } else if (p === '/control/store') {
        if (b.op === 'add') ig.push(String(b.chatId), b.message as IgMessage);
        else ig.remove(String(b.chatId), String(b.messageId));
        res.writeHead(200).end('ok');
      } else if (p === '/control/logout') {
        loggedIn = false;
        sessions.clear();
        for (const s of sockets) s.close();
        res.writeHead(200).end('ok');
      } else if (p === '/control/login') {
        loggedIn = true;
        res.writeHead(200).end('ok');
      } else if (p === '/control/issue-session') {
        // A login made in another browser: its Cookie header, as the owner would copy it.
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cookie: `csrftoken=CSRF_TOKEN_x; ds_user_id=${ME_IG}; sessionid=${newSession()}; mid=fakemid` }));
      } else res.writeHead(404).end();
      return;
    }
    // Reels: comments, likes, new comments (Instagram Web's REST endpoints).
    const rm = /^\/api\/v1\/(media\/(\d+)\/comments|web\/likes\/(\d+)\/(like|unlike)|web\/comments\/(\d+)\/add)\/$/.exec(p);
    if (rm) {
      const okHeaders = req.headers['x-csrftoken'] === 'CSRF_TOKEN_x' && !!req.headers['x-ig-app-id'];
      if (!sessionOf(req)) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"login_required","status":"fail"}');
      const json = (v: unknown) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fakeUrls(v)));
      const who = { pk: '888', username: 'commenter', full_name: 'Com Menter', profile_pic_url: `${CDN}/commenter.jpg` };
      if (rm[2] && req.method === 'GET') {
        log.push({ kind: 'reel_comments', ok: okHeaders, detail: { id: rm[2], minId: url.searchParams.get('min_id') } });
        const page2 = url.searchParams.get('min_id') === 'C_P2';
        return json({ comments: page2 ? [{ pk: '17000000000000003', text: 'third', created_at: 1792000000, user: who }] : [{ pk: '17000000000000001', text: 'first!', created_at: 1792000000, comment_like_count: 2, user: who }, { pk: '17000000000000002', text: 'second', created_at: 1792000100, user: who }], has_more_headload_comments: !page2, next_min_id: page2 ? null : 'C_P2', status: 'ok' });
      }
      if (rm[3] && req.method === 'POST') {
        log.push({ kind: 'reel_like', ok: okHeaders, detail: { id: rm[3], action: rm[4] } });
        return json({ status: 'ok' });
      }
      if (rm[5] && req.method === 'POST') {
        const form = new URLSearchParams((await body(req)).toString());
        log.push({ kind: 'reel_comment', ok: okHeaders, detail: { id: rm[5], text: form.get('comment_text') } });
        return json({ id: '17000000000000099', text: form.get('comment_text'), created_at: Math.floor(Date.now() / 1000), from: { pk: ME_IG, username: 'owner.account', full_name: 'Owner Person' }, status: 'ok' });
      }
    }
    if (p === '/api/graphql' && req.method === 'POST') return graphql(req, res);
    if (p === '/ajax/mercury/upload.php' && req.method === 'POST') {
      const data = await body(req);
      const id = String(17900000000000000n + BigInt(++counter));
      log.push({ kind: 'upload', detail: { bytes: data.length, voice: data.includes(Buffer.from('name="voice_clip"')), ok: req.headers['x-csrftoken'] === 'CSRF_TOKEN_x' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      // A bare 17-digit number, as Instagram sends it: must not lose precision.
      res.end(`for (;;);{"__ar":1,"payload":{"uploadID":"x","metadata":{"0":{"image_id":${id},"filename":"photo.png","filetype":"image/png"}}}}`);
      return;
    }
    if (p.startsWith('/cdn/')) {
      if (p.includes('expired')) {
        res.writeHead(403).end();
        return;
      }
      const name = decodeURIComponent(p.slice(5));
      const isVideo = /\.mp4$/.test(name);
      const data = isVideo ? Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42'), crypto.createHash('sha256').update(name).digest()]) : png(name);
      res.writeHead(200, { 'content-type': isVideo ? 'video/mp4' : 'image/png', 'content-length': data.length, 'access-control-allow-origin': '*' });
      res.end(data);
      return;
    }
    const session = sessionOf(req);
    if (p.startsWith('/accounts/login')) {
      // Like Instagram: a logged-in browser is sent on from the login page.
      const s = session ?? (loggedIn ? newSession() : null);
      if (s) {
        res.writeHead(302, { location: '/', 'set-cookie': cookies(s) }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookies(null) });
      res.end(LOGIN);
      return;
    }
    if (!session) {
      res.writeHead(302, { location: '/accounts/login/?next=%2Fdirect%2Finbox%2F' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookies(session), 'cache-control': 'no-store' });
    res.end(PAGE);
  })().catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!(req.url ?? '').startsWith('/ws/lightspeed') || !sessionOf(req)) {
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    sockets.add(ws);
    log.push({ kind: 'socket_open' });
    ws.send(encodeDeltaMessage([], { subscribe: { subscribed: 10, latest: 10 } }));
    // Keep-alive pings like the gateway's.
    const ping = setInterval(() => ws.send(Buffer.from([9])), 5000);
    ws.on('close', () => {
      clearInterval(ping);
      sockets.delete(ws);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`fake instagram on ${ORIGIN} (listening on 0.0.0.0:${PORT})`));

export { USERS, albumMsg, at, thread, videoMsg, voiceMsg };
