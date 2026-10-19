import type { StoryStatus } from '../../../shared/api.js';
import type { AppContext, IgWebSource } from '../context.js';
import { F } from '../db/repo.js';
import { deleteMediaFile, downloadToMedia, isInstagramCdn } from './media.js';

/*
 * Story logging (off by default): about every 45 minutes (± up to 10, random) the stories bar of the logged-in
 * account is read (`GET /api/v1/feed/reels_tray/`, the accounts the owner follows with live stories); authors with
 * stories newer than what was captured get their items fetched (`PolarisStoriesV3ReelPageStandaloneQuery`, up to 10
 * authors per request, paced) and each photo/video is downloaded through the browser into an encrypted media file.
 * Nothing is marked as seen (that needs a separate request the app never sends). Stories older than the retention
 * setting are deleted with their files.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

const ID = /^\d{1,30}$/;
export const STORY_INTERVAL_MS = 45 * 60_000;
export const STORY_JITTER_MS = 10 * 60_000;
const STALE_ACCOUNT_MS = 30 * 24 * 3600_000;
const FIRST_RUN_MS = 3 * 60_000;
const BATCH = 10;
const GAP_MS = 1500;
const MAX_AUTHORS_PER_RUN = 150;
const MAX_ATTEMPTS = 3;
const AVATAR_REFRESH_MS = 24 * 3600_000;
/** Relay provider Instagram Web's story viewer sends (2026-10-19); without it the items come back empty with
 * `missing_required_variable_value` errors. */
const STORY_PV = { __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true };

/** Delay until the next check: the interval ± a random jitter of up to a quarter of it (at most 10 minutes). */
export function storyDelay(minutes = STORY_INTERVAL_MS / 60_000, random: () => number = Math.random): number {
  const interval = minutes * 60_000;
  const jitter = Math.min(STORY_JITTER_MS, interval / 4);
  return Math.round(interval + (random() * 2 - 1) * jitter);
}

export interface TrayEntry {
  id: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  latest: number;
}

/** The stories bar → authors with live stories (newest story time in ms). Live videos and ads are skipped. */
export function parseTray(r: unknown, meId: string | null): TrayEntry[] {
  const out: TrayEntry[] = [];
  for (const t of arr(obj(r).tray)) {
    const e = obj(t);
    if (e.reel_type !== undefined && e.reel_type !== 'user_reel') continue;
    const u = obj(e.user);
    const id = str(u.pk) ?? str(u.pk_id) ?? str(u.id);
    const latest = num(e.latest_reel_media);
    if (!id || !ID.test(id) || id === meId || !latest) continue;
    out.push({ id, username: str(u.username), name: str(u.full_name), avatar: str(u.profile_pic_url), latest: latest * 1000 });
  }
  return out;
}

export interface StoryMedia {
  id: string;
  userId: string;
  type: 'image' | 'video';
  takenAt: number;
  expiresAt: number | null;
  url: string | null;
  mime: string;
}

function best(list: unknown[]): string | null {
  const c = list
    .map(obj)
    .filter((x) => str(x.url))
    .sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0));
  return c[0] ? str(c[0].url) : null;
}

/** The items of the reels in a `PolarisStoriesV3ReelPageStandaloneQuery` answer. */
export function parseReels(d: unknown): { userId: string; items: StoryMedia[] }[] {
  const out: { userId: string; items: StoryMedia[] }[] = [];
  for (const r of arr(obj(obj(d).xdt_api__v1__feed__reels_media).reels_media)) {
    const reel = obj(r);
    const userId = str(obj(reel.user).pk) ?? str(obj(reel.user).id) ?? str(reel.id);
    if (!userId || !ID.test(userId)) continue;
    const items: StoryMedia[] = [];
    for (const i of arr(reel.items)) {
      const m = obj(i);
      const id = str(m.pk) ?? str(m.id)?.split('_')[0] ?? null;
      if (!id || !ID.test(id)) continue;
      const videos = arr(m.video_versions);
      const video = videos.length > 0 || m.media_type === 2;
      items.push({
        id,
        userId,
        type: video ? 'video' : 'image',
        takenAt: (num(m.taken_at) ?? 0) * 1000,
        expiresAt: num(m.expiring_at) ? num(m.expiring_at)! * 1000 : null,
        url: video ? best(videos) : best(arr(obj(m.image_versions2).candidates)),
        mime: video ? 'video/mp4' : 'image/jpeg',
      });
    }
    out.push({ userId, items });
  }
  return out;
}

