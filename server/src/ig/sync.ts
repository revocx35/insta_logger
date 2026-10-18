import type { IgStatus } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import type { MessageRow } from '../db/repo.js';
import { maskId } from '../log.js';
import type { MessagesPage, ThreadPage } from './api.js';
import type { Ingest } from './ingest.js';
import { mapMessage, ms, str } from './mapper.js';
import type { IgMessage, IgThread } from './types.js';

export interface SyncApi {
  inbox(): Promise<ThreadPage>;
  inboxPage(cursor: string, viewerFbid: string | null): Promise<ThreadPage>;
  thread(chatId: string): Promise<IgThread | null>;
  messages(chatId: string, opts: { after?: string | null; olderThan?: string | null }): Promise<MessagesPage>;
}

export const INITIAL_SYNC_KEY = 'initial_sync_done';

const MAX_THREADS = 400;
const RECONCILE_PAGES = 2;
const RECONCILE_TOP = 10;
const CATCHUP_PAGES = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * History import (once, after the first login) and periodic reconcile. Reconcile re-reads the newest messages of
 * chats that moved, which logs what arrived while insta_logger wasn't watching, and flags logged messages that
 * vanished from Instagram meanwhile (unsent while away).
 */
export class Sync {
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly ingest: Ingest,
    private readonly api: SyncApi,
    private readonly onProgress: (p: IgStatus['sync']) => void,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  private gap(): Promise<void> {
    return sleep(this.ctx.config.igRequestGapMs);
  }

  /** All inbox threads, newest first (capped). */
  private async allThreads(maxPages = Infinity): Promise<IgThread[]> {
    const first = await this.api.inbox();
    const threads = [...first.threads];
    let { cursor, hasMore, viewerFbid } = first;
    let pages = 1;
    while (hasMore && cursor && pages < maxPages && threads.length < MAX_THREADS) {
      await this.gap();
      const next = await this.api.inboxPage(cursor, viewerFbid);
      threads.push(...next.threads);
      ({ cursor, hasMore } = next);
      pages++;
    }
    const seen = new Set<string>();
    return threads
      .filter((t) => {
        const id = str(t.thread_fbid) ?? str(t.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => (ms(b.last_activity_timestamp_ms) ?? 0) - (ms(a.last_activity_timestamp_ms) ?? 0));
  }

  async initial(): Promise<void> {
    await this.historyPass();
    if (!this.ctx.repo.getState(INITIAL_SYNC_KEY)) this.ctx.repo.setState(INITIAL_SYNC_KEY, String(Date.now()));
  }

  async historyPass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const threads = await this.allThreads();
      const limit = this.ctx.settings.get().historyPerChat;
      let done = 0;
      this.onProgress({ phase: 'history', chatsDone: 0, chatsTotal: threads.length });
      for (const t of threads) {
        const chatId = await this.ingest.thread(t, 'history');
        if (chatId && limit > 0) {
          try {
            await this.importChat(chatId, limit);
          } catch (err) {
            this.ctx.log.warn({ err: (err as Error).message, chat: maskId(chatId) }, 'history fetch failed for a chat');
          }
        }
        done++;
        this.onProgress({ phase: 'history', chatsDone: done, chatsTotal: threads.length });
      }
    } finally {
      this.running = false;
      this.onProgress(null);
    }
  }

