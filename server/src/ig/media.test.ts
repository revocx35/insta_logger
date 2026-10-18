import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import { CHAT, FakeIg, ME, ME_IG, ALI, at, imageMsg, mid, textMsg, videoMsg } from '../testutil/igfixtures.js';
import { classifyUrl } from './browser.js';
import { Ingest } from './ingest.js';
import { MediaQueue, isInstagramCdn, pickMime, type Downloader, type FetchOutcome } from './media.js';
import { IgRequestError, parseGraphQL } from './page.js';

class FakeDownloader implements Downloader {
  files = new Map<string, { data: Buffer; mime: string } | { http: number }>();
  calls: string[] = [];
  async fetch(url: string, maxBytes: number, sink: (c: Buffer) => Promise<void>): Promise<FetchOutcome> {
    this.calls.push(url);
    const key = [...this.files.keys()].find((k) => url.includes(k));
    const f = key ? this.files.get(key)! : { http: 404 };
    if ('http' in f) return { status: 'http', code: f.http };
    if (f.data.length > maxBytes) return { status: 'too_large' };
    for (let i = 0; i < f.data.length; i += 1000) await sink(f.data.subarray(i, i + 1000));
    return { status: 'ok', mime: f.mime, size: f.data.length };
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('media queue', () => {
  let h: Harness;
  let c: TestClient;
  let ig: FakeIg;
  let dl: FakeDownloader;
  let ingest: Ingest;
  let queue: MediaQueue;
  let refreshed: string[];

  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
    ig = new FakeIg().add(CHAT, [ME, ALI], [textMsg(mid(1), 'hi', at(1))]);
    dl = new FakeDownloader();
    refreshed = [];
    ingest = new Ingest(h.ctx, ig, { enqueue: (id, p) => queue.enqueue(id, p) }, () => ({ fbids: new Set([ME]), igId: ME_IG }));
    queue = new MediaQueue(h.ctx, {
      downloader: () => dl,
      sources: ingest.sources,
      refresh: async (row) => {
        refreshed.push(row.id);
        const m = ig.threads.get(CHAT)!.messages.find((x) => x.message_id === row.id);
        if (m) await ingest.message(m, 'live');
      },
    });
    queue.resume();
  });
  afterEach(async () => {
    queue.stop();
    await h.close();
  });

  it('downloads into encrypted storage and serves the file', async () => {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i & 255));
    dl.files.set('photo1.jpg', { data, mime: 'image/jpeg' });
    await ingest.message(imageMsg(mid(2), at(2)), 'live');
    await until(() => h.ctx.repo.getMessage(mid(2))!.media_status === 'downloaded');
    const msg = (await c.req('GET', `/api/messages/${encodeURIComponent(mid(2))}`)).body;
    expect(msg.media).toMatchObject({ status: 'downloaded', mime: 'image/jpeg', size: 5000 });
    const r = await h.app.inject({ method: 'GET', url: msg.media.url, headers: { cookie: c.cookie } });
    expect(r.rawPayload.equals(data)).toBe(true);
    expect(ingest.sources.get(mid(2))).toBeUndefined();
  });

  it('asks Instagram for a fresh link when the stored one expired', async () => {
    const data = Buffer.from('video bytes');
    dl.files.set('clip.mp4', { http: 403 });
    const v = videoMsg(mid(2), at(2));
    ig.push(CHAT, v);
    await ingest.message(v, 'live');
    await until(() => refreshed.length > 0);
    dl.files.set('clip.mp4', { data, mime: 'video/mp4' });
    // The retry after a refresh runs on a 5 s backoff: run it now.
    h.ctx.repo.updateMessage(mid(2), { media_status: 'pending' });
    queue.enqueue(mid(2), 'live');
    await until(() => h.ctx.repo.getMessage(mid(2))!.media_status === 'downloaded');
    expect(refreshed).toEqual([mid(2)]);
  });

  it('refetches links lost by a restart; gives up as unavailable when Instagram has none', async () => {
    dl.files.set('photo1.jpg', { data: Buffer.from('x'), mime: 'image/jpeg' });
    const img = imageMsg(mid(2), at(2));
    ig.push(CHAT, img);
    queue.pause();
    await ingest.message(img, 'live');
    ingest.sources.clear();
    queue.resume();
    await until(() => h.ctx.repo.getMessage(mid(2))!.media_status === 'downloaded');
    expect(refreshed).toEqual([mid(2)]);

    queue.pause();
    await ingest.message(imageMsg(mid(3), at(3)), 'live');
    ingest.sources.clear();
    h.ctx.repo.updateMessage(mid(3), { media_attempts: 1 });
    queue.resume();
    await until(() => h.ctx.repo.getMessage(mid(3))!.media_status === 'unavailable');
  });

  it('refuses files above the size limit and links outside Instagram', async () => {
    h.ctx.settings.update({ mediaMaxMb: 1 });
    dl.files.set('photo1.jpg', { data: Buffer.alloc(1024 * 1024 + 1), mime: 'image/jpeg' });
    await ingest.message(imageMsg(mid(2), at(2)), 'live');
    await until(() => h.ctx.repo.getMessage(mid(2))!.media_status === 'too_large');
    const evil = imageMsg(mid(3), at(3));
    evil.content!.attachments![0]!.attachment_cdn_url = 'https://evil.example/photo1.jpg';
    evil.content!.attachments![0]!.preview_cdn_url = undefined;
    await ingest.message(evil, 'live');
    await until(() => h.ctx.repo.getMessage(mid(3))!.media_status === 'unavailable');
    expect(dl.calls.some((u) => u.includes('evil'))).toBe(false);
  });

  it('knows Instagram CDN hosts and safe media types', () => {
    expect(isInstagramCdn('https://scontent-ist1-1.cdninstagram.com/v/x.jpg')).toBe(true);
    expect(isInstagramCdn('https://video.fsaw1-1.fna.fbcdn.net/o1/v.mp4')).toBe(true);
    expect(isInstagramCdn('http://scontent.cdninstagram.com/x')).toBe(false);
    expect(isInstagramCdn('https://cdninstagram.com.evil.example/x')).toBe(false);
    expect(isInstagramCdn('https://fake.test/x.jpg', 'https://fake.test')).toBe(true);
    expect(pickMime('image/webp; charset=x', 'image/jpeg')).toBe('image/webp');
    expect(pickMime('text/html', 'image/jpeg')).toBe('image/jpeg');
    expect(pickMime(null, null)).toBeNull();
  });
});

