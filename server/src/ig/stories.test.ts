import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IgWebSource } from '../context.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';
import type { Downloader } from './media.js';
import { parseReels, parseTray, STORY_INTERVAL_MS, STORY_JITTER_MS, storyDelay, StoryLogger } from './stories.js';

const CDN = 'https://scontent-ist1-1.cdninstagram.com/v/t51';
const H = 3600_000;

const tray = (latest: Record<string, number>) => ({
  tray: [
    ...Object.entries(latest).map(([id, t]) => ({ id, reel_type: 'user_reel', latest_reel_media: t, user: { pk: id, username: `user${id}`, full_name: `User ${id}`, profile_pic_url: `${CDN}/pic${id}.jpg` } })),
    { id: 'live1', reel_type: 'live', latest_reel_media: 1, user: { pk: '999', username: 'live' } },
  ],
});

const reels = (byUser: Record<string, { pk: string; t: number; video?: boolean }[]>) => ({
  xdt_api__v1__feed__reels_media: {
    reels_media: Object.entries(byUser).map(([id, items]) => ({
      id,
      user: { pk: id, username: `user${id}` },
      items: items.map((i) => ({
        pk: i.pk,
        taken_at: i.t,
        expiring_at: i.t + 86400,
        media_type: i.video ? 2 : 1,
        ...(i.video ? { video_versions: [{ width: 480, url: `${CDN}/${i.pk}-480.mp4` }, { width: 720, url: `${CDN}/${i.pk}-720.mp4` }] } : {}),
        image_versions2: { candidates: [{ width: 640, url: `${CDN}/${i.pk}-640.jpg` }, { width: 1080, url: `${CDN}/${i.pk}-1080.jpg` }] },
      })),
    })),
  },
});

describe('story parsing', () => {
  it('reads the stories bar without live videos, own reel or bad ids', () => {
    const t = parseTray(tray({ '11': 1792300000, '22': 1792300100, '1': 1792300200 }), '1');
    expect(t.map((x) => x.id)).toEqual(['11', '22']);
    expect(t[0]).toMatchObject({ username: 'user11', name: 'User 11', latest: 1792300000000 });
  });

  it('picks the largest photo or video version', () => {
    const r = parseReels(reels({ '11': [{ pk: '501', t: 1792300000 }, { pk: '502', t: 1792300050, video: true }] }));
    expect(r[0]!.items).toEqual([
      expect.objectContaining({ id: '501', type: 'image', url: `${CDN}/501-1080.jpg`, takenAt: 1792300000000, expiresAt: 1792386400000 }),
      expect.objectContaining({ id: '502', type: 'video', url: `${CDN}/502-720.mp4`, mime: 'video/mp4' }),
    ]);
  });

  it('checks about every 45 minutes, ± up to 10, at random', () => {
    expect(storyDelay(45, () => 0)).toBe(STORY_INTERVAL_MS - STORY_JITTER_MS);
    expect(storyDelay(45, () => 0.5)).toBe(STORY_INTERVAL_MS);
    for (let i = 0; i < 100; i++) {
      const d = storyDelay(45);
      expect(d).toBeGreaterThanOrEqual(35 * 60_000);
      expect(d).toBeLessThanOrEqual(55 * 60_000);
    }
    // Short intervals: at most a quarter of it either way; long ones: still at most 10 minutes.
    expect(storyDelay(20, () => 0)).toBe(15 * 60_000);
    expect(storyDelay(240, () => 1)).toBe(250 * 60_000);
  });
});

