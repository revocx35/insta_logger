import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StoryAuthor, StoryItem, StoryPage, StoryStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { F } from '../db/repo.js';
import { getReader } from '../http/server.js';

/** Logged stories (story logging, see ig/stories.ts): authors, items, status and "check now". */
export function registerStoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo } = ctx;

  app.get('/api/stories/status', async () => {
    const s: StoryStatus = ctx.ig.storyStatus();
    return s;
  });

  app.post('/api/stories/check', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req) => {
    repo.audit('stories_checked', req.ip);
    await ctx.ig.checkStoriesNow();
    return ctx.ig.storyStatus();
  });

  app.get('/api/stories/authors', async (req) => {
    const reader = getReader(ctx, req);
    const list: StoryAuthor[] = repo.listStoryUsers().map((u) => ({
      id: u.id,
      username: reader.tryText(...F.storyUsername(u.id), u.username_enc),
      name: reader.tryText(...F.storyName(u.id), u.name_enc),
      avatarUrl: u.avatar_media_id ? `/api/media/${u.avatar_media_id}` : null,
      count: u.count,
      latest: u.latest,
    }));
    return list;
  });

  app.get('/api/stories', async (req) => {
    const q = z
      .object({
        user: z.string().regex(/^\d{1,30}$/).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .strict()
      .parse(req.query);
    const reader = getReader(ctx, req);
    const names = new Map<string, string | null>();
    const username = (id: string) => {
      if (!names.has(id)) {
        const u = repo.getStoryUser(id);
        names.set(id, u ? reader.tryText(...F.storyUsername(id), u.username_enc) : null);
      }
      return names.get(id)!;
    };
    const rows = repo.listStories({ userId: q.user ?? null, before: q.before ?? null, limit: q.limit });
    const items: StoryItem[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: username(r.user_id),
      type: r.type,
      takenAt: r.taken_at,
      expiresAt: r.expires_at,
      status: r.status,
      url: r.status === 'downloaded' && r.media_id ? `/api/media/${r.media_id}` : null,
    }));
    const page: StoryPage = { items, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.taken_at : null };
    return page;
  });
}
