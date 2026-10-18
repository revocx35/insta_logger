/**
 * Dev-only: fills an insta_logger database with realistic sample data through the real ingest code
 * (so everything is encrypted exactly like production). Requires an existing owner.
 *   DATA_DIR=... SETUP_TOKEN=... VNC_PASSWORD=... npx tsx src/testutil/seed.ts
 * Not part of the production build.
 */
import zlib from 'node:zlib';
import { loadConfig } from '../config.js';
import { AppContext } from '../context.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { EventBus } from '../events.js';
import { Ingest } from '../ig/ingest.js';
import { beginMediaFile, finishMediaFile } from '../ig/media.js';
import type { IgMessage } from '../ig/types.js';
import { createLogger } from '../log.js';
import { SettingsStore } from '../settings.js';
import { ALI, AYSE, CAN, CHAT, FakeIg, GROUP, ME, ME_IG, OTHER, USERS, adminMsg, albumMsg, delta, imageMsg, ravenMsg, shareMsg, stickerMsg, textMsg, voiceMsg } from './igfixtures.js';

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const shade = ((x ^ y) & 32) ? 1 : 0.8;
      raw[o] = rgb[0] * shade;
      raw[o + 1] = rgb[1] * shade;
      raw[o + 2] = rgb[2] * shade;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const config = loadConfig();
  const log = createLogger('warn');
  const repo = new Repo(openDb(config.dbPath));
  if (!repo.hasOwner()) throw new Error('Sign up first');
  const ctx = new AppContext(config, log, repo, new EventBus(), new SettingsStore(repo, config.defaults));
  repo.setState('ig_me', JSON.stringify({ fbid: ME, igId: ME_IG }));
  const ig = new FakeIg()
    .add(CHAT, [ME, ALI], [])
    .add(GROUP, [ME, ALI, AYSE, CAN], [], { group: true, title: 'Weekend plans 🏕️' })
    .add(OTHER, [ME, AYSE], []);
  const ingest = new Ingest(ctx, ig, { enqueue: () => undefined }, () => ({ fbids: new Set([ME]), igId: ME_IG }));
  ingest.upsertContact({ id: ME, igId: ME_IG, username: 'owner.account', name: 'Owner Person', verified: false, avatarUrl: null }, true);
  for (const id of [ALI, AYSE, CAN]) {
    const u = USERS[id]!;
    ingest.upsertContact({ id, igId: String(u.id), username: u.username ?? null, name: u.full_name ?? null, verified: false, avatarUrl: null }, true);
  }

  const now = Date.now();
  let n = 0;
  const id = () => `mid.$seed${(++n).toString(16).padStart(8, '0')}`;
  async function withFile(raw: IgMessage, data: Buffer, mime: string, rowId?: string) {
    await ingest.message(raw, 'live');
    const target = rowId ?? String(raw.message_id);
    const f = await beginMediaFile(ctx);
    await f.writer.write(data);
    const { mediaId, size } = await finishMediaFile(ctx, f, 'message', mime, null);
    repo.updateMessage(target, { media_id: mediaId, media_status: 'downloaded', media_size: size });
  }

  // ---- one-to-one chat with Ali
  const t0 = now - 3 * 86400_000;
  await ingest.thread(ig.threadOfForSeed(CHAT), 'live');
  await ingest.message(textMsg(id(), 'Hey! Are we still on for Saturday? 🎉', t0), 'live');
  const q = id();
  await ingest.message(textMsg(q, 'Yes! Looking forward to it — plan is at https://example.com/plan_v2', t0 + 60_000, { sender: ME }), 'live');
  await ingest.message(textMsg(id(), 'Perfect 👍', t0 + 120_000, { reply: { id: q, message: textMsg(q, 'Yes! Looking forward to it', t0, { sender: ME }) } }), 'live');
  const del = id();
  await ingest.message(textMsg(del, 'Actually I told Ayşe your secret 🙈 (oops)', t0 + 180_000), 'live');
  await ingest.delta(delta('SlideUQPPDeleteMessage', CHAT, { message_id: del }));
  const ed = id();
  await ingest.message(textMsg(ed, 'Meet at 7pm', now - 86400_000), 'live');
  await ingest.delta(delta('SlideUQPPEditMessage', CHAT, { message_id: ed, text_body: 'Meet at 8pm instead', slide_edit_history_entry: { timestamp_ms: String(now - 86000_000) } }));
  await withFile(imageMsg(id(), now - 85000_000), png(640, 800, [131, 58, 180]), 'image/png');
  await withFile(shareMsg(id(), now - 84000_000, {}, 'this is so us 😂'), png(540, 960, [253, 29, 29]), 'image/png');
  await ingest.message(voiceMsg(id(), now - 83000_000, { sender: ME }), 'live');
  repo.db.prepare("UPDATE messages SET media_status = 'failed' WHERE type = 'voice'").run();
  await ingest.message(ravenMsg(id(), now - 3600_000, 0), 'live');
  const r = id();
  await ingest.message(textMsg(r, 'See you there!', now - 1800_000, { sender: ME }), 'live');
  ingest.reaction(r, ALI, '❤️', now - 1700_000);
  ingest.readReceipt(CHAT, ALI, now - 1600_000);

  // ---- group
  const g0 = now - 2 * 86400_000;
  await ingest.thread(ig.threadOfForSeed(GROUP), 'live');
  await ingest.message(adminMsg(id(), g0 - 100_000, 'Ali created the group.', { chat: GROUP }), 'live');
  await ingest.message(textMsg(id(), 'Who is bringing the tent? ⛺', g0, { chat: GROUP, sender: AYSE }), 'live');
  await ingest.message(textMsg(id(), 'Me! @ayse_k you bring snacks', g0 + 30_000, { chat: GROUP, sender: CAN }), 'live');
  const album = id();
  await ingest.message(albumMsg(album, g0 + 60_000, { chat: GROUP, sender: CAN }), 'live');
  for (const [i, color] of [[0, [252, 175, 69]], [2, [64, 93, 230]]] as const) {
    const f = await beginMediaFile(ctx);
    await f.writer.write(png(600, 600, color as unknown as [number, number, number]));
    const { mediaId, size } = await finishMediaFile(ctx, f, 'message', 'image/png', null);
    repo.updateMessage(i === 0 ? album : `${album}~${i}`, { media_id: mediaId, media_status: 'downloaded', media_size: size });
  }
  await ingest.message(stickerMsg(id(), g0 + 90_000, { chat: GROUP, sender: AYSE }), 'live');
  const gdel = id();
  await ingest.message(textMsg(gdel, 'Embarrassing story about Can…', g0 + 150_000, { chat: GROUP, sender: AYSE }), 'live');
  await ingest.delta(delta('SlideUQPPDeleteMessage', GROUP, { message_id: gdel }));
  await ingest.message(textMsg(id(), 'See you all 👋', g0 + 200_000, { chat: GROUP, sender: ME }), 'live');

  // ---- Ayşe, lots of history
  await ingest.thread(ig.threadOfForSeed(OTHER), 'history');
  for (let i = 0; i < 120; i++) {
    await ingest.message(textMsg(id(), `Message ${i + 1} — ${i % 7 === 0 ? '😂' : 'lorem ipsum dolor sit amet'}`, now - 5 * 86400_000 + i * 600_000, { chat: OTHER, sender: i % 3 ? AYSE : ME }), 'history');
  }

  console.log('seeded', repo.listChats().length, 'chats');
  repo.db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
