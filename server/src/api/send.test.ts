import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullIg, type AppContext, type IgController, type IgSender } from '../context.js';
import type { IgClient } from '../ig/api.js';
import { Ingest } from '../ig/ingest.js';
import { IgRequestError } from '../ig/page.js';
import { Sender, toAppError } from '../ig/sender.js';
import { ORIGIN, makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { ALI, CHAT, FakeIg, ME, ME_IG, OTHER, at, delta, imageMsg, mid, textMsg } from '../testutil/igfixtures.js';
import { cleanFilename, UPLOAD_MAX_BYTES } from './send.js';

type Call = { op: string; args: unknown[] };

class FakeIgCtl extends NullIg {
  log: Call[] = [];
  fail: Error | null = null;
  override readonly sender: IgSender;
  constructor() {
    super();
    const rec =
      (op: string, ret: unknown = undefined) =>
      async (...args: unknown[]) => {
        this.log.push({ op, args });
        if (this.fail) throw this.fail;
        return ret;
      };
    this.sender = {
      sendText: rec('sendText', { id: 'mid.$SENT1' }) as IgSender['sendText'],
      sendMedia: rec('sendMedia', { id: null }) as IgSender['sendMedia'],
      react: rec('react') as IgSender['react'],
      unsend: rec('unsend') as IgSender['unsend'],
      edit: rec('edit') as IgSender['edit'],
      markRead: rec('markRead') as IgSender['markRead'],
    };
  }
  ops(op: string): unknown[][] {
    return this.log.filter((c) => c.op === op).map((c) => c.args);
  }
}

const meIds = () => ({ fbids: new Set([ME]), igId: ME_IG });

async function seed(ctx: AppContext): Promise<Ingest> {
  const ig = new FakeIg().add(CHAT, [ME, ALI], []).add(OTHER, [ME, ALI], []);
  const ingest = new Ingest(ctx, ig, { enqueue: () => undefined }, meIds);
  await ingest.message(textMsg(mid(1), 'hello', at(1)), 'live');
  await ingest.message(textMsg(mid(2), 'my message', at(2), { sender: ME }), 'live');
  await ingest.message(textMsg(mid(3), 'elsewhere', at(3), { chat: OTHER }), 'live');
  return ingest;
}

async function upload(c: TestClient, h: Harness, data: Buffer, headers: Record<string, string> = {}) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { origin: ORIGIN, cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/octet-stream', ...headers },
    payload: data,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
}

describe('send API', () => {
  let h: Harness;
  let c: TestClient;
  let ig: FakeIgCtl;
  let ingest: Ingest;

  beforeEach(async () => {
    ig = new FakeIgCtl();
    h = await makeHarness({}, { ig: () => ig as IgController });
    c = h.client();
    await c.signup();
    ingest = await seed(h.ctx);
  });
  afterEach(async () => {
    await h.close();
  });

  it('sends text and replies, then marks the chat as seen', async () => {
    const r = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'Merhaba 👋', quotedId: mid(1) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'mid.$SENT1' });
    expect(ig.ops('sendText')).toEqual([[CHAT, 'Merhaba 👋', mid(1)]]);
    await new Promise((res) => setTimeout(res, 10));
    expect(ig.ops('markRead')).toEqual([[CHAT]]);
  });

  it('validates text, chat and quoted message', async () => {
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: '   ' })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'x'.repeat(1001) })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi', extra: 1 })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/999/send`, { text: 'hi' })).status).toBe(404);
    expect((await c.req('POST', `/api/chats/a.b/send`, { text: 'hi' })).status).toBe(400);
    // A quote must belong to the same chat.
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi', quotedId: mid(3) })).status).toBe(404);
    expect(ig.ops('sendText')).toEqual([]);
  });

  it('requires a session, the CSRF token and our origin', async () => {
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' }, { csrf: null })).status).toBe(403);
    expect((await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' }, { origin: 'https://evil.test' })).status).toBe(403);
    const anon = h.client();
    expect((await anon.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' })).status).toBe(401);
    const up = await h.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { origin: ORIGIN, cookie: c.cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    });
    expect(up.statusCode).toBe(403);
    expect(ig.log).toEqual([]);
  });

  it('uploads a photo and sends it once, only from the same session', async () => {
    const data = Buffer.from('fake jpeg bytes');
    const up = await upload(c, h, data, { 'x-filename': encodeURIComponent('../tatil fotoğrafı.jpg'), 'x-file-type': 'image/jpeg' });
    expect(up.status).toBe(200);
    expect(up.body.size).toBe(data.length);
    const other = h.client();
    await other.login();
    expect((await other.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto' })).status).toBe(404);
    const r = await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto', quotedId: mid(1) });
    expect(r.status).toBe(200);
    const [args] = ig.ops('sendMedia');
    expect(args![0]).toBe(CHAT);
    expect(args![1]).toMatchObject({ mime: 'image/jpeg', filename: 'tatil fotoğrafı.jpg' });
    expect((args![1] as { data: Buffer }).data.equals(data)).toBe(true);
    expect(args!.slice(2)).toEqual(['auto', mid(1)]);
    expect((await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto' })).status).toBe(404);
  });

  it('rejects bad uploads and files Instagram does not take', async () => {
    expect((await upload(c, h, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(c, h, Buffer.alloc(UPLOAD_MAX_BYTES + 1))).status).toBe(413);
    const up = await upload(c, h, Buffer.from('x'), { 'x-file-type': 'text/html\r\nX-Evil: 1' });
    expect(up.status).toBe(200);
    expect((await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'auto' })).status).toBe(400);
    expect((await c.req('POST', `/api/chats/${CHAT}/send-media`, { uploadId: up.body.uploadId, kind: 'document' })).status).toBe(400);
    expect(ig.ops('sendMedia')).toEqual([]);
    expect((await c.req('POST', '/api/uploads', { data: 'x' })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await upload(c, h, Buffer.from('y'))).status).toBe(200);
    expect((await upload(c, h, Buffer.from('z'))).status).toBe(409);
  });

  it('reacts (removal names the owner’s current emoji), unsends and edits own messages only', async () => {
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(1))}/react`, { emoji: '❤️' })).status).toBe(200);
    await ingest.delta(delta('SlideUQPPCreateReaction', CHAT, { message_id: mid(1), reaction: { reaction: '❤️', sender_fbid: ME, reaction_timestamp_ms: String(at(5)) } }));
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(1))}/react`, { emoji: '' })).status).toBe(200);
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(1))}/react`, { emoji: '<b>' })).status).toBe(400);
    expect(ig.ops('react')).toEqual([
      [mid(1), '❤️', null],
      [mid(1), '', '❤️'],
    ]);
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(2))}/edit`, { text: 'fixed' })).status).toBe(200);
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(1))}/edit`, { text: 'nope' })).status).toBe(409);
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(1))}/unsend`)).status).toBe(409);
    expect((await c.req('POST', `/api/messages/${encodeURIComponent(mid(2))}/unsend`)).status).toBe(200);
    expect((await c.req('POST', `/api/messages/nope_x/unsend`)).status).toBe(404);
    expect(ig.ops('edit')).toEqual([[mid(2), 'fixed']]);
    expect(ig.ops('unsend')).toEqual([[mid(2)]]);
    expect((await c.req('POST', `/api/chats/${CHAT}/read`)).status).toBe(200);
  });

  it('passes Instagram errors on with safe messages', async () => {
    ig.fail = toAppError(new IgRequestError('login', 'internal'));
    const r = await c.req('POST', `/api/messages/${encodeURIComponent(mid(2))}/unsend`);
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/logged out/);
    ig.fail = toAppError(new Error('internal detail /secret/path'));
    const r2 = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' });
    expect(r2.status).toBe(502);
    expect(r2.raw).not.toContain('secret');
  });
});

