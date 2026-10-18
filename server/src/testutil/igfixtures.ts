/**
 * Instagram "Slide" JSON fixtures shaped like Instagram Web's real payloads (field names from mautrix-meta's
 * slidetypes), plus a fake Instagram (threads + message pages) for ingest/sync/API tests and the dev seed.
 */
import type { MessagesPage, ThreadPage } from '../ig/api.js';
import type { RawDelta } from '../ig/dgw.js';
import type { IgApi } from '../ig/ingest.js';
import type { SyncApi } from '../ig/sync.js';
import type { IgAttachment, IgMessage, IgThread, IgUser } from '../ig/types.js';

export const ME = '17841400000000001';
export const ME_IG = '5550001';
export const ALI = '17841400000000002';
export const AYSE = '17841400000000003';
export const CAN = '17841400000000004';
export const CHAT = '340282366841710300001';
export const GROUP = '340282366841710300002';
export const OTHER = '340282366841710300003';

export const CDN = 'https://scontent-ist1-1.cdninstagram.com/v/t1.15752-9';

export function user(fbid: string, username: string, name: string, extra: Partial<IgUser> = {}): IgUser {
  return {
    id: `ig${fbid.slice(-6)}`,
    pk: `ig${fbid.slice(-6)}`,
    interop_messaging_user_fbid: fbid,
    username,
    full_name: name,
    profile_pic_url: `${CDN}/pp_${username}.jpg?oe=AAAA`,
    is_verified: false,
    ...extra,
  };
}

export const USERS: Record<string, IgUser> = {
  [ME]: { ...user(ME, 'owner.account', 'Owner Person'), id: ME_IG, pk: ME_IG },
  [ALI]: user(ALI, 'ali.veli', 'Ali Veli'),
  [AYSE]: user(AYSE, 'ayse_k', 'Ayşe Kaya'),
  [CAN]: user(CAN, 'can.d', 'Can Demir'),
};

export const mid = (n: number | string) => `mid.$cAAB${String(n).padStart(6, '0')}`;
const T0 = 1_760_000_000_000;
export const at = (n: number) => T0 + n * 60_000;

interface MsgOpts {
  chat?: string;
  sender?: string;
  reply?: { id: string; message?: IgMessage | null };
  reactions?: { sender: string; emoji: string; ts?: number }[];
  edits?: { body: string; ts: number }[];
  forwarded?: boolean;
  expiresAt?: number;
  altId?: string;
}

function base(id: string, ts: number, o: MsgOpts): IgMessage {
  const sender = o.sender ?? ALI;
  return {
    __typename: 'SlideMessage',
    message_id: id,
    id: o.altId ?? id,
    sender_fbid: sender,
    thread_fbid: o.chat ?? CHAT,
    timestamp_ms: String(ts),
    offline_threading_id: String(ts * 4),
    reactions: (o.reactions ?? []).map((r) => ({ reaction: r.emoji, sender_fbid: r.sender, reaction_timestamp_ms: String(r.ts ?? ts + 1000) })),
    igd_is_forwarded: o.forwarded ?? false,
    replied_to_message_id: o.reply?.id,
    replied_to_message: o.reply?.message ?? null,
    sender: { name: USERS[sender]?.full_name, id: USERS[sender]?.id, igid: USERS[sender]?.id, user_dict: USERS[sender] ?? null },
    slide_edit_history: o.edits?.map((e) => ({ __typename: 'SlideEditHistoryEntry', body: e.body, timestamp_ms: String(e.ts) })) ?? null,
    expiration_timestamp_ms: o.expiresAt ? String(o.expiresAt) : null,
  };
}

export function textMsg(id: string, body: string, ts: number, o: MsgOpts = {}): IgMessage {
  return { ...base(id, ts, o), content_type: 'TEXT', text_body: body, igd_snippet: body, content: { __typename: 'SlideMessageText', text_body: body } };
}

export function attachment(name: string, w = 1080, h = 1350, video = false): IgAttachment {
  return {
    __typename: video ? 'SlideMessageVideoAttachment' : 'SlideMessageImageAttachment',
    attachment_fbid: `att_${name}`,
    attachment_cdn_url: `${CDN}/${name}?stp=dst-jpg&oe=AAAA`,
    preview_cdn_url: `${CDN}/${name}_preview?oe=AAAA`,
    preview_width: w,
    preview_height: h,
    ...(video ? { dash_manifest: '<MPD/>', playable_duration_ms: 12_400 } : {}),
  };
}

