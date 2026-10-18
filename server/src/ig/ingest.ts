import type { AppContext } from '../context.js';
import { F, type MessageRow, type NewMessage } from '../db/repo.js';
import { maskId } from '../log.js';
import type { RawDelta } from './dgw.js';
import { fbid, mapMessage, mapUser, ms, str, type MappedContact, type MappedMessage, type MappedPart, type MediaSource } from './mapper.js';
import type { IgMessage, IgThread, IgUser } from './types.js';

/** What ingest needs from Instagram (abstracted for tests). */
export interface IgApi {
  /** Thread details with its newest messages; null when Instagram doesn't return it. */
  getThread(chatId: string): Promise<IgThread | null>;
}

export interface MediaSink {
  enqueue(messageId: string, priority: 'live' | 'history'): void;
}

export type Source = 'live' | 'history';

/** The logged-in account: messaging ids (sender_fbid) and the Instagram user id. */
export interface Me {
  fbids: Set<string>;
  igId: string | null;
}

const MAX_SOURCES = 20_000;
const CHAT_REFRESH_MS = 6 * 3600_000;
const CONTACT_REFRESH_MS = 6 * 3600_000;

/** Signed CDN URLs of files still to download, by row id. Memory only: they are bearer links to private media. */
export class MediaSources {
  private readonly map = new Map<string, MediaSource>();