  /** The newest [limit] messages of a chat. */
  private async importChat(chatId: string, limit: number): Promise<void> {
    await this.gap();
    const t = await this.api.thread(chatId);
    if (!t) return;
    await this.ingest.thread(t, 'history', { withMessages: true, quiet: true });
    let count = t.slide_messages?.edges?.length ?? 0;
    let cursor = t.slide_messages?.page_info?.end_cursor ?? null;
    let hasMore = t.slide_messages?.page_info?.has_next_page === true;
    while (hasMore && cursor && count < limit) {
      await this.gap();
      const page = await this.api.messages(chatId, { after: cursor });
      for (const m of page.messages) await this.ingest.message(m, 'history', chatId);
      count += page.messages.length;
      if (page.messages.length === 0) break;
      ({ cursor, hasMore } = page);
    }
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const threads = await this.allThreads(RECONCILE_PAGES);
      const targets: IgThread[] = [];
      threads.forEach((t, i) => {
        const id = str(t.thread_fbid) ?? str(t.id);
        if (!id) return;
        const stored = this.ctx.repo.getChat(id);
        const moved = !stored || (ms(t.last_activity_timestamp_ms) ?? 0) > (stored.last_ts ?? 0);
        if (moved || i < RECONCILE_TOP) targets.push(t);
      });
      let done = 0;
      this.onProgress({ phase: 'reconcile', chatsDone: 0, chatsTotal: targets.length });
      for (const t of targets) {
        const id = await this.ingest.thread(t, 'live', { quiet: true });
        if (id) {
          try {
            await this.recheckChat(id);
          } catch (err) {
            this.ctx.log.warn({ err: (err as Error).message, chat: maskId(id) }, 'reconcile failed for a chat');
          }
        }
        done++;
        this.onProgress({ phase: 'reconcile', chatsDone: done, chatsTotal: targets.length });
      }
    } finally {
      this.running = false;
      this.onProgress(null);
    }
  }

  /**
   * Re-reads a chat's newest messages: logs what's new (paging back until a known message, at most a few pages) and
   * flags logged messages that are gone from that window.
   */
  async recheckChat(chatId: string): Promise<void> {
    await this.gap();
    const t = await this.api.thread(chatId);
    if (!t) return;
    const msgs: IgMessage[] = [];
    for (const e of t.slide_messages?.edges ?? []) if (e?.node) msgs.push(e.node);
    let cursor = t.slide_messages?.page_info?.end_cursor ?? null;
    let hasMore = t.slide_messages?.page_info?.has_next_page === true;
    // Only an explicit "no older messages" on a short page proves the page holds the whole chat.
    let reachedStart = t.slide_messages?.page_info?.has_next_page === false && msgs.length < 20;
    const known = () => msgs.some((m) => {
      const id = str(m.message_id) ?? str(m.id);
      return !!id && !!this.ctx.repo.getMessage(id);
    });
    let pages = 1;
    while (!known() && hasMore && cursor && pages < CATCHUP_PAGES) {
      await this.gap();
      const page = await this.api.messages(chatId, { after: cursor });
      if (page.messages.length === 0) break;
      msgs.push(...page.messages);
      ({ cursor, hasMore } = page);
      reachedStart = page.atStart && page.messages.length < 20;
      pages++;
    }
    await this.ingest.thread(t, 'live', { quiet: true });
    // Oldest first, so replies find what they quote.
    for (const m of [...msgs].reverse()) await this.ingest.message(m, 'live', chatId);
    for (const rr of t.slide_read_receipts ?? []) this.ingest.readReceipt(chatId, rr.participant_fbid, rr.watermark_timestamp_ms);
    this.flagMissing(chatId, msgs, reachedStart);
  }

  private flagMissing(chatId: string, msgs: IgMessage[], reachedStart: boolean): void {
    const ids = new Set<string>();
    let min = Infinity;
    let max = 0;
    for (const raw of msgs) {
      const m = mapMessage(raw, chatId);
      if (m.skip) continue;
      ids.add(m.id);
      if (m.altId) ids.add(m.altId);
      min = Math.min(min, m.ts);
      max = Math.max(max, m.ts);
    }
    if (ids.size === 0) return;
    // When the page reached the start of the chat, everything older than it is gone too.
    const from = reachedStart ? 0 : min;
    const n = this.ingest.markMissing(chatId, ids, from, max);
    if (n) this.ctx.log.info({ chat: maskId(chatId), count: n }, 'messages gone from Instagram flagged as deleted');
  }

  /** Fetches the page of a chat that contains [row] again (fresh media links). */
  async refetchAround(row: MessageRow): Promise<void> {
    const base = row.id.replace(/~\d+$/, '');
    const anchor = this.ctx.repo.getMessage(base) ?? row;
    const next = this.ctx.repo.nextMessageAfter(row.chat_id, anchor.ts);
    if (next) {
      const page = await this.api.messages(row.chat_id, { olderThan: next.alt_id ?? next.id });
      for (const m of page.messages) await this.ingest.message(m, 'live', row.chat_id);
      return;
    }
    const t = await this.api.thread(row.chat_id);
    for (const e of t?.slide_messages?.edges ?? []) if (e?.node) await this.ingest.message(e.node, 'live', row.chat_id);
  }
}