export function imageMsg(id: string, ts: number, o: MsgOpts = {}, names = ['photo1.jpg']): IgMessage {
  return { ...base(id, ts, o), content_type: 'IMAGE', igd_snippet: 'sent a photo', content: { __typename: 'SlideMessageImageContent', attachments: names.map((n) => attachment(n)) } };
}

export function videoMsg(id: string, ts: number, o: MsgOpts = {}): IgMessage {
  return { ...base(id, ts, o), content_type: 'VIDEO', igd_snippet: 'sent a video', content: { __typename: 'SlideMessageVideosContent', videos: [attachment('clip.mp4', 720, 1280, true)] } };
}

export function albumMsg(id: string, ts: number, o: MsgOpts = {}): IgMessage {
  return {
    ...base(id, ts, o),
    content_type: 'MULTI',
    igd_snippet: 'sent 3 attachments',
    content: { __typename: 'SlideMessageMultiMediaContent', ordered_photo_video_attachments: [attachment('a1.jpg'), attachment('a2.mp4', 720, 1280, true), attachment('a3.jpg')] },
  };
}

export function voiceMsg(id: string, ts: number, o: MsgOpts = {}): IgMessage {
  return {
    ...base(id, ts, o),
    content_type: 'AUDIO',
    igd_snippet: 'sent a voice message',
    content: { __typename: 'SlideMessageAudiosContent', audio_attachments: [{ attachment_fbid: 'aud1', attachment_cdn_url: `${CDN}/voice.mp4?oe=AAAA`, playable_duration_ms: 7300 }] },
  };
}

export function ravenMsg(id: string, ts: number, viewMode: number, o: MsgOpts = {}): IgMessage {
  return {
    ...base(id, ts, o),
    __typename: 'SlideMessage',
    content_type: 'RAVEN',
    igd_snippet: 'sent a photo',
    content: { __typename: 'SlideMessageRavenImageContent', view_mode: viewMode, attachment: attachment('raven.jpg') },
  };
}

export function shareMsg(id: string, ts: number, o: MsgOpts = {}, text?: string): IgMessage {
  return {
    ...base(id, ts, o),
    content_type: 'XMA',
    igd_snippet: 'shared a reel',
    content: {
      __typename: 'SlideMessageXMAContent',
      xma_text_body: text,
      xma: {
        __typename: 'SlideXMA',
        header_title_text: 'natgeo',
        title_text: 'natgeo',
        caption_body_text: 'A whale breaching at sunrise',
        target_url: 'https://www.instagram.com/reel/C0ffee123/',
        preview_image: { url: `${CDN}/reel_preview.jpg?oe=AAAA`, width: 540, height: 960 },
      },
    },
  };
}

export function stickerMsg(id: string, ts: number, o: MsgOpts = {}): IgMessage {
  return { ...base(id, ts, o), content_type: 'STICKER', igd_snippet: 'sent a sticker', content: { __typename: 'SlideMessageStoreStickerContent', alt_text: 'waving bear', preview_url: `${CDN}/sticker.webp?oe=AAAA`, preview_width: 256, preview_height: 256 } };
}

export function adminMsg(id: string, ts: number, text: string, o: MsgOpts = {}): IgMessage {
  return { ...base(id, ts, o), content_type: 'ADMIN_TEXT', igd_snippet: text, content: { __typename: 'SlideMessageAdminText', text_fragments: [{ plaintext: text }] } };
}