  set(id: string, s: MediaSource): void {
    this.map.delete(id);
    this.map.set(id, s);
    if (this.map.size > MAX_SOURCES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(id: string): MediaSource | undefined {
    return this.map.get(id);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Folder names that mean "inbox" (null in the DB). */
const INBOX = new Set(['', 'INBOX', 'inbox', 'PRIMARY', 'primary', 'GENERAL', 'general']);
const folderOf = (t: IgThread): string | null | undefined => {
  const f = str(t.folder) ?? str(t.system_folder) ?? str(t.messaging_folder_tag);
  if (f === null) return undefined;
  return INBOX.has(f) ? null : f.slice(0, 40);
};

/**
 * Turns Instagram deltas and fetched threads into encrypted DB rows. Every handler is idempotent (keyed by
 * Instagram's message id), so live events, history import and reconcile can overlap safely.
 */
export class Ingest {
  private readonly chatSeen = new Map<string, number>();
  private readonly contactSeen = new Map<string, number>();
  /** Reaction "log message" id → target message, for reaction removals that only name the former. */
  private readonly reactionLog = new Map<string, { messageId: string; senderId: string }>();
  readonly sources = new MediaSources();
  /** Avatar URLs seen lately (chat id or contact id → URL), used by the avatar refresh. */
  readonly avatarUrls = new Map<string, string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly api: IgApi,
    private readonly media: MediaSink,
    private readonly me: () => Me,
  ) {}

  private get writer() {
    return this.ctx.writer();
  }

  resetCaches(): void {
    this.chatSeen.clear();
    this.contactSeen.clear();
    this.reactionLog.clear();
    this.sources.clear();
  }

  isMe(id: string | null | undefined, igId?: string | null): boolean {
    const me = this.me();
    return (!!id && me.fbids.has(id)) || (!!igId && !!me.igId && igId === me.igId);
  }

  /* ---------------------------------------------------------- contacts */

  upsertContact(c: MappedContact, force = false): void {
    const w = this.writer;
    if (!w) return;
    const now = Date.now();
    const seen = this.contactSeen.get(c.id);
    if (c.avatarUrl) this.avatarUrls.set(`c:${c.id}`, c.avatarUrl);
    if (!force && seen && now - seen < CONTACT_REFRESH_MS) return;
    this.contactSeen.set(c.id, now);
    this.ctx.repo.upsertContact({
      id: c.id,
      ig_id: c.igId,
      username_enc: c.username ? w.encrypt(...F.contactUsername(c.id), c.username) : null,
      name_enc: c.name ? w.encrypt(...F.contactName(c.id), c.name) : null,
      is_me: this.isMe(c.id, c.igId),
      is_verified: c.verified,
      now,
    });
  }

  /* ------------------------------------------------------------- chats */

  /** Stores a thread's details (name, kind, people, flags) — and its messages when [withMessages]. */
  async thread(t: IgThread, source: Source, opts: { withMessages?: boolean; quiet?: boolean } = {}): Promise<string | null> {
    const w = this.writer;
    if (!w) return null;
    const chatId = str(t.thread_fbid) ?? str(t.id);
    if (!chatId || !/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return null;
    const now = Date.now();
    this.chatSeen.set(chatId, now);
    const users = (t.users ?? []).map((u) => mapUser(u)).filter((u): u is MappedContact => !!u);
    const viewer = mapUser(t.viewer ?? null);
    if (viewer) this.upsertContact({ ...viewer }, true);
    for (const u of users) this.upsertContact(u);
    const others = users.filter((u) => !this.isMe(u.id, u.igId));
    const group = t.is_group === true || t.thread_subtype === 'IGD_GROUP' || others.length > 1;
    const peer = !group && others.length === 1 ? others[0]! : null;
    const title = str(t.thread_title) ?? (peer ? peer.name ?? peer.username : null);
    const img = str(t.thread_image_url);
    if (group && img && /^https:\/\//.test(img)) this.avatarUrls.set(chatId, img);
    else if (peer?.avatarUrl) this.avatarUrls.set(chatId, peer.avatarUrl);
    this.ctx.repo.upsertChat({
      id: chatId,
      kind: group ? 'group' : 'user',
      thread_id: str(t.thread_id),
      peer_id: peer?.id ?? null,
      name_enc: title ? w.encrypt(...F.chatName(chatId), title) : null,
      last_ts: ms(t.last_activity_timestamp_ms),
      folder: folderOf(t),
      pinned: typeof t.is_pin === 'boolean' ? t.is_pin : undefined,
      muted: typeof t.is_muted === 'boolean' ? t.is_muted : undefined,
      now,
    });
    if (!opts.quiet) this.ctx.events.emit({ type: 'chat_update', chatId });
    if (opts.withMessages) {
      for (const e of t.slide_messages?.edges ?? []) if (e?.node) await this.message(e.node, source, chatId);
      for (const rr of t.slide_read_receipts ?? []) this.readReceipt(chatId, rr.participant_fbid, rr.watermark_timestamp_ms);
    }
    return chatId;
  }

  /** Makes sure the chat row exists (fetching the thread from Instagram the first time it is seen). */
  async ensureChat(chatId: string, force = false): Promise<void> {
    if (!this.writer) return;
    const now = Date.now();
    const known = this.ctx.repo.getChat(chatId);
    const seen = this.chatSeen.get(chatId);
    if (!force && known && (seen === undefined || now - seen < CHAT_REFRESH_MS)) {
      if (seen === undefined) this.chatSeen.set(chatId, now);
      return;
    }
    this.chatSeen.set(chatId, now);
    let t: IgThread | null = null;
    try {
      t = await this.api.getThread(chatId);
    } catch (err) {
      this.ctx.log.debug({ err: (err as Error).message, chat: maskId(chatId) }, 'thread fetch failed');
    }
    // A chat seen for the first time: its newest messages come along as history.
    if (t && (await this.thread(t, 'history', { withMessages: !known }))) return;
    if (!known) {
      // Instagram didn't answer: keep a minimal row; the next reconcile fills in the details.
      this.ctx.repo.upsertChat({ id: chatId, kind: 'user', now });
      this.chatSeen.delete(chatId);
      this.ctx.events.emit({ type: 'chat_update', chatId });
    }
  }

  /* ---------------------------------------------------------- messages */

  private mediaStatusFor(p: MappedPart, source: Source): string {
    if (p.viewOnce) return 'view_once';
    if (!p.media) return 'none';
    if (!p.media.source) return 'unavailable';
    if (source === 'history' && !this.ctx.settings.get().downloadHistoryMedia) return 'skipped';
    return 'pending';
  }

  private rowFor(m: MappedMessage, p: MappedPart, chatId: string, source: Source, now: number): NewMessage {
    const w = this.writer!;
    const fromMe = this.isMe(m.senderId, m.sender?.igId);
    return {
      id: p.id,
      alt_id: p.id === m.id ? m.altId : null,
      chat_id: chatId,
      sender_id: m.senderId,
      from_me: fromMe ? 1 : 0,
      ts: m.ts,
      type: p.type,
      body_enc: w.encrypt(...F.body(p.id), p.body),
      meta_enc: w.encryptJson(...F.meta(p.id), p.meta),
      quoted_id: p.id === m.id ? m.quotedId : null,
      media_id: null,
      media_status: this.mediaStatusFor(p, source),
      media_attempts: 0,
      media_size: null,
      media_w: p.media?.width ?? null,
      media_h: p.media?.height ?? null,
      media_duration: p.media?.durationSec ?? null,
      album_index: p.albumIndex,
      album_count: p.albumCount,
      is_view_once: p.viewOnce ? 1 : 0,
      is_forwarded: m.forwarded ? 1 : 0,
      expires_at: m.expiresAt,
      ack: fromMe ? 1 : null,
      deleted_at: null,
      deleted_by: null,
      edited_at: p.id === m.id ? m.editTs : null,
      last_edit_key: p.id === m.id && m.editTs ? `e:${m.editTs}` : null,
      source,
      captured_at: now,
      updated_at: now,
    };
  }

  /** Logs one message (live delta, history or reconcile). Returns its id, or null when skipped. */
  async message(raw: IgMessage, source: Source, chatHint: string | null = null): Promise<string | null> {
    const w = this.writer;
    if (!w) return null;
    const m = mapMessage(raw, chatHint);
    if (m.skip || !m.chatId) return null;
    const chatId = m.chatId;
    await this.ensureChat(chatId);
    if (m.sender) this.upsertContact(m.sender);

    const { repo, events } = this.ctx;
    const now = Date.now();
    let newest = false;
    for (const p of m.parts) {
      if (p.media?.source) this.sources.set(p.id, p.media.source);
      const existing = repo.getMessage(p.id);
      if (!existing) {
        const row = this.rowFor(m, p, chatId, source, now);
        if (repo.insertMessage(row)) {
          newest = true;
          if (row.media_status === 'pending') this.media.enqueue(p.id, source);
          events.emit({ type: 'message', chatId, messageId: p.id });
        }
        if (p.id === m.id) {
          for (const prev of m.previousBodies) repo.insertEdit(p.id, w.encrypt(...F.body(p.id), prev.body), now);
        }
        continue;
      }
      this.updateExisting(existing, m, p, now);
    }
    if (newest) repo.bumpChatTs(chatId, m.ts, now);
    for (const r of m.reactions) this.reaction(m.id, r.senderId, r.emoji, r.ts, true);
    // The list is the current state: reactions we have that are no longer in it were taken back meanwhile.
    if (Array.isArray(raw.reactions)) {
      const current = new Set(m.reactions.map((r) => r.senderId));
      for (const r of repo.reactionsFor([m.id])) {
        if (!r.removed_at && !current.has(r.sender_id)) this.reaction(m.id, r.sender_id, '', Math.max(r.ts, now), true);
      }
    }
    return m.id;
  }

  private updateExisting(existing: MessageRow, m: MappedMessage, p: MappedPart, now: number): void {
    const { repo, events } = this.ctx;
    // An edit we have not recorded yet (missed live event, or history/reconcile).
    if (p.id === m.id && m.editTs && `e:${m.editTs}` !== existing.last_edit_key && !existing.deleted_at && existing.type === 'text') {
      this.applyEdit(existing, p.body, `e:${m.editTs}`, m.editTs, now);
    }
    const patch: Parameters<typeof repo.updateMessage>[1] = {};
    if (p.id === m.id && m.altId && !existing.alt_id) patch.alt_id = m.altId;
    // Media that failed or was unavailable can be retried when Instagram offers a fresh link.
    if (p.media?.source && (existing.media_status === 'failed' || existing.media_status === 'unavailable') && !existing.media_id && existing.media_attempts < 8) {
      patch.media_status = 'pending';
    }
    if (Object.keys(patch).length) {
      repo.updateMessage(existing.id, { ...patch, updated_at: now });
      if (patch.media_status === 'pending') {
        this.media.enqueue(existing.id, 'live');
        events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'media' });
      }
    }
  }

  /** Moves the current body ciphertext into the edit history (same AAD context) and stores the new body. */
  private applyEdit(existing: MessageRow, newBody: string | null, editKey: string, editTs: number, now: number): void {
    const { repo, events } = this.ctx;
    const w = this.writer!;
    repo.transaction(() => {
      repo.insertEdit(existing.id, existing.body_enc, now);
      repo.updateMessage(existing.id, {
        body_enc: w.encrypt(...F.body(existing.id), newBody),
        edited_at: editTs,
        last_edit_key: editKey,
        updated_at: now,
      });
    });
    events.emit({ type: 'message_update', chatId: existing.chat_id, messageId: existing.id, reason: 'edited' });
  }

  /** Unsent: keep the logged copy (and its album parts), flag it as deleted. */
  unsend(messageId: string, by: 'sender' | 'missing', at = Date.now()): boolean {
    const { repo, events } = this.ctx;
    const base = repo.findMessage(messageId);
    if (!base) return false;
    let changed = false;
    for (const row of repo.messageWithParts(base.id)) {
      if (row.deleted_at) continue;
      repo.updateMessage(row.id, { deleted_at: at, deleted_by: by, updated_at: Date.now() });
      this.sources.delete(row.id);
      events.emit({ type: 'message_update', chatId: row.chat_id, messageId: row.id, reason: 'deleted' });
      changed = true;
    }
    return changed;
  }

  reaction(messageId: string, senderId: string, emoji: string, ts: number, fromHistory = false, logId: string | null = null): void {
    const w = this.writer;
    if (!w) return;
    const row = this.ctx.repo.findMessage(messageId);
    if (!row) return;
    if (logId) this.reactionLog.set(logId, { messageId: row.id, senderId });
    this.ctx.repo.upsertReaction({
      message_id: row.id,
      sender_id: senderId,
      emoji_enc: emoji ? w.encrypt(...F.reaction(row.id, senderId), emoji) : null,
      ts,
      removed: emoji === '',
    });
    if (!fromHistory) this.ctx.events.emit({ type: 'message_update', chatId: row.chat_id, messageId: row.id, reason: 'reaction' });
  }

  readReceipt(chatId: string, participant: unknown, watermark: unknown): void {
    const who = fbid(participant);
    const ts = ms(watermark);
    if (!who || !ts || this.isMe(who)) return;
    const chat = this.ctx.repo.getChat(chatId);
    // In groups "seen" would need every member; only one-to-one chats get ticks.
    if (!chat || chat.kind !== 'user') return;
    for (const id of this.ctx.repo.markSeenUpTo(chatId, ts, Date.now())) {
      this.ctx.events.emit({ type: 'message_update', chatId, messageId: id, reason: 'ack' });
    }
  }

  /**
   * Messages logged in [fromTs, toTs] that a complete page fetched from Instagram no longer contains were removed
   * while insta_logger wasn't watching (unsent during downtime): flag them like live unsends.
   */
  markMissing(chatId: string, fetched: Set<string>, fromTs: number, toTs: number): number {
    let n = 0;
    const now = Date.now();
    for (const r of this.ctx.repo.messageIdsBetween(chatId, fromTs, toTs)) {
      if (fetched.has(r.id)) continue;
      const row = this.ctx.repo.getMessage(r.id);
      if (!row || row.alt_id && fetched.has(row.alt_id)) continue;
      // Disappearing / view-once messages vanish by design; pending sends may not be on the server yet.
      if (row.expires_at || row.is_view_once || row.type === 'system' || now - row.captured_at < 60_000) continue;
      if (this.unsend(r.id, 'missing', now)) n++;
    }
    return n;
  }

  /* ------------------------------------------------------------- deltas */

  /** Applies one live delta from Instagram's message stream. */
  async delta(d: RawDelta): Promise<void> {
    if (!this.writer) return;
    const type = typeof d.__typename === 'string' ? d.__typename : '';
    const chatId = str(d.thread_fbid);
    const msg = (d.message ?? null) as IgMessage | null;
    switch (type) {
      case 'SlideUQPPNewMessage':
      case 'SlideUQPPNewRavenMessage':
      case 'SlideUQPPNewGenieMessage':
      case 'SlideUQPPAdminTextMessage':
        if (msg) await this.message(msg, 'live', chatId ?? str(msg.thread_fbid));
        return;
      case 'SlideUQPPThreadName':
      case 'SlideUQPPThreadImage':
      case 'SlideUQPPParticipantLeftGroupThread':
      case 'SlideUQPPParticipantsAddedToGroupThread': {
        if (msg) await this.message(msg, 'live', chatId);
        if (chatId) {
          if (type === 'SlideUQPPThreadName' && typeof d.thread_name === 'string') this.renameChat(chatId, d.thread_name);
          else if (type === 'SlideUQPPThreadImage') this.ctx.repo.resetChatAvatarCheck(chatId);
          else {
            const t = (d.thread as { as_ig_direct_thread?: { users?: IgUser[] } } | undefined)?.as_ig_direct_thread;
            for (const u of t?.users ?? []) {
              const c = mapUser(u);
              if (c) this.upsertContact(c, true);
            }
          }
        }
        return;
      }
      case 'SlideUQPPEditMessage': {
        const id = str(d.message_id);
        if (!id) return;
        const row = this.ctx.repo.findMessage(id);
        const body = typeof d.text_body === 'string' ? d.text_body : null;
        const ts = ms((d.slide_edit_history_entry as { timestamp_ms?: unknown } | undefined)?.timestamp_ms) ?? Date.now();
        if (!row) {
          // Never logged: fetch the thread so the message (with its edit history) is stored.
          if (chatId) await this.ensureChat(chatId, true);
          return;
        }
        if (row.deleted_at || `e:${ts}` === row.last_edit_key) return;
        this.applyEdit(row, body, `e:${ts}`, ts, Date.now());
        return;
      }
      case 'SlideUQPPDeleteMessage': {
        const id = str(d.message_id);
        if (id && !this.unsend(id, 'sender')) this.ctx.log.debug({ msg: maskId(id) }, 'unsend of a message that was never logged');
        return;
      }
      case 'SlideUQPPCreateReaction':
      case 'SlideUQPPDeleteReaction': {
        const r = (d.reaction ?? {}) as { reaction?: unknown; sender_fbid?: unknown; reaction_timestamp_ms?: unknown; log_message_id?: unknown };
        let target = str(d.message_id);
        let sender = fbid(r.sender_fbid);
        const logId = str(r.log_message_id);
        if (type === 'SlideUQPPDeleteReaction' && target && !this.ctx.repo.findMessage(target) && this.reactionLog.has(target)) {
          const t = this.reactionLog.get(target)!;
          target = t.messageId;
          sender ??= t.senderId;
        }
        if (!target || !sender) return;
        const emoji = type === 'SlideUQPPCreateReaction' ? str(r.reaction) ?? '' : '';
        if (type === 'SlideUQPPCreateReaction' && !emoji) return;
        this.reaction(target, sender, emoji, ms(r.reaction_timestamp_ms) ?? Date.now(), false, logId);
        return;
      }
      case 'SlideUQPPReadReceipt': {
        const rr = (d.read_receipt ?? {}) as { participant_fbid?: unknown; watermark_timestamp_ms?: unknown };
        if (chatId) this.readReceipt(chatId, rr.participant_fbid, rr.watermark_timestamp_ms);
        return;
      }
      case 'SlideUQPPDeleteThread':
        if (chatId && this.ctx.repo.getChat(chatId)) {
          this.ctx.repo.markChatRemoved(chatId, Date.now());
          this.ctx.events.emit({ type: 'chat_update', chatId });
        }
        return;
      case 'SlideUQPPPinnedThread':
        if (chatId) this.setFlags(chatId, { pinned: d.is_pinned === true });
        return;
      case 'SlideUQPPChangeMuteSettings':
        if (chatId) this.setFlags(chatId, { muted: d.is_muted_now === true });
        return;
      case 'SlideUQPPUpdateThreadFolder': {
        const f = str(d.folder) ?? str(d.ig_inbox_folder);
        if (chatId && f !== null) this.setFlags(chatId, { folder: INBOX.has(f) ? null : f.slice(0, 40) });
        return;
      }
      default:
        // Read markers, typing, admin lists, pins and new delta kinds: nothing to log.
        return;
    }
  }

  private renameChat(chatId: string, name: string): void {
    const w = this.writer;
    if (!w || !this.ctx.repo.getChat(chatId)) return;
    this.ctx.repo.setChatName(chatId, name ? w.encrypt(...F.chatName(chatId), name) : null, Date.now());
    this.ctx.events.emit({ type: 'chat_update', chatId });
  }

  private setFlags(chatId: string, patch: { folder?: string | null; pinned?: boolean; muted?: boolean }): void {
    if (!this.ctx.repo.getChat(chatId)) return;
    this.ctx.repo.setChatFlags(chatId, patch, Date.now());
    this.ctx.events.emit({ type: 'chat_update', chatId });
  }
}
