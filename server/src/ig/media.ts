import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { randomBytes } from '../crypto/primitives.js';
import { MediaFileWriter } from '../crypto/stream.js';
import { F, type MessageRow } from '../db/repo.js';
import { maskId } from '../log.js';
import type { MediaSources } from './ingest.js';

/* ------------------------------------------------------ encrypted storage */

export interface PendingMediaFile {
  writer: MediaFileWriter;
  relPath: string;
  keyId: number;
}

/** Starts a new encrypted media file under DATA_DIR/media/<xx>/<random>.bin. */
export async function beginMediaFile(ctx: AppContext): Promise<PendingMediaFile> {
  const w = ctx.writer();
  if (!w) throw new Error('no owner key');
  const { id: keyId, key } = w.currentKey();
  const fileId = randomBytes(16);
  const hex = fileId.toString('hex');
  const relPath = `${hex.slice(0, 2)}/${hex}.bin`;
  const abs = path.join(ctx.config.mediaDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  return { writer: await MediaFileWriter.create(abs, key, keyId, fileId), relPath, keyId };
}

/** Finishes the file and records it in the media table. Returns the media id. */
export async function finishMediaFile(
  ctx: AppContext,
  f: PendingMediaFile,
  kind: 'message' | 'avatar' | 'story',
  mime: string | null,
  filename: string | null,
): Promise<{ mediaId: number; size: number }> {
  const w = ctx.writer();
  if (!w) {
    await f.writer.abort();
    throw new Error('no owner key');
  }
  const { size } = await f.writer.finish();
  const mediaId = ctx.repo.insertMedia({
    path: f.relPath,
    key_id: f.keyId,
    mime_enc: w.encrypt(...F.mediaMime(f.relPath), mime),
    filename_enc: w.encrypt(...F.mediaFilename(f.relPath), filename),
    size,
    kind,
    created_at: Date.now(),
  });
  return { mediaId, size };
}

export async function deleteMediaFile(ctx: AppContext, relPath: string): Promise<void> {
  await fs.rm(path.join(ctx.config.mediaDir, relPath), { force: true });
}

/* ------------------------------------------------------------- download */

export type FetchOutcome =
  | { status: 'ok'; mime: string | null; size: number }
  | { status: 'http'; code: number }
  | { status: 'too_large' }
  | { status: 'error'; reason: string };

/** Fetches a URL through the browser (the app container has no internet) and streams the body into [sink]. */
export interface Downloader {
  fetch(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome>;
}

/** Hosts Instagram serves message media, stickers and profile pictures from. Nothing else is ever fetched. */
export function isInstagramCdn(url: string, extraOrigin?: string): boolean {
  if (extraOrigin && url.startsWith(`${extraOrigin}/`)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com|fbsbx\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

const SAFE_MIME = /^(image\/(jpeg|png|gif|webp|avif|heic)|video\/(mp4|webm|quicktime)|audio\/(mp4|mpeg|aac|ogg|webm|wav|x-m4a))$/;

/** The Content-Type the CDN sent, when it is a media type we know; else the type the message implied. */
export function pickMime(header: string | null, implied: string | null): string | null {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (SAFE_MIME.test(base)) return base;
  return implied;
}

/** Downloads [url] into a new encrypted media file. */
export async function downloadToMedia(
  ctx: AppContext,
  dl: Downloader,
  url: string,
  kind: 'message' | 'avatar' | 'story',
  impliedMime: string | null,
  maxBytes: number,
): Promise<{ status: 'ok'; mediaId: number; size: number } | Exclude<FetchOutcome, { status: 'ok' }>> {
  const file = await beginMediaFile(ctx);
  let out: FetchOutcome;
  try {
    out = await dl.fetch(url, maxBytes, (chunk) => file.writer.write(chunk));
  } catch (e) {
    await file.writer.abort();
    throw e;
  }
  if (out.status !== 'ok' || out.size === 0) {
    await file.writer.abort();
    return out.status === 'ok' ? { status: 'error', reason: 'empty' } : out;
  }
  const { mediaId, size } = await finishMediaFile(ctx, file, kind, pickMime(out.mime, impliedMime), null);
  return { status: 'ok', mediaId, size };
}

/* ------------------------------------------------------------------ queue */

const MAX_ATTEMPTS = 4;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];

export interface MediaQueueDeps {
  downloader: () => Downloader | null;
  sources: MediaSources;
  /** Asks Instagram again for the message (fresh links land in [sources]). */
  refresh: (row: MessageRow) => Promise<void>;
  /** The file is being stored from the owner's own upload: don't download it. */
  ownUpload?: (messageId: string) => boolean;
}

export class MediaQueue {
  private readonly high: string[] = [];
  private readonly low: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private paused = true;
  private readonly timers = new Set<NodeJS.Timeout>();
  private lowDiskWarned = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: MediaQueueDeps,
    private readonly concurrency = 2,
  ) {}

  size(): number {
    return this.queued.size + this.running;
  }

  enqueue(messageId: string, priority: 'live' | 'history'): void {
    if (this.queued.has(messageId)) return;
    this.queued.add(messageId);
    (priority === 'live' ? this.high : this.low).push(messageId);
    this.pump();
  }

  /** Re-queues every message still marked pending in the DB (e.g. after a restart). */
  restorePending(): void {
    for (const r of this.ctx.repo.pendingMediaMessages(5000)) this.enqueue(r.id, 'history');
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  stop(): void {
    this.paused = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private next(): string | undefined {
    return this.high.shift() ?? this.low.shift();
  }

  private pump(): void {
    while (!this.paused && this.running < this.concurrency) {
      const id = this.next();
      if (!id) return;
      this.queued.delete(id);
      this.running++;
      void this.process(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private retryLater(id: string, attempts: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.enqueue(id, 'history');
    }, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    t.unref();
    this.timers.add(t);
  }

  private async diskFull(row: MessageRow): Promise<boolean> {
    // Keep headroom on the data filesystem (it may be a dedicated, size-capped volume): the database must always
    // be able to write. Checked again on every retry.
    try {
      const st = await fs.statfs(this.ctx.config.mediaDir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < MIN_FREE_BYTES + (row.media_size ?? 0)) {
        if (!this.lowDiskWarned) this.ctx.log.warn({ freeMb: Math.round(free / 1048576) }, 'low disk space: media downloads paused');
        this.lowDiskWarned = true;
        return true;
      }
      this.lowDiskWarned = false;
    } catch {
      /* statfs unsupported: carry on */
    }
    return false;
  }

  private async process(id: string): Promise<void> {
    const { repo, log, events } = this.ctx;
    const row = repo.getMessage(id);
    if (!row || row.media_status !== 'pending') return;
    if (this.deps.ownUpload?.(id)) return;
    const dl = this.deps.downloader();
    // Not connected: keep it pending; restorePending() picks it up when Instagram is ready again.
    if (!dl) return;
    if (await this.diskFull(row)) {
      this.retryLater(id, BACKOFF_MS.length);
      return;
    }
    const attempts = row.media_attempts + 1;
    const finish = (patch: Parameters<typeof repo.updateMessage>[1]) => {
      repo.updateMessage(id, { ...patch, media_attempts: attempts, updated_at: Date.now() });
      events.emit({ type: 'message_update', chatId: row.chat_id, messageId: id, reason: 'media' });
    };
    const again = (reason: string) => {
      if (attempts >= MAX_ATTEMPTS) {
        log.warn({ reason, msg: maskId(id) }, 'media download failed');
        return finish({ media_status: 'failed' });
      }
      repo.updateMessage(id, { media_attempts: attempts });
      this.retryLater(id, attempts);
    };
    try {
      let src = this.deps.sources.get(id);
      if (!src) {
        // Links live in memory only: after a restart (or for old rows) ask Instagram for the message again.
        await this.deps.refresh(row).catch(() => undefined);
        src = this.deps.sources.get(id);
        if (!src) return attempts >= 2 ? finish({ media_status: 'unavailable' }) : again('no_link');
      }
      const max = this.ctx.mediaMaxBytes();
      const urls = [src.url, ...(src.fallbackUrl ? [src.fallbackUrl] : [])];
      let last: Awaited<ReturnType<typeof downloadToMedia>> | null = null;
      for (const url of urls) {
        if (!isInstagramCdn(url, this.ctx.config.igWebOrigin)) continue;
        last = await downloadToMedia(this.ctx, dl, url, 'message', src.mime, max);
        if (last.status === 'ok' || last.status === 'too_large') break;
      }
      if (!last) return finish({ media_status: 'unavailable' });
      if (last.status === 'ok') {
        const now = repo.getMessage(id);
        // Wiped meanwhile, or own sent media that got its file from the upload.
        if (!now || now.media_id) {
          const m = repo.getMedia(last.mediaId);
          if (m) {
            repo.deleteMedia(m.id);
            await deleteMediaFile(this.ctx, m.path);
          }
          return;
        }
        this.deps.sources.delete(id);
        return finish({ media_id: last.mediaId, media_status: 'downloaded', media_size: last.size });
      }
      if (last.status === 'too_large') return finish({ media_status: 'too_large' });
      if (last.status === 'http' && [403, 404, 410].includes(last.code)) {
        // Expired or removed link: get a fresh one once, then give up (the UI offers "Retry").
        this.deps.sources.delete(id);
        if (attempts >= 2) return finish({ media_status: 'unavailable' });
        await this.deps.refresh(row).catch(() => undefined);
        repo.updateMessage(id, { media_attempts: attempts });
        this.retryLater(id, 1);
        return;
      }
      again(last.status === 'http' ? `http_${last.code}` : last.reason);
    } catch (err) {
      log.warn({ err: (err as Error).message, msg: maskId(id) }, 'media download error');
      again('exception');
    }
  }
}
