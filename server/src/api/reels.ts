import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WebComment, WebPage, WebPost } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { toAppError } from '../ig/sender.js';
import { COMMENT_MAX, IgReels, MEDIA_ID } from '../igweb/client.js';
import { MediaRefs } from '../igweb/media.js';
import { parseRange } from './media.js';

/**
 * The Reels section: Instagram's reels feed through the server's Instagram session, and its videos through the
 * server's browser, its comments, liking and commenting. Nothing is stored; sharing a reel to a chat uses the normal
 * send route (its link).
 */
/** Videos preloaded right away from each new page of reels (the apps warm the next ones while you watch). */
const PRELOAD_FIRST = 4;

export function registerReelsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const origin = ctx.config.igWebOrigin;
  const refs = new MediaRefs(origin === 'https://www.instagram.com' ? undefined : origin);
  const reels = new IgReels(
    () => ctx.ig.webSource(),
    (url) => refs.ref(url),
  );

  app.get('/api/reels', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { cursor } = z.object({ cursor: z.string().min(1).max(1200).optional() }).strict().parse(req.query);
    try {
      const page: WebPage<WebPost> = await reels.page(cursor ?? null);
      // Preload the first videos of the page (like Instagram does), so swiping to them doesn't wait for the download.
      const src = ctx.ig.webSource();
      if (src) {
        for (const p of page.items.slice(0, PRELOAD_FIRST)) {
          const v = p.media.find((m) => m.kind === 'video');
          const id = v ? MediaRefs.idOf(v.src) : null;
          if (id) refs.prefetch(id, src.downloader);
        }
      }
      return page;
    } catch (e) {
      throw e instanceof AppError ? e : toAppError(e);
    }
  });

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof AppError ? e : toAppError(e);
    }
  };
  const idParam = z.object({ id: z.string().regex(MEDIA_ID) });

  app.get('/api/reels/:id/comments', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { cursor } = z.object({ cursor: z.string().min(1).max(1200).optional() }).strict().parse(req.query);
    const page: WebPage<WebComment> = await call(() => reels.comments(id, cursor ?? null));
    return page;
  });

  app.post('/api/reels/:id/like', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { like } = z.object({ like: z.boolean() }).strict().parse(req.body);
    await call(() => reels.like(id, like));
    return { ok: true };
  });

  app.post('/api/reels/:id/comments', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { text, replyTo } = z
      .object({ text: z.string().trim().min(1).max(COMMENT_MAX), replyTo: z.string().regex(MEDIA_ID).optional() })
      .strict()
      .parse(req.body);
    const comment: WebComment | null = await call(() => reels.comment(id, text, replyTo ?? null));
    ctx.repo.audit(replyTo ? 'reel_comment_replied' : 'reel_commented', req.ip);
    return { comment };
  });

  app.get('/api/reels/media/:ref', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { ref } = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(req.params);
    const src = ctx.ig.webSource();
    if (!src) throw Errors.unavailable('Instagram is not connected.');
    const f = await refs.get(ref, src.downloader);
    if (!f) throw Errors.notFound('Video');
    const size = f.data.length;
    reply.header('Content-Type', f.mime);
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('Accept-Ranges', 'bytes');
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      reply.code(416);
      reply.header('Content-Range', `bytes */${size}`);
      return reply.send();
    }
    if (!range) {
      reply.header('Content-Length', String(size));
      return reply.send(f.data);
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', String(range.end - range.start + 1));
    return reply.send(f.data.subarray(range.start, range.end + 1));
  });
}
