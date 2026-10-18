import { randomBytes } from 'node:crypto';
import { isInstagramCdn, pickMime, type Downloader } from '../ig/media.js';

/*
 * Videos and pictures of the Reels section. Instagram's signed CDN links never reach the client (or any log):
 * the server hands out opaque refs and keeps ref → link in memory only. A ref is fetched through the server's browser
 * (the app container has no internet), kept in a small in-memory cache, and served to the owner.
 */

const REF_TTL_MS = 6 * 3600_000;
const MAX_REFS = 50_000;
const CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const SERVE_MIME = /^(image\/(jpeg|png|gif|webp|avif|heic)|video\/(mp4|webm|quicktime))$/;

interface Entry {
  url: string;
  until: number;
}

export interface Fetched {
  mime: string;
  data: Buffer;
}

export class MediaRefs {
  private readonly refs = new Map<string, Entry>();
  private readonly byUrl = new Map<string, string>();
  private readonly cache = new Map<string, Fetched>();
  private cached = 0;
  private readonly inflight = new Map<string, Promise<Fetched | null>>();

  constructor(private readonly testOrigin?: string) {}

  /** An app URL for a CDN link (the same link gets the same ref while it lives). Null for anything else. */
  ref(url: string): string | null {
    if (!isInstagramCdn(url, this.testOrigin)) return null;
    const now = Date.now();
    const known = this.byUrl.get(url);
    if (known) {
      const e = this.refs.get(known);
      if (e && e.until > now) return `/api/reels/media/${known}`;
    }
    if (this.refs.size >= MAX_REFS) this.prune(now);
    const id = randomBytes(16).toString('base64url');
    this.refs.set(id, { url, until: now + REF_TTL_MS });
    this.byUrl.set(url, id);
    return `/api/reels/media/${id}`;
  }

  private prune(now: number): void {
    for (const [id, e] of this.refs) {
      if (e.until <= now || this.refs.size > MAX_REFS * 0.8) {
        this.refs.delete(id);
        this.byUrl.delete(e.url);
      }
    }
  }

  /** The file behind a ref: from the cache, or fetched through the browser once (concurrent requests share it). */
  async get(id: string, dl: Downloader): Promise<Fetched | null> {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit); // most recently used last
      return hit;
    }
    const e = this.refs.get(id);
    if (!e || e.until <= Date.now()) return null;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetch(e.url, dl).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    const f = await p;
    if (f && !this.cache.has(id)) this.put(id, f);
    return f;
  }

  private async fetch(url: string, dl: Downloader): Promise<Fetched | null> {
    const parts: Buffer[] = [];
    const out = await dl.fetch(url, MAX_MEDIA_BYTES, async (c) => void parts.push(c));
    if (out.status !== 'ok' || !out.size) return null;
    const mime = pickMime(out.mime, null);
    if (!mime || !SERVE_MIME.test(mime)) return null;
    return { mime, data: Buffer.concat(parts) };
  }

  private put(id: string, f: Fetched): void {
    if (f.data.length > CACHE_BYTES / 4) return;
    this.cache.set(id, f);
    this.cached += f.data.length;
    for (const [k, v] of this.cache) {
      if (this.cached <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cached -= v.data.length;
    }
  }

  clear(): void {
    this.refs.clear();
    this.byUrl.clear();
    this.cache.clear();
    this.cached = 0;
  }
}
