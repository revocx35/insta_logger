import type { WebMedia, WebPost, WebUser } from '../../../shared/api.js';

/*
 * Instagram Web's media/user/comment dicts ("XDT" shapes, the same in REST answers and in the GraphQL `xdt_api__v1__…`
 * fields) → the app's Web* types. Everything is optional and checked: these are Instagram's internal formats.
 * [ref] turns a CDN link into an app media URL (null when the link is not an Instagram/Meta CDN link).
 */

type Obj = Record<string, unknown>;
export type RefFn = (url: string) => string | null;

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const ID = /^[0-9_]{1,40}$/;

export function mapUser(raw: unknown, ref: RefFn): WebUser | null {
  const u = obj(raw);
  if (!u) return null;
  const id = str(u.pk) ?? str(u.pk_id) ?? str(u.id);
  const username = str(u.username);
  if (!id || !ID.test(id) || !username) return null;
  const pic = str(obj(u.hd_profile_pic_url_info)?.url) ?? str(u.profile_pic_url);
  const fs = obj(u.friendship_status);
  return {
    id,
    username,
    name: str(u.full_name),
    avatar: pic ? ref(pic) : null,
    verified: u.is_verified === true,
    private: u.is_private === true,
    following: typeof fs?.following === 'boolean' ? fs.following : null,
    hasStory: (num(u.latest_reel_media) ?? 0) > 0,
  };
}

/** The best image candidate up to ~1080 px wide (candidates come largest first). */
function bestImage(m: Obj): { url: string; w: number | null; h: number | null } | null {
  const cands = arr(obj(m.image_versions2)?.candidates)
    .map(obj)
    .filter((c): c is Obj => !!c && !!str(c.url));
  if (!cands.length) return null;
  const sized = cands.filter((c) => (num(c.width) ?? 0) <= 1080).sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0));
  const c = sized[0] ?? cands[0]!;
  return { url: str(c.url)!, w: num(c.width), h: num(c.height) };
}

function mapOne(m: Obj, ref: RefFn): WebMedia | null {
  const img = bestImage(m);
  const poster = img ? ref(img.url) : null;
  const w = num(m.original_width) ?? img?.w ?? null;
  const h = num(m.original_height) ?? img?.h ?? null;
  const videos = arr(m.video_versions)
    .map(obj)
    .filter((v): v is Obj => !!v && !!str(v.url));
  if (videos.length) {
    // A version up to 720 px wide plays smoothly through the server; else the first one.
    const v = videos.find((x) => (num(x.width) ?? 9999) <= 720) ?? videos[0]!;
    const src = ref(str(v.url)!);
    if (src) return { kind: 'video', src, poster, width: w, height: h };
  }
  if (!poster) return null;
  return { kind: 'image', src: poster, poster: null, width: w, height: h };
}

export function mapPost(raw: unknown, ref: RefFn): WebPost | null {
  const m = obj(raw);
  if (!m) return null;
  const id = str(m.pk) ?? str(m.id)?.split('_')[0] ?? null;
  const user = mapUser(m.user ?? m.owner, ref);
  if (!id || !ID.test(id) || !user) return null;
  const children = arr(m.carousel_media).map(obj).filter((c): c is Obj => !!c);
  const media = (children.length ? children : [m]).map((c) => mapOne(c, ref)).filter((x): x is WebMedia => !!x);
  if (!media.length) return null;
  const hideCounts = m.like_and_view_counts_disabled === true;
  return {
    id,
    code: str(m.code),
    user,
    takenAt: (num(m.taken_at) ?? 0) * 1000,
    caption: str(obj(m.caption)?.text),
    likeCount: hideCounts ? null : num(m.like_count),
    commentCount: num(m.comment_count),
    liked: m.has_liked === true,
    media,
    isReel: m.product_type === 'clips',
    location: str(obj(m.location)?.name),
  };
}
