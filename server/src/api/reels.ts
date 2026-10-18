import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WebPage, WebPost } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { toAppError } from '../ig/sender.js';
import { IgReels } from '../igweb/client.js';
import { MediaRefs } from '../igweb/media.js';
import { parseRange } from './media.js';

/**
 * The Reels section: Instagram's reels feed through the server's Instagram session, and its videos through the
 * server's browser. Nothing is stored; sharing a reel to a chat uses the normal send route (its link).
 */
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
      return page;
    } catch (e) {
      throw e instanceof AppError ? e : toAppError(e);
    }
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
