import type { ChatKind, ChatSummary, MediaInfo, MediaStatus, Message, MessagePreview, MessageType, QuotedSnapshot, Reaction } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import type { DataReader } from '../crypto/keyring.js';
import { F, type ChatListRow, type ChatRow, type ContactRow, type MessageRow } from '../db/repo.js';
import { TYPE_LABEL, type MessageMeta } from '../ig/mapper.js';

const PREVIEW_LEN = 120;
const MEDIA_TYPES = new Set<MessageType>(['image', 'video', 'gif', 'voice', 'sticker', 'view_once']);

/**
 * Turns encrypted rows into API DTOs for one request. Holds a request-scoped DataReader and small
 * caches of decrypted names; discarded with the request.
 */
export class Presenter {
  private readonly contactCache = new Map<string, ContactRow | null>();
  private readonly nameCache = new Map<string, string>();
  private readonly meIds: Set<string>;

  constructor(
    private readonly ctx: AppContext,
    private readonly reader: DataReader,
  ) {
    this.meIds = new Set(ctx.repo.meContactIds());
  }

  /* ---------------------------------------------------------- names */

  preloadContacts(ids: Iterable<string>): void {
    const missing = [...new Set(ids)].filter((id) => !this.contactCache.has(id));
    for (const row of this.ctx.repo.getContactsByIds(missing)) this.contactCache.set(row.id, row);
    for (const id of missing) if (!this.contactCache.has(id)) this.contactCache.set(id, null);
  }

  private contact(id: string): ContactRow | null {
    if (!this.contactCache.has(id)) this.preloadContacts([id]);
    return this.contactCache.get(id) ?? null;
  }

  isMe(id: string | null | undefined): boolean {
    return !!id && (this.meIds.has(id) || this.contact(id)?.is_me === 1);
  }

  username(id: string | null | undefined): string | null {
    if (!id) return null;
    const row = this.contact(id);
    return row ? this.reader.tryText(...F.contactUsername(id), row.username_enc) : null;
  }

  /** Full name, else @username, else the id. */
  contactName(id: string | null | undefined): string {
    if (!id) return 'Unknown';
    if (this.isMe(id)) return 'You';
    const cached = this.nameCache.get(id);
    if (cached) return cached;
    const row = this.contact(id);
    let name: string | null = null;
    if (row) {
      name = this.reader.tryText(...F.contactName(id), row.name_enc);
      if (!name) {
        const u = this.reader.tryText(...F.contactUsername(id), row.username_enc);
        if (u) name = `@${u}`;
      }
    }
    if (!name) name = 'Instagram user';
    this.nameCache.set(id, name);
    return name;
  }

  chatName(chat: ChatRow): string {
    const n = this.reader.tryText(...F.chatName(chat.id), chat.name_enc);
    if (n) return n;
    if (chat.kind === 'user' && chat.peer_id) return this.contactName(chat.peer_id);
    return chat.kind === 'group' ? 'Group chat' : 'Instagram chat';
  }

  chatRef(chat: ChatRow | undefined, chatId: string): { id: string; name: string; kind: ChatKind } {
    return chat ? { id: chat.id, name: this.chatName(chat), kind: chat.kind as ChatKind } : { id: chatId, name: 'Instagram chat', kind: 'user' };
  }

  /* -------------------------------------------------------- messages */

  private meta(row: MessageRow): MessageMeta | null {
    return this.reader.tryJson<MessageMeta>(...F.meta(row.id), row.meta_enc);
  }

  private text(row: MessageRow, meta: MessageMeta | null): string | null {
    const body = this.reader.tryText(...F.body(row.id), row.body_enc);
    if (body) return body;
    if (row.type === 'unknown') return `Unsupported message${meta?.rawType ? ` (${meta.rawType.replace(/^SlideMessage/, '')})` : ''}`;
    return null;
  }

  private media(row: MessageRow): MediaInfo | null {
    const status = row.media_status as MediaStatus;
    const hasMedia = status !== 'none' || row.media_id !== null || MEDIA_TYPES.has(row.type as MessageType);
    if (!hasMedia) return null;
    let mime: string | null = null;
    let filename: string | null = null;
    if (row.media_id !== null) {
      const m = this.ctx.repo.getMedia(row.media_id);
      if (m) {
        mime = this.reader.tryText(...F.mediaMime(m.path), m.mime_enc);
        filename = this.reader.tryText(...F.mediaFilename(m.path), m.filename_enc);
      }
    }
    return {
      status,
      url: row.media_id !== null && status === 'downloaded' ? `/api/media/${row.media_id}` : null,
      mime,
      filename,
      size: row.media_size,
      width: row.media_w,
      height: row.media_h,
      durationSec: row.media_duration,
    };
  }

  /** Builds full DTOs for a batch of rows (one DB round trip each for reactions, edits, contacts). */
  messages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const metas = new Map(rows.map((r) => [r.id, this.meta(r)] as const));
    const people = new Set<string>();
    for (const r of rows) {
      if (r.sender_id) people.add(r.sender_id);
      const m = metas.get(r.id);
      if (m?.quoted?.senderId) people.add(m.quoted.senderId);
      for (const x of m?.mentions ?? []) people.add(x);
    }
    const reactions = this.ctx.repo.reactionsFor(ids);
    for (const r of reactions) people.add(r.sender_id);
    this.preloadContacts(people);
    const editCounts = this.ctx.repo.editCounts(ids);
    const byMsg = new Map<string, Reaction[]>();
    for (const r of reactions) {
      if (r.removed_at) continue;
      const emoji = this.reader.tryText(...F.reaction(r.message_id, r.sender_id), r.emoji_enc);
      if (!emoji) continue;
      const list = byMsg.get(r.message_id) ?? [];
      const fromMe = this.isMe(r.sender_id);
      list.push({ senderId: r.sender_id, senderName: fromMe ? 'You' : this.contactName(r.sender_id), emoji, ts: r.ts, fromMe });
      byMsg.set(r.message_id, list);
    }
    const quotedRows = new Map(
      this.ctx.repo
        .getMessagesByIds([...new Set(rows.map((r) => r.quoted_id).filter((x): x is string => !!x))])
        .map((q) => [q.id, q] as const),
    );

