import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePage, ServerEvent } from '../../../shared/api.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { ALI, AYSE, CHAT, CAN, FakeIg, GROUP, ME, ME_IG, adminMsg, albumMsg, at, delta, imageMsg, mid, ravenMsg, shareMsg, textMsg } from '../testutil/igfixtures.js';
import { Ingest, type Me } from './ingest.js';
import { Sync } from './sync.js';

describe('ingest', () => {
  let h: Harness;
  let c: TestClient;
  let ig: FakeIg;
  let ingest: Ingest;
  let queued: string[];
  let events: ServerEvent[];
  const me: Me = { fbids: new Set([ME]), igId: ME_IG };

  const page = async (chatId = CHAT) => ((await c.req('GET', `/api/chats/${chatId}/messages?limit=100`)).body as MessagePage).messages;
  const one = async (id: string) => (await c.req('GET', `/api/messages/${encodeURIComponent(id)}`)).body;

  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
    ig = new FakeIg()
      .add(CHAT, [ME, ALI], [textMsg(mid(1), 'hello there', at(1)), textMsg(mid(2), 'hi Ali', at(2), { sender: ME })])
      .add(GROUP, [ME, ALI, AYSE, CAN], [adminMsg(mid(50), at(0), 'Ali created the group', { chat: GROUP })], { group: true, title: 'Weekend plans' });
    queued = [];
    events = [];
    h.ctx.events.subscribe((e) => events.push(e));
    ingest = new Ingest(h.ctx, ig, { enqueue: (id) => queued.push(id) }, () => me);
  });
  afterEach(async () => {
    await h.close();
  });

  it('logs a new message from the stream; the first message of an unknown chat fetches the chat', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'are you coming?', at(3)) }));
    expect(ig.calls).toEqual([`thread:${CHAT}`]);
    const msgs = await page();
    expect(msgs.map((m) => m.text)).toEqual(['hello there', 'hi Ali', 'are you coming?']);
    expect(msgs.map((m) => m.fromMe)).toEqual([false, true, false]);
    expect(msgs[0]).toMatchObject({ senderName: 'Ali Veli', senderUsername: 'ali.veli', source: 'history' });
    expect(msgs[2]!.source).toBe('live');
    const chats = (await c.req('GET', '/api/chats')).body;
    expect(chats[0]).toMatchObject({ id: CHAT, kind: 'user', name: 'Ali Veli', username: 'ali.veli', messageCount: 3 });
    expect(events.some((e) => e.type === 'message' && e.messageId === mid(3))).toBe(true);
  });

  it('keeps unsent messages (and album parts) as logged copies flagged deleted', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'oops, secret', at(3)) }));
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: albumMsg(mid(4), at(4)) }));
    await ingest.delta(delta('SlideUQPPDeleteMessage', CHAT, { message_id: mid(3) }));
    await ingest.delta(delta('SlideUQPPDeleteMessage', CHAT, { message_id: mid(4) }));
    const m3 = await one(mid(3));
    expect(m3).toMatchObject({ text: 'oops, secret', deletedBy: 'sender' });
    expect(m3.deletedAt).toBeGreaterThan(0);
    for (const id of [mid(4), `${mid(4)}~1`, `${mid(4)}~2`]) expect((await one(id)).deletedAt).toBeGreaterThan(0);
    const feed = (await c.req('GET', '/api/deleted')).body;
    expect(feed.items).toHaveLength(4);
    expect(feed.items.find((i: { message: { id: string } }) => i.message.id === mid(3)).chat.name).toBe('Ali Veli');
    // An unsend of something never seen is ignored.
    await ingest.delta(delta('SlideUQPPDeleteMessage', CHAT, { message_id: mid(999) }));
  });

  it('records edits with their history, live and from history payloads', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'see you at 5', at(3)) }));
    await ingest.delta(delta('SlideUQPPEditMessage', CHAT, { message_id: mid(3), text_body: 'see you at 6', slide_edit_history_entry: { timestamp_ms: String(at(3) + 9000) } }));
    // The same edit again (e.g. from reconcile) changes nothing.
    await ingest.message(textMsg(mid(3), 'see you at 6', at(3), { edits: [{ body: 'see you at 5', ts: at(3) }, { body: 'see you at 6', ts: at(3) + 9000 }] }), 'live');
    const m = await one(mid(3));
    expect(m).toMatchObject({ text: 'see you at 6', edited: true, editCount: 1, editedAt: at(3) + 9000 });
    expect((await c.req('GET', `/api/messages/${encodeURIComponent(mid(3))}/edits`)).body).toEqual([{ body: 'see you at 5', capturedAt: expect.any(Number) }]);
    // First seen already edited: earlier versions come from Instagram's edit history.
    await ingest.message(textMsg(mid(5), 'v3', at(5), { edits: [{ body: 'v1', ts: at(5) + 1 }, { body: 'v2', ts: at(5) + 2 }, { body: 'v3', ts: at(5) + 3 }] }), 'history');
    expect(((await c.req('GET', `/api/messages/${encodeURIComponent(mid(5))}/edits`)).body as { body: string }[]).map((e) => e.body)).toEqual(['v1', 'v2']);
  });

  it('tracks reactions, including removals by log id and ones missing from a later snapshot', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'pizza?', at(3)) }));
    await ingest.delta(delta('SlideUQPPCreateReaction', CHAT, { message_id: mid(3), reaction: { reaction: '👍', sender_fbid: ALI, reaction_timestamp_ms: String(at(4)), log_message_id: 'log1' } }));
    await ingest.delta(delta('SlideUQPPCreateReaction', CHAT, { message_id: mid(3), reaction: { reaction: '❤️', sender_fbid: ME, reaction_timestamp_ms: String(at(4)) } }));
    let m = await one(mid(3));
    expect(m.reactions.map((r: { emoji: string; fromMe: boolean }) => [r.emoji, r.fromMe]).sort()).toEqual([['❤️', true], ['👍', false]]);
    await ingest.delta(delta('SlideUQPPDeleteReaction', CHAT, { message_id: 'log1', reaction: {} }));
    m = await one(mid(3));
    expect(m.reactions.map((r: { emoji: string }) => r.emoji)).toEqual(['❤️']);
    // A history snapshot without the owner's reaction: it was taken back while we weren't looking.
    await ingest.message(textMsg(mid(3), 'pizza?', at(3), { reactions: [] }), 'live');
    expect((await one(mid(3))).reactions).toEqual([]);
  });

  it('queues downloadable media but never view-once media', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: imageMsg(mid(3), at(3)) }));
    await ingest.delta(delta('SlideUQPPNewRavenMessage', CHAT, { message: ravenMsg(mid(4), at(4), 0) }));
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: shareMsg(mid(5), at(5)) }));
    expect(queued).toEqual([mid(3), mid(5)]);
    expect(ingest.sources.get(mid(3))?.url).toMatch(/photo1\.jpg/);
    expect(ingest.sources.get(mid(4))).toBeUndefined();
    const v = await one(mid(4));
    expect(v).toMatchObject({ type: 'view_once', media: { status: 'view_once', url: null } });
    const s = await one(mid(5));
    expect(s).toMatchObject({ type: 'share', share: { kind: 'Reel', title: 'natgeo' }, media: { status: 'pending' } });
  });

  it('marks own messages as seen from read receipts (one-to-one chats)', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'mine', at(3), { sender: ME }) }));
    expect((await one(mid(3))).ack).toBe(1);
    await ingest.delta(delta('SlideUQPPReadReceipt', CHAT, { read_receipt: { participant_fbid: ALI, watermark_timestamp_ms: String(at(3)) } }));
    expect((await one(mid(3))).ack).toBe(3);
    expect((await one(mid(2))).ack).toBe(3);
  });

  it('follows chat changes: names, pins, mutes, folders and deleted threads', async () => {
    await ingest.ensureChat(GROUP);
    await ingest.delta(delta('SlideUQPPThreadName', GROUP, { thread_name: 'Trip 2026', message: adminMsg(mid(51), at(51), 'Ali named the group Trip 2026', { chat: GROUP }) }));
    await ingest.delta(delta('SlideUQPPPinnedThread', GROUP, { is_pinned: true }));
    await ingest.delta(delta('SlideUQPPChangeMuteSettings', GROUP, { is_muted_now: true }));
    let chat = ((await c.req('GET', '/api/chats')).body as { id: string }[]).find((x) => x.id === GROUP)!;
    expect(chat).toMatchObject({ kind: 'group', name: 'Trip 2026', pinned: true, muted: true, folder: null, removed: false });
    await ingest.delta(delta('SlideUQPPUpdateThreadFolder', GROUP, { folder: 'PENDING' }));
    await ingest.delta(delta('SlideUQPPDeleteThread', GROUP, {}));
    chat = ((await c.req('GET', '/api/chats')).body as { id: string }[]).find((x) => x.id === GROUP)!;
    expect(chat).toMatchObject({ folder: 'PENDING', removed: true });
    expect((await page(GROUP)).map((m) => [m.type, m.text])).toEqual([
      ['system', 'Ali created the group'],
      ['system', 'Ali named the group Trip 2026'],
    ]);
  });

  it('is idempotent across live, history and reconcile', async () => {
    const m = textMsg(mid(3), 'once', at(3));
    await ingest.message(m, 'live');
    await ingest.message(m, 'history');
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: m }));
    expect((await page()).filter((x) => x.id === mid(3))).toHaveLength(1);
  });

  it('flags messages that vanished from Instagram while nobody was watching (reconcile)', async () => {
    const sync = new Sync(h.ctx, ingest, ig, () => undefined);
    for (let i = 3; i <= 30; i++) ig.push(CHAT, textMsg(mid(i), `msg ${i}`, at(i)));
    await sync.initial();
    expect((await page()).length).toBe(30);
    // Meanwhile: Ali unsent message 25 and message 2, and wrote two new ones.
    ig.remove(CHAT, mid(25));
    ig.remove(CHAT, mid(2));
    ig.push(CHAT, textMsg(mid(31), 'new one', at(31)));
    ig.push(CHAT, textMsg(mid(32), 'and another', at(32)));
    // Pretend the rows were captured a while ago (fresh rows are never flagged).
    h.ctx.repo.db.prepare('UPDATE messages SET captured_at = captured_at - 120000').run();
    await sync.reconcile();
    const msgs = await page();
    expect(msgs.length).toBe(32);
    expect(msgs.find((m) => m.id === mid(25))).toMatchObject({ text: 'msg 25', deletedBy: 'missing' });
    // Message 2 is older than the re-read window: not judged.
    expect(msgs.find((m) => m.id === mid(2))!.deletedAt).toBeNull();
    expect(msgs.filter((m) => m.deletedAt).map((m) => m.id)).toEqual([mid(25)]);
  });

  it('imports history up to the per-chat limit', async () => {
    for (let i = 3; i <= 70; i++) ig.push(CHAT, textMsg(mid(i), `msg ${i}`, at(i)));
    h.ctx.settings.update({ historyPerChat: 45 });
    const progress: unknown[] = [];
    const sync = new Sync(h.ctx, ingest, ig, (p) => progress.push(p));
    await sync.initial();
    const msgs = await page();
    // Pages of 20: 20 + 20 + 20 ≥ 45.
    expect(msgs.length).toBe(60);
    expect(msgs.at(-1)!.text).toBe('msg 70');
    expect(msgs.every((m) => m.source === 'history')).toBe(true);
    expect(progress.at(-1)).toBeNull();
    expect(progress).toContainEqual({ phase: 'history', chatsDone: 2, chatsTotal: 2 });
    expect(h.ctx.repo.getState('initial_sync_done')).toBeTruthy();
  });

  it('refetches a message page to get fresh media links', async () => {
    const sync = new Sync(h.ctx, ingest, ig, () => undefined);
    ig.push(CHAT, imageMsg(mid(3), at(3)));
    for (let i = 4; i <= 40; i++) ig.push(CHAT, textMsg(mid(i), `m${i}`, at(i)));
    await sync.initial();
    ingest.sources.clear();
    await sync.refetchAround(h.ctx.repo.getMessage(mid(3))!);
    expect(ingest.sources.get(mid(3))?.url).toMatch(/photo1/);
  });

  it('never writes message content, names or links in plaintext to the database', async () => {
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: textMsg(mid(3), 'pineapple secret', at(3)) }));
    await ingest.delta(delta('SlideUQPPNewMessage', CHAT, { message: shareMsg(mid(4), at(4)) }));
    await ingest.ensureChat(GROUP);
    h.ctx.repo.db.pragma('wal_checkpoint(TRUNCATE)');
    let blob = Buffer.alloc(0);
    for (const f of await fs.readdir(h.dir)) {
      const p = path.join(h.dir, f);
      if ((await fs.stat(p)).isFile()) blob = Buffer.concat([blob, await fs.readFile(p)]);
    }
    for (const needle of ['pineapple', 'Ali Veli', 'ali.veli', 'Weekend plans', 'natgeo', 'whale', 'cdninstagram', 'hello there']) {
      expect(blob.includes(Buffer.from(needle)), needle).toBe(false);
    }
  });
});