describe('StoryLogger', () => {
  let h: Harness;
  let c: TestClient;
  let calls: string[];
  let latest: Record<string, number>;
  let items: Record<string, { pk: string; t: number; video?: boolean }[]>;
  let fails: Set<string>;
  let src: IgWebSource;

  beforeEach(async () => {
    h = await makeHarness();
    c = h.client();
    await c.signup();
    calls = [];
    fails = new Set();
    const now = Math.floor(Date.now() / 1000);
    latest = { '11': now - 60, '22': now - 120 };
    items = { '11': [{ pk: '501', t: now - 600 }, { pk: '502', t: now - 60, video: true }], '22': [{ pk: '601', t: now - 120 }] };
    const downloader: Downloader = {
      fetch: async (url, _max, sink) => {
        calls.push(`dl ${url.split('/').pop()}`);
        if ([...fails].some((f) => url.includes(f))) return { status: 'http', code: 500 };
        await sink(Buffer.from(`bytes of ${url}`));
        return { status: 'ok', mime: url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', size: 10 };
      },
    };
    src = {
      meId: '1',
      meFbid: '17841400000000099',
      downloader,
      rest: async <T>(method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return tray(latest) as T;
      },
      graphql: async <T>(name: string, vars: unknown) => {
        const ids = (vars as { reel_ids_arr: string[] }).reel_ids_arr;
        expect((vars as Record<string, unknown>).__relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider).toBe(true);
        calls.push(`${name} ${ids.join(',')}`);
        return reels(Object.fromEntries(ids.map((id) => [id, items[id] ?? []]))) as T;
      },
    };
  });
  afterEach(async () => {
    await h.close();
  });

  it('does nothing while story logging is off', async () => {
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    expect(calls).toEqual([]);
    expect(s.status().enabled).toBe(false);
  });

  it('logs new stories once, encrypted, and serves them to the owner', async () => {
    h.ctx.settings.update({ storyLogging: true });
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    expect(calls.filter((x) => x.startsWith('Polaris'))).toEqual(['PolarisStoriesV3ReelPageStandaloneQuery 11,22']);
    expect(h.ctx.repo.storyCount()).toBe(3);
    expect(s.status()).toMatchObject({ enabled: true, stories: 3, lastResult: '3 new stories from 2 accounts' });

    // Nothing new: only the stories bar is read again.
    calls = [];
    await s.run();
    expect(calls).toEqual(['GET /api/v1/feed/reels_tray/']);
    expect(s.status().lastResult).toBe('No new stories');

    const authors = (await c.req('GET', '/api/stories/authors')).body as { id: string; username: string; count: number; avatarUrl: string | null }[];
    expect(authors.map((a) => [a.id, a.username, a.count])).toEqual([
      ['11', 'user11', 2],
      ['22', 'user22', 1],
    ]);
    expect(authors[0]!.avatarUrl).toMatch(/^\/api\/media\/\d+$/);
    const page = (await c.req('GET', '/api/stories?user=11')).body as { items: { id: string; type: string; url: string; username: string }[] };
    expect(page.items.map((i) => [i.id, i.type, i.username])).toEqual([
      ['502', 'video', 'user11'],
      ['501', 'image', 'user11'],
    ]);
    const file = await c.req('GET', page.items[0]!.url);
    expect(file.status).toBe(200);
    expect(file.raw).toContain('502-720.mp4');
    // Names are stored encrypted.
    const rawUser = h.ctx.repo.getStoryUser('11')!;
    expect(rawUser.username_enc!.toString('latin1')).not.toContain('user11');
  });

  it('retries failed downloads on the next check and picks up new stories', async () => {
    h.ctx.settings.update({ storyLogging: true });
    fails.add('601');
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    expect(h.ctx.repo.getStory('601')!.status).toBe('failed');
    expect(s.status().lastResult).toBe('2 new stories from 1 account, 1 failed');
    fails.clear();
    items['11']!.push({ pk: '503', t: latest['11']! + 30 });
    latest['11'] = latest['11']! + 30;
    calls = [];
    await s.run();
    expect(calls.filter((x) => x.startsWith('Polaris'))).toEqual(['PolarisStoriesV3ReelPageStandaloneQuery 11,22']);
    expect(h.ctx.repo.getStory('601')!.status).toBe('downloaded');
    expect(h.ctx.repo.getStory('503')!.status).toBe('downloaded');
    expect(calls.filter((x) => x.includes('501') || x.includes('502'))).toEqual([]);
  });

  it('logs only the chosen accounts, but lists everyone seen for picking', async () => {
    h.ctx.settings.update({ storyLogging: true, storyAccounts: 'selected', storySelected: ['22'] });
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    expect(calls.filter((x) => x.startsWith('Polaris'))).toEqual(['PolarisStoriesV3ReelPageStandaloneQuery 22']);
    expect(h.ctx.repo.storyCount()).toBe(1);
    const accounts = (await c.req('GET', '/api/stories/accounts')).body as { id: string; username: string; selected: boolean; count: number }[];
    expect(accounts.map((a) => [a.id, a.username, a.selected, a.count])).toEqual([
      ['11', 'user11', false, 0],
      ['22', 'user22', true, 1],
    ]);
    expect((await c.req('PUT', '/api/settings', { storySelected: ['x1'] })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { storyCheckMinutes: 5 })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { storyCheckMinutes: 120, storyAccounts: 'all' })).body).toMatchObject({ storyCheckMinutes: 120, storyAccounts: 'all' });
  });

  it('says so when Instagram returns no items for accounts with new stories', async () => {
    h.ctx.settings.update({ storyLogging: true });
    items = {};
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    expect(s.status().lastResult).toMatch(/no story items/);
  });

  it('deletes stories older than the retention, with their files', async () => {
    h.ctx.settings.update({ storyLogging: true, storyRetentionDays: 2 });
    const s = new StoryLogger(h.ctx, () => src);
    await s.run();
    const media = h.ctx.repo.getStory('501')!.media_id!;
    expect(await s.prune(Date.now() + 1 * 24 * H)).toBe(0);
    expect(await s.prune(Date.now() + 3 * 24 * H)).toBe(3);
    expect(h.ctx.repo.storyCount()).toBe(0);
    expect(h.ctx.repo.getMedia(media)).toBeUndefined();
    expect((await c.req('GET', '/api/stories/authors')).body).toEqual([]);
    // Accounts seen recently stay pickable; ones not seen for 30 days are forgotten.
    expect(((await c.req('GET', '/api/stories/accounts')).body as unknown[]).length).toBe(2);
    await s.prune(Date.now() + 40 * 24 * H);
    expect((await c.req('GET', '/api/stories/accounts')).body).toEqual([]);
  });

  it('needs a login, validates input, and "check now" needs Instagram', async () => {
    expect((await h.client().req('GET', '/api/stories')).status).toBe(401);
    expect((await c.req('GET', '/api/stories?user=abc')).status).toBe(400);
    expect((await c.req('POST', '/api/stories/check', {})).status).toBe(503);
    expect((await c.req('GET', '/api/stories/status')).body).toMatchObject({ enabled: false, retentionDays: 30 });
  });
});
