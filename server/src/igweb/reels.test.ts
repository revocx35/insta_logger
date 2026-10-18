import { describe, expect, it } from 'vitest';
import type { IgWebSource } from '../context.js';
import type { Downloader } from '../ig/media.js';
import { IgReels } from './client.js';
import { mapPost } from './mapper.js';
import { MediaRefs } from './media.js';

const CDN = 'https://scontent-ist1-1.cdninstagram.com/v/t51/clip.mp4?oe=1&_nc_sid=x';
const IMG = 'https://scontent-ist1-1.cdninstagram.com/v/t51/cover.jpg?oe=1';

const user = { pk: '787132', username: 'natgeo', full_name: 'National Geographic', profile_pic_url: IMG, is_verified: true, friendship_status: { following: false } };
const reel = (pk: string, extra: Record<string, unknown> = {}) => ({
  pk,
  code: `C${pk}`,
  taken_at: 1792090802,
  product_type: 'clips',
  caption: { text: 'Whales!' },
  like_count: 49438,
  comment_count: 354,
  original_width: 1080,
  original_height: 1920,
  video_versions: [
    { width: 1080, height: 1920, url: `${CDN}&q=hi` },
    { width: 720, height: 1280, url: CDN },
  ],
  image_versions2: { candidates: [{ url: IMG, width: 1080, height: 1920 }] },
  user,
  ...extra,
});

describe('mapPost', () => {
  const refs = new MediaRefs();
  const ref = (u: string) => refs.ref(u);

  it('maps a reel with a ≤720 px video and a poster, through app media refs', () => {
    const p = mapPost(reel('4008597565992995700'), ref)!;
    expect(p).toMatchObject({ id: '4008597565992995700', code: 'C4008597565992995700', caption: 'Whales!', likeCount: 49438, commentCount: 354, isReel: true, takenAt: 1792090802000 });
    expect(p.user).toMatchObject({ id: '787132', username: 'natgeo', verified: true, following: false });
    expect(p.media).toHaveLength(1);
    expect(p.media[0]!.kind).toBe('video');
    expect(p.media[0]!.src).toMatch(/^\/api\/reels\/media\/[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(p)).not.toContain('cdninstagram');
  });

  it('drops links that are not Instagram CDN links, and broken items', () => {
    expect(mapPost(reel('1', { video_versions: [{ url: 'https://evil.example/x.mp4' }], image_versions2: null }), ref)).toBeNull();
    expect(mapPost({ pk: '1' }, ref)).toBeNull();
    expect(mapPost(reel('not-a-number'), ref)).toBeNull();
    expect(mapPost(null, ref)).toBeNull();
  });

  it('hides like counts when the author did', () => {
    expect(mapPost(reel('2', { like_and_view_counts_disabled: true }), ref)!.likeCount).toBeNull();
  });
});

describe('MediaRefs', () => {
  it('fetches a ref once through the browser and caches it', async () => {
    const refs = new MediaRefs();
    const path = refs.ref(CDN)!;
    expect(refs.ref(CDN)).toBe(path);
    expect(refs.ref('http://cdninstagram.com/x')).toBeNull();
    let calls = 0;
    const dl: Downloader = {
      fetch: async (_url, _max, sink) => {
        calls++;
        await sink(Buffer.from('mp4data'));
        return { status: 'ok', mime: 'video/mp4', size: 7 };
      },
    };
    const id = path.split('/').pop()!;
    const [a, b] = await Promise.all([refs.get(id, dl), refs.get(id, dl)]);
    expect(a?.data.toString()).toBe('mp4data');
    expect(b?.mime).toBe('video/mp4');
    await refs.get(id, dl);
    expect(calls).toBe(1);
    expect(await refs.get('AAAAAAAAAAAAAAAAAAAAAA', dl)).toBeNull();
  });

  it('refuses types it would not serve', async () => {
    const refs = new MediaRefs();
    const id = refs.ref(CDN)!.split('/').pop()!;
    const dl: Downloader = { fetch: async (_u, _m, sink) => (await sink(Buffer.from('<html>')), { status: 'ok', mime: 'text/html', size: 6 }) };
    expect(await refs.get(id, dl)).toBeNull();
  });
});

describe('IgReels', () => {
  it('pages the reels feed with seen reels and cursor', async () => {
    const calls: { name: string; vars: Record<string, unknown> }[] = [];
    const src: IgWebSource = {
      meId: '1',
      downloader: { fetch: async () => ({ status: 'error', reason: 'x' }) },
      graphql: async <T>(name: string, vars: unknown) => {
        calls.push({ name, vars: vars as Record<string, unknown> });
        const after = (vars as { after: string | null }).after;
        return {
          xdt_api__v1__clips__home__connection_v2: {
            edges: after ? [{ node: { media: reel('3') } }] : [{ node: { media: reel('1') } }, { node: { media: { pk: '2', user } } }],
            page_info: { has_next_page: !after, end_cursor: after ? null : 'CUR' },
          },
        } as T;
      },
    };
    const refs = new MediaRefs();
    const r = new IgReels(() => src, (u) => refs.ref(u));
    const p1 = await r.page(null);
    expect(p1.items.map((p) => p.id)).toEqual(['1']);
    expect(p1.next).toBe('CUR');
    const p2 = await r.page('CUR');
    expect(p2.items.map((p) => p.id)).toEqual(['3']);
    expect(p2.next).toBeNull();
    expect(calls[0]!.name).toBe('PolarisClipsTabDesktopPaginationQuery');
    expect(calls[1]!.vars.after).toBe('CUR');
    expect((calls[1]!.vars.data as { seen_reels: string }).seen_reels).toBe('[{"id":"1"}]');
    await expect(r.page('bad cursor!')).rejects.toThrow();
    await expect(new IgReels(() => null, (u) => refs.ref(u)).page(null)).rejects.toThrow(/not connected/);
  });
});
