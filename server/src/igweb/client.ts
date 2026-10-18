import type { WebComment, WebPage, WebPost } from '../../../shared/api.js';
import type { IgWebSource } from '../context.js';
import { IgRequestError } from '../ig/page.js';
import { mapComment, mapPost, type RefFn } from './mapper.js';

/*
 * The Reels section: Instagram Web's own reels feed query (the one its /reels/ page pages with), run inside its tab;
 * comments, likes and new comments through Instagram Web's REST endpoints. Variables copied from Instagram Web's
 * requests (docs/instagram-notes.md "Reels"). One request at a time.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const GAP_MS = 500;
const CURSOR = /^[A-Za-z0-9_\-=.:%+/]{1,1200}$/;
export const MEDIA_ID = /^\d{1,30}$/;
export const COMMENT_MAX = 2200;
/** Relay provider flags Instagram Web sends with this query (2026-10). */
const PV = {
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
  __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
};

export class IgReels {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  /** Reels already handed out (Instagram's pagination wants them as "seen_reels"). */
  private seen: string[] = [];

  constructor(
    private readonly src: () => IgWebSource | null,
    private readonly ref: RefFn,
  ) {}

  private paced<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async page(cursor: string | null): Promise<WebPage<WebPost>> {
    if (cursor !== null && !CURSOR.test(cursor)) throw new IgRequestError('bad_cursor', 'bad cursor');
    const src = this.src();
    if (!src) throw new IgRequestError('login', 'Instagram is not connected.');
    if (!cursor) this.seen = [];
    const d = await this.paced(() =>
      src.graphql<Obj>('PolarisClipsTabDesktopPaginationQuery', {
        after: cursor,
        before: null,
        data: { container_module: 'clips_tab_desktop_page', seen_reels: JSON.stringify(this.seen.slice(-50).map((id) => ({ id }))) },
        first: 10,
        last: null,
        ...PV,
      }),
    );
    const conn = obj(d.xdt_api__v1__clips__home__connection_v2);
    const items = arr(conn.edges)
      .map((e) => mapPost(obj(obj(e).node).media, this.ref))
      .filter((p): p is WebPost => !!p && p.media.some((m) => m.kind === 'video'));
    this.seen.push(...items.map((p) => p.id));
    const info = obj(conn.page_info);
    return { items, next: info.has_next_page === true && typeof info.end_cursor === 'string' ? info.end_cursor : null };
  }

  private source(): IgWebSource {
    const src = this.src();
    if (!src) throw new IgRequestError('login', 'Instagram is not connected.');
    return src;
  }

  async comments(id: string, cursor: string | null): Promise<WebPage<WebComment>> {
    if (!MEDIA_ID.test(id)) throw new IgRequestError('bad_id', 'bad id');
    if (cursor !== null && !CURSOR.test(cursor)) throw new IgRequestError('bad_cursor', 'bad cursor');
    const src = this.source();
    const q = new URLSearchParams({ can_support_threading: 'true', permalink_enabled: 'false' });
    if (cursor) q.set('min_id', cursor);
    const r = await this.paced(() => src.rest<Obj>('GET', `/api/v1/media/${id}/comments/?${q}`));
    const next = r.has_more_headload_comments === true || r.has_more_comments === true ? r.next_min_id : null;
    return {
      items: arr(r.comments)
        .map((c) => mapComment(c, this.ref))
        .filter((c): c is WebComment => !!c),
      next: typeof next === 'string' && next ? next : null,
    };
  }

  async like(id: string, on: boolean): Promise<void> {
    if (!MEDIA_ID.test(id)) throw new IgRequestError('bad_id', 'bad id');
    const src = this.source();
    await this.paced(() => src.rest('POST', `/api/v1/web/likes/${id}/${on ? 'like' : 'unlike'}/`, {}));
  }

  async comment(id: string, text: string): Promise<WebComment | null> {
    if (!MEDIA_ID.test(id)) throw new IgRequestError('bad_id', 'bad id');
    const body = text.trim();
    if (!body || body.length > COMMENT_MAX) throw new IgRequestError('bad_text', 'bad text');
    const src = this.source();
    const r = await this.paced(() => src.rest<Obj>('POST', `/api/v1/web/comments/${id}/add/`, { comment_text: body }));
    return mapComment({ ...r, user: r.from ?? r.user }, this.ref);
  }
}