export function thread(chatId: string, members: string[], o: { title?: string; group?: boolean; messages?: IgMessage[]; hasMore?: boolean; lastTs?: number; threadId?: string } = {}): IgThread {
  const msgs = o.messages ?? [];
  return {
    id: chatId,
    thread_fbid: chatId,
    thread_key: chatId,
    thread_id: o.threadId ?? `long_${chatId}`,
    thread_subtype: o.group ? 'IGD_GROUP' : 'IG_ONLY_ONE_TO_ONE',
    is_group: o.group ?? false,
    viewer_id: ME,
    viewer: USERS[ME],
    thread_title: o.title ?? (o.group ? 'Weekend plans' : USERS[members.find((m) => m !== ME) ?? '']?.full_name),
    thread_image_url: o.group ? `${CDN}/group.jpg?oe=AAAA` : undefined,
    users: members.map((m) => USERS[m]!).filter(Boolean),
    last_activity_timestamp_ms: String(o.lastTs ?? (msgs.length ? Math.max(...msgs.map((m) => Number(m.timestamp_ms))) : at(0))),
    slide_messages: {
      edges: [...msgs].sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms)).map((m) => ({ node: m, cursor: String(m.message_id) })),
      page_info: { end_cursor: msgs.length ? String(msgs[0]!.message_id) : undefined, has_next_page: o.hasMore ?? false },
    },
    slide_read_receipts: [],
    is_muted: false,
    is_pin: false,
    folder: 'INBOX',
  };
}

export const delta = (typename: string, chatId: string, body: Record<string, unknown>): RawDelta => ({
  __typename: typename,
  uq_seq_id: String(Math.floor(Math.random() * 1e9)),
  thread_fbid: chatId,
  ...body,
});

/**
 * A fake Instagram account: threads with all their messages (any order). Pages of 20, newest first, like Instagram.
 */
export class FakeIg implements IgApi, SyncApi {
  readonly threads = new Map<string, { members: string[]; group: boolean; title?: string; messages: IgMessage[] }>();
  calls: string[] = [];

  add(chatId: string, members: string[], messages: IgMessage[], o: { group?: boolean; title?: string } = {}): this {
    this.threads.set(chatId, { members, group: o.group ?? false, title: o.title, messages: [...messages] });
    return this;
  }

  push(chatId: string, m: IgMessage): void {
    this.threads.get(chatId)!.messages.push(m);
  }

  remove(chatId: string, messageId: string): void {
    const t = this.threads.get(chatId)!;
    t.messages = t.messages.filter((m) => m.message_id !== messageId);
  }

  private sorted(chatId: string): IgMessage[] {
    return [...(this.threads.get(chatId)?.messages ?? [])].sort((a, b) => Number(b.timestamp_ms) - Number(a.timestamp_ms));
  }

  private threadOf(chatId: string, withMessages: boolean): IgThread | null {
    const t = this.threads.get(chatId);
    if (!t) return null;
    const all = this.sorted(chatId);
    const page = withMessages ? all.slice(0, 20) : all.slice(0, 1);
    const out = thread(chatId, t.members, { group: t.group, title: t.title, messages: page, hasMore: all.length > page.length, lastTs: all.length ? Number(all[0]!.timestamp_ms) : at(0) });
    out.slide_messages!.page_info!.end_cursor = page.length ? String(page[page.length - 1]!.message_id) : undefined;
    return out;
  }

  /** Thread details without messages (dev seed). */
  threadOfForSeed(chatId: string): IgThread {
    return this.threadOf(chatId, false)!;
  }

  async getThread(chatId: string): Promise<IgThread | null> {
    this.calls.push(`thread:${chatId}`);
    return this.threadOf(chatId, true);
  }

  async thread(chatId: string): Promise<IgThread | null> {
    return this.getThread(chatId);
  }

  async inbox(): Promise<ThreadPage> {
    this.calls.push('inbox');
    const ids = [...this.threads.keys()].sort((a, b) => Number(this.sorted(b)[0]?.timestamp_ms ?? 0) - Number(this.sorted(a)[0]?.timestamp_ms ?? 0));
    return { threads: ids.map((id) => this.threadOf(id, false)!), cursor: null, hasMore: false, viewerFbid: ME };
  }

  async inboxPage(): Promise<ThreadPage> {
    return { threads: [], cursor: null, hasMore: false, viewerFbid: ME };
  }

  async messages(chatId: string, opts: { after?: string | null; olderThan?: string | null }): Promise<MessagesPage> {
    this.calls.push(`messages:${chatId}`);
    const all = this.sorted(chatId);
    const ref = opts.after ?? opts.olderThan;
    const idx = ref ? all.findIndex((m) => m.message_id === ref) : -1;
    const rest = idx >= 0 ? all.slice(idx + 1) : all;
    const page = rest.slice(0, 20);
    return { messages: page, cursor: page.length ? String(page[page.length - 1]!.message_id) : null, hasMore: rest.length > 20, atStart: rest.length <= 20 };
  }
}