describe('send API without Instagram', () => {
  it('answers 503 when Instagram is not connected', async () => {
    const h = await makeHarness();
    try {
      const c = h.client();
      await c.signup();
      await seed(h.ctx);
      const r = await c.req('POST', `/api/chats/${CHAT}/send`, { text: 'hi' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('unavailable');
    } finally {
      await h.close();
    }
  });
});

describe('Sender', () => {
  let h: Harness;
  let ctx: AppContext;
  beforeEach(async () => {
    h = await makeHarness();
    ctx = h.ctx;
    await h.client().signup();
  });
  afterEach(async () => {
    await h.close();
  });

  function fakeClient(over: Partial<Record<keyof IgClient, (...a: never[]) => unknown>> = {}): { client: IgClient; ops: string[] } {
    const ops: string[] = [];
    const base: Record<string, (...a: unknown[]) => unknown> = {
      uploadBegin: async () => 'tok',
      uploadChunk: async () => undefined,
      upload: async () => '17900000000000001',
      uploadDrop: async () => undefined,
      sendMedia: async () => 'mid.$SENTIMG',
      sendText: async () => null,
      react: async () => undefined,
      unsend: async () => true,
      edit: async () => undefined,
      markSeen: async () => undefined,
      ...(over as Record<string, (...a: unknown[]) => unknown>),
    };
    const client = new Proxy(base, {
      get: (t, k: string) => async (...a: unknown[]) => {
        ops.push(k);
        return t[k]!(...a);
      },
    }) as unknown as IgClient;
    return { client, ops };
  }

  it('streams the file to the page in chunks and stores the sent media for the logged message', async () => {
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7);
    let received = 0;
    const { client, ops } = fakeClient({ uploadChunk: (async (_t: string, b64: string) => void (received += Buffer.from(b64, 'base64').length)) as never });
    const sender = new Sender(ctx, () => client, async () => 'long');
    const ig = new FakeIg().add(CHAT, [ME, ALI], []);
    const ingest = new Ingest(ctx, ig, { enqueue: () => undefined }, meIds);
    expect(await sender.sendMedia(CHAT, { data, mime: 'image/jpeg', filename: null }, 'auto', null)).toEqual({ id: 'mid.$SENTIMG' });
    expect(ops).toEqual(['uploadBegin', 'uploadChunk', 'uploadChunk', 'uploadChunk', 'upload', 'sendMedia']);
    expect(received).toBe(data.length);
    // The sent photo comes back through the stream; its link isn't needed: the uploaded bytes are stored.
    const echo = imageMsg('mid.$SENTIMG', at(9), { sender: ME });
    await ingest.message(echo, 'live');
    for (let i = 0; i < 100 && ctx.repo.getMessage('mid.$SENTIMG')!.media_status !== 'downloaded'; i++) await new Promise((r) => setTimeout(r, 20));
    const row = ctx.repo.getMessage('mid.$SENTIMG')!;
    expect(row.media_status).toBe('downloaded');
    expect(row.media_size).toBe(data.length);
  });

  it('drops the upload in the page when it fails', async () => {
    const { client, ops } = fakeClient({ upload: (async () => {
      throw new Error('upload failed (error_1)');
    }) as never });
    const sender = new Sender(ctx, () => client, async () => 'long');
    await expect(sender.sendMedia(CHAT, { data: Buffer.from('x'), mime: 'image/png', filename: null }, 'auto', null)).rejects.toMatchObject({ statusCode: 502, code: 'send_failed' });
    expect(ops).toEqual(['uploadBegin', 'uploadChunk', 'upload', 'uploadDrop']);
  });

  it('unsends with the long thread id and caps sends per hour', async () => {
    const ig = new FakeIg().add(CHAT, [ME, ALI], []);
    await new Ingest(ctx, ig, { enqueue: () => undefined }, meIds).message(textMsg(mid(2), 'mine', at(2), { sender: ME }), 'live');
    const seen: unknown[][] = [];
    const { client } = fakeClient({ unsend: (async (...a: unknown[]) => (seen.push(a), true)) as never });
    const sender = new Sender(ctx, () => client, async (chat) => `long_${chat}`);
    await sender.unsend(mid(2));
    expect(seen).toEqual([[`long_${CHAT}`, mid(2)]]);
    for (let i = 0; i < 199; i++) await sender.sendText(CHAT, 'x', null);
    await expect(sender.sendText(CHAT, 'x', null)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('is unavailable without the Instagram tab', async () => {
    const sender = new Sender(ctx, () => null, async () => null);
    await expect(sender.sendText(CHAT, 'x', null)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('cleanFilename', () => {
  it('keeps the name, drops paths and control characters', () => {
    expect(cleanFilename(encodeURIComponent('C:\\Users\\x\\rapor.jpg'))).toBe('rapor.jpg');
    expect(cleanFilename(encodeURIComponent('a\u0000b\nc.txt'))).toBe('abc.txt');
    expect(cleanFilename('%E0%A4%A')).toBeNull();
    expect(cleanFilename('..')).toBeNull();
    expect(cleanFilename(undefined)).toBeNull();
  });
});