describe('Instagram page helpers', () => {
  it('parses GraphQL answers: data, errors, logged-out codes and deferred parts', () => {
    expect(parseGraphQL('{"data":{"a":{"b":1}}}')).toEqual({ a: { b: 1 } });
    expect(parseGraphQL('{"data":{"t":{"id":340282366841710300949128}}}')).toEqual({ t: { id: '340282366841710300949128' } });
    expect(parseGraphQL('{"data":{"t":{"x":1}}}\n{"data":{"y":2},"path":["t"]}')).toEqual({ t: { x: 1, y: 2 } });
    expect(() => parseGraphQL('{"error":1357001,"errorSummary":"not logged in"}')).toThrow(expect.objectContaining({ code: 'login' }));
    expect(() => parseGraphQL('{"error":1357004}')).toThrow(expect.objectContaining({ code: 'reload' }));
    expect(() => parseGraphQL('{"data":null,"errors":[{"message":"bad"}]}')).toThrow(IgRequestError);
    expect(() => parseGraphQL('<html>')).toThrow(expect.objectContaining({ code: 'graphql' }));
  });

  it('classifies where the Instagram tab is', () => {
    const o = 'https://www.instagram.com';
    expect(classifyUrl(`${o}/direct/inbox/`, o)).toBe('direct');
    expect(classifyUrl(`${o}/direct/t/340282366841710300001/`, o)).toBe('thread');
    expect(classifyUrl(`${o}/accounts/login/?next=%2Fdirect%2Finbox%2F`, o)).toBe('login');
    expect(classifyUrl(`${o}/challenge/action/AXE/`, o)).toBe('challenge');
    expect(classifyUrl(`${o}/accounts/login/two_factor?next=x`, o)).toBe('login');
    expect(classifyUrl(`${o}/two_factor/`, o)).toBe('challenge');
    expect(classifyUrl(`${o}/accounts/onetap/?next=%2F`, o)).toBe('other');
    expect(classifyUrl(`${o}/`, o)).toBe('other');
    expect(classifyUrl('about:blank', o)).toBe('blank');
    expect(classifyUrl('https://www.facebook.com/login', o)).toBe('other');
  });
});