    return rows.map((row) => {
      const meta = metas.get(row.id) ?? null;
      let quoted: QuotedSnapshot | null = null;
      if (meta?.quoted || row.quoted_id) {
        const q = meta?.quoted ?? null;
        const qrow = row.quoted_id ? quotedRows.get(row.quoted_id) : undefined;
        const senderId = qrow?.sender_id ?? q?.senderId ?? null;
        const fromMe = qrow ? !!qrow.from_me : this.isMe(senderId);
        quoted = {
          id: qrow?.id ?? null,
          senderName: fromMe ? 'You' : senderId ? this.contactName(senderId) : null,
          fromMe,
          type: (qrow?.type as MessageType | undefined) ?? q?.type ?? 'text',
          // The logged copy when we have it (it may have been unsent since), else Instagram's snapshot.
          text: qrow ? this.text(qrow, null) : q?.text ?? null,
        };
      }
      const msg: Message = {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        senderName: row.from_me ? 'You' : row.sender_id ? this.contactName(row.sender_id) : null,
        senderUsername: row.sender_id ? this.username(row.sender_id) : null,
        fromMe: !!row.from_me,
        ts: row.ts,
        type: row.type as MessageType,
        text: this.text(row, meta),
        media: this.media(row),
        quoted,
        share: meta?.share ?? null,
        music: meta?.music ?? null,
        mentions: (meta?.mentions ?? []).map((id) => ({ id, name: this.contactName(id) })),
        forwarded: !!row.is_forwarded,
        album: row.album_index !== null && row.album_count ? { index: row.album_index, count: row.album_count } : null,
        expiresAt: row.expires_at,
        ack: row.ack,
        reactions: byMsg.get(row.id) ?? [],
        edited: row.edited_at !== null || (editCounts.get(row.id) ?? 0) > 0,
        editedAt: row.edited_at,
        editCount: editCounts.get(row.id) ?? 0,
        deletedAt: row.deleted_at,
        deletedBy: row.deleted_by,
        source: row.source === 'history' ? 'history' : 'live',
        capturedAt: row.captured_at,
      };
      return msg;
    });
  }

  preview(row: MessageRow): MessagePreview {
    const meta = this.meta(row);
    let text = this.text(row, meta);
    const label = TYPE_LABEL[row.type as MessageType];
    if (!text) text = row.type === 'share' && meta?.share?.kind ? `↗ ${meta.share.kind}` : label ?? null;
    else if (label && row.type !== 'system') text = `${label} · ${text}`;
    if (text && text.length > PREVIEW_LEN) text = `${text.slice(0, PREVIEW_LEN - 1)}…`;
    return {
      id: row.id,
      type: row.type as MessageType,
      fromMe: !!row.from_me,
      senderName: row.from_me ? 'You' : row.sender_id ? this.contactName(row.sender_id) : null,
      text,
      deleted: row.deleted_at !== null,
      ts: row.ts,
    };
  }

  chats(rows: ChatListRow[]): ChatSummary[] {
    const lastIds = rows.map((r) => r.lm_id).filter((x): x is string => !!x);
    const lastRows = new Map(this.ctx.repo.getMessagesByIds(lastIds).map((r) => [r.id, r] as const));
    this.preloadContacts([
      ...rows.map((r) => r.peer_id).filter((x): x is string => !!x),
      ...[...lastRows.values()].map((r) => r.sender_id).filter((x): x is string => !!x),
    ]);
    return rows.map((c) => {
      const last = c.lm_id ? lastRows.get(c.lm_id) : undefined;
      return {
        id: c.id,
        kind: c.kind as ChatKind,
        name: this.chatName(c),
        username: c.kind === 'user' && c.peer_id ? this.username(c.peer_id) : null,
        avatarUrl: c.avatar_media_id ? `/api/media/${c.avatar_media_id}` : null,
        lastTs: last?.ts ?? c.last_ts,
        lastMessage: last ? this.preview(last) : null,
        folder: c.folder,
        pinned: !!c.pinned,
        muted: !!c.muted,
        removed: c.removed_at !== null,
        messageCount: c.message_count,
        deletedCount: c.deleted_count,
      };
    });
  }

  /** Plain text used for search matching (body, shared post titles/captions, music). */
  searchableText(row: MessageRow): string {
    const parts: string[] = [];
    const body = this.reader.tryText(...F.body(row.id), row.body_enc);
    if (body) parts.push(body);
    const meta = row.meta_enc ? this.meta(row) : null;
    if (meta?.share) parts.push(meta.share.title ?? '', meta.share.subtitle ?? '', meta.share.caption ?? '');
    if (meta?.music) parts.push(meta.music.title ?? '', meta.music.artist ?? '');
    return parts.join('\n');
  }
}