export class StoryLogger {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private wired = false;
  private last = 0;
  lastCheckAt: number | null = null;
  nextCheckAt: number | null = null;
  lastResult: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly src: () => IgWebSource | null,
  ) {}

  status(): StoryStatus {
    const s = this.ctx.settings.get();
    return {
      enabled: s.storyLogging,
      retentionDays: s.storyRetentionDays,
      stories: this.ctx.repo.storyCount(),
      lastCheckAt: this.lastCheckAt,
      nextCheckAt: s.storyLogging ? this.nextCheckAt : null,
      lastResult: this.lastResult,
    };
  }

  start(): void {
    this.stopped = false;
    // Accounts without any saved story are asked again (repairs accounts marked done by an empty answer).
    this.ctx.repo.resetEmptyStoryUsers();
    if (!this.wired) {
      this.wired = true;
      this.ctx.settings.onChange(() => this.schedule(FIRST_RUN_MS));
    }
    this.schedule(FIRST_RUN_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    if (this.stopped) return;
    // Retention also applies while logging is off.
    void this.prune().catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'story cleanup failed'));
    if (!this.ctx.settings.get().storyLogging) return;
    this.nextCheckAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      void this.run().finally(() => this.schedule(storyDelay(this.ctx.settings.get().storyCheckMinutes)));
    }, delay);
    this.timer.unref();
  }

  /** "Check now" from the UI. */
  async checkNow(): Promise<void> {
    await this.run();
    this.schedule(storyDelay(this.ctx.settings.get().storyCheckMinutes));
  }

  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      this.last = Date.now();
    }
  }

  async run(): Promise<void> {
    if (this.running || !this.ctx.settings.get().storyLogging) return;
    const src = this.src();
    const w = this.ctx.writer();
    if (!src || !w) {
      this.lastResult = 'Instagram is not connected';
      return;
    }
    this.running = true;
    const { repo, log } = this.ctx;
    let fresh = 0;
    let authors = 0;
    let failed = 0;
    let asked = 0;
    let returned = 0;
    try {
      const tray = parseTray(await this.paced(() => src.rest<Obj>('GET', '/api/v1/feed/reels_tray/')), src.meId);
      const now = Date.now();
      const settings = this.ctx.settings.get();
      const chosen = settings.storyAccounts === 'selected' ? new Set(settings.storySelected) : null;
      const need: TrayEntry[] = [];
      for (const t of tray) {
        repo.upsertStoryUser({
          id: t.id,
          username_enc: t.username ? w.encrypt(...F.storyUsername(t.id), t.username) : null,
          name_enc: t.name ? w.encrypt(...F.storyName(t.id), t.name) : null,
          now,
        });
        const u = repo.getStoryUser(t.id);
        // Every account in the bar is remembered (for picking accounts); only chosen ones are logged.
        if (chosen && !chosen.has(t.id)) continue;
        const unfinished = repo.listStories({ userId: t.id, limit: 50 }).some((s) => s.status !== 'downloaded' && s.attempts < MAX_ATTEMPTS && s.taken_at > now - 24 * 3600_000);
        if (t.latest > (u?.last_reel_at ?? 0) || unfinished) need.push(t);
        if (t.avatar && (!u?.avatar_checked_at || now - u.avatar_checked_at > AVATAR_REFRESH_MS)) await this.avatar(src, t.id, t.avatar, u?.avatar_media_id ?? null);
      }
      for (let i = 0; i < Math.min(need.length, MAX_AUTHORS_PER_RUN); i += BATCH) {
        const batch = need.slice(i, i + BATCH);
        const d = await this.paced(() => src.graphql<Obj>('PolarisStoriesV3ReelPageStandaloneQuery', { reel_ids_arr: batch.map((b) => b.id), ...STORY_PV }));
        asked += batch.length;
        for (const reel of parseReels(d)) {
          returned += reel.items.length;
          const entry = batch.find((b) => b.id === reel.userId);
          let complete = true;
          let got = 0;
          for (const it of reel.items) {
            repo.insertStory({ id: it.id, user_id: it.userId, type: it.type, taken_at: it.takenAt, expires_at: it.expiresAt, media_id: null, status: 'pending', attempts: 0, captured_at: Date.now() });
            const row = repo.getStory(it.id);
            if (!row || row.status === 'downloaded' || row.status === 'too_large' || row.attempts >= MAX_ATTEMPTS) continue;
            const ok = await this.download(src, it);
            if (ok) {
              got++;
              fresh++;
            } else {
              complete = false;
              failed++;
            }
          }
          if (got) authors++;
          // Only real items count as captured (an empty answer must not mark the account as done).
          if (complete && entry && reel.items.length) repo.setStoryUserFields(entry.id, { last_reel_at: entry.latest });
        }
      }
      if (asked && !returned) {
        // Accounts with new stories but no items at all: Instagram changed the query (doc id or variables).
        this.lastResult = 'Instagram returned no story items (its story query may have changed)';
        log.warn({ asked }, 'story query returned no items');
        return;
      }
      this.lastResult = fresh ? `${fresh} new ${fresh === 1 ? 'story' : 'stories'} from ${authors} ${authors === 1 ? 'account' : 'accounts'}${failed ? `, ${failed} failed` : ''}` : failed ? `${failed} downloads failed` : 'No new stories';
      if (fresh || failed) log.info({ fresh, authors, failed }, 'stories checked');
    } catch (e) {
      this.lastResult = 'Instagram did not answer';
      log.warn({ err: (e as Error).message }, 'story check failed');
    } finally {
      this.lastCheckAt = Date.now();
      this.running = false;
    }
  }

  private async download(src: IgWebSource, it: StoryMedia): Promise<boolean> {
    const { repo } = this.ctx;
    const row = repo.getStory(it.id)!;
    if (!it.url || !isInstagramCdn(it.url, this.testOrigin())) {
      repo.updateStory(it.id, { status: 'failed', attempts: MAX_ATTEMPTS });
      return false;
    }
    try {
      const r = await downloadToMedia(this.ctx, src.downloader, it.url, 'story', it.mime, this.ctx.mediaMaxBytes());
      if (r.status === 'ok') {
        repo.updateStory(it.id, { media_id: r.mediaId, status: 'downloaded', attempts: row.attempts + 1 });
        return true;
      }
      repo.updateStory(it.id, { status: r.status === 'too_large' ? 'too_large' : 'failed', attempts: row.attempts + 1 });
    } catch {
      repo.updateStory(it.id, { status: 'failed', attempts: row.attempts + 1 });
    }
    return false;
  }

  private async avatar(src: IgWebSource, userId: string, url: string, old: number | null): Promise<void> {
    const { repo } = this.ctx;
    repo.setStoryUserFields(userId, { avatar_checked_at: Date.now() });
    if (!isInstagramCdn(url, this.testOrigin())) return;
    try {
      const r = await downloadToMedia(this.ctx, src.downloader, url, 'avatar', 'image/jpeg', 5 * 1024 * 1024);
      if (r.status !== 'ok') return;
      repo.setStoryUserFields(userId, { avatar_media_id: r.mediaId });
      if (old) await this.dropMedia(old);
    } catch {
      /* keep the old picture */
    }
  }

  private testOrigin(): string | undefined {
    const o = this.ctx.config.igWebOrigin;
    return o === 'https://www.instagram.com' ? undefined : o;
  }

  private async dropMedia(id: number): Promise<void> {
    const m = this.ctx.repo.getMedia(id);
    if (!m) return;
    this.ctx.repo.deleteMedia(id);
    await deleteMediaFile(this.ctx, m.path);
  }

  /** Deletes stories older than the retention setting (by when they were posted), with their files. */
  async prune(now = Date.now()): Promise<number> {
    const { repo } = this.ctx;
    const cutoff = now - this.ctx.settings.get().storyRetentionDays * 24 * 3600_000;
    let n = 0;
    for (;;) {
      const rows = repo.storiesOlderThan(cutoff);
      if (!rows.length) break;
      for (const r of rows) {
        repo.deleteStory(r.id);
        if (r.media_id) await this.dropMedia(r.media_id);
        n++;
      }
    }
    const s = this.ctx.settings.get();
    for (const avatar of repo.dropEmptyStoryUsers(now - STALE_ACCOUNT_MS, s.storySelected)) await this.dropMedia(avatar);
    if (n) this.ctx.log.info({ deleted: n }, 'old stories deleted (retention)');
    return n;
  }
}
