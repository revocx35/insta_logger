import type { MessageType, MusicInfo, ShareInfo } from '../../../shared/api.js';
import type { IgAttachment, IgContent, IgMessage, IgUser, IgXma } from './types.js';

/** Where a part's file can be downloaded (signed Instagram CDN URLs; kept in memory only, never stored). */
export interface MediaSource {
  url: string;
  fallbackUrl: string | null;
  /** Expected type when Instagram does not send a Content-Type we can trust. */
  mime: string | null;
  filename: string | null;
}

/** Encrypted per-message JSON (messages.meta_enc). */
export interface MessageMeta {
  quoted?: { id: string | null; senderId: string | null; type: MessageType; text: string | null } | null;
  share?: ShareInfo | null;
  music?: MusicInfo | null;
  mentions?: string[];
  /** Instagram's content type name for content insta_logger doesn't know yet. */
  rawType?: string | null;
  /** Instagram's `content_type` of admin/system messages (e.g. IG_VIDEO_CALL_XMAT). */
  contentType?: string | null;
}

export interface MappedPart {
  /** Row id: the message id for the first part, "<id>~<n>" for further photos/videos of an album. */
  id: string;
  type: MessageType;
  body: string | null;
  meta: MessageMeta | null;
  media: { source: MediaSource | null; width: number | null; height: number | null; durationSec: number | null } | null;
  albumIndex: number | null;
  albumCount: number | null;
  viewOnce: boolean;
}

export interface MappedContact {
  id: string; // messaging id (sender_fbid)
  igId: string | null;
  username: string | null;
  name: string | null;
  verified: boolean;
  avatarUrl: string | null;
}

export interface MappedMessage {
  /** Our message id (Instagram's message_id). */
  id: string;
  /** Instagram's other id for it when different (some events use it). */
  altId: string | null;
  chatId: string | null;
  senderId: string | null;
  ts: number;
  forwarded: boolean;
  expiresAt: number | null;
  quotedId: string | null;
  parts: MappedPart[];
  sender: MappedContact | null;
  reactions: { senderId: string; emoji: string; ts: number }[];
  /** Earlier versions of the text, oldest first (from Instagram's edit history). */
  previousBodies: { body: string | null; ts: number }[];
  /** Latest edit: time and a key that changes with every edit. */
  editTs: number | null;
  skip: boolean;
}

/* ----------------------------------------------------------------- helpers */

export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

export const ms = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n; // seconds → ms
};

/**
 * Origin whose plain-http links also count as media links. Only set to the fake Instagram of the end-to-end test
 * (IG_WEB_ORIGIN); real Instagram media is always https.
 */
let testOrigin: string | null = null;
export function setTestMediaOrigin(origin: string | null): void {
  testOrigin = origin && !origin.startsWith('https://') ? origin : null;
}

const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  if (/^https:\/\//i.test(s)) return s;
  return testOrigin && s.startsWith(`${testOrigin}/`) ? s : null;
};

const dim = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v) : null);

/** Messaging id as a decimal string ("0"/empty → null). */
export const fbid = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{1,24}$/.test(s) && !/^0+$/.test(s) ? s : null;
};

export function mapUser(u: IgUser | null | undefined): MappedContact | null {
  if (!u) return null;
  const id = fbid(u.interop_messaging_user_fbid);
  if (!id) return null;
  return {
    id,
    igId: str(u.id) ?? str(u.pk),
    username: str(u.username),
    name: str(u.full_name),
    verified: u.is_verified === true,
    avatarUrl: httpsUrl(u.profile_pic_url),
  };
}

function shareKind(url: string | null): string {
  if (!url) return 'Shared';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      if (/^\/reels?\//.test(u.pathname)) return 'Reel';
      if (/^\/p\//.test(u.pathname)) return 'Post';
      if (/^\/stories\//.test(u.pathname)) return 'Story';
      if (/^\/[A-Za-z0-9._]+\/?$/.test(u.pathname)) return 'Profile';
      return 'Instagram';
    }
    return 'Link';
  } catch {
    return 'Shared';
  }
}

/** The real target of l.facebook.com / l.instagram.com redirect links. */
function unwrapLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if ((u.hostname === 'l.facebook.com' || u.hostname === 'l.instagram.com') && u.searchParams.get('u')) {
      const inner = u.searchParams.get('u')!;
      return /^https?:\/\//i.test(inner) ? inner : url;
    }
  } catch {
    return null;
  }
  return /^https?:\/\//i.test(url) ? url : null;
}

export function mapShare(x: IgXma | null | undefined): { share: ShareInfo; preview: MediaSource | null; w: number | null; h: number | null } | null {
  if (!x) return null;
  const url = unwrapLink(str(x.target_url));
  const img = x.preview_image ?? x.xmaPreviewImage ?? null;
  const previewUrl = httpsUrl(img?.url);
  const title = str(x.header_title_text) ?? str(x.title_text) ?? str(x.xmaTitle);
  const second = str(x.title_text) !== title ? str(x.title_text) : null;
  const share: ShareInfo = {
    kind: shareKind(url),
    title,
    subtitle: str(x.subtitle_text) ?? str(x.header_subtitle_text) ?? second,
    caption: str(x.caption_body_text),
    url,
    eyebrow: str(x.eyebrow_text),
  };
  return {
    share,
    preview: previewUrl ? { url: previewUrl, fallbackUrl: httpsUrl((img as { fallback_url?: string } | null)?.fallback_url), mime: null, filename: null } : null,
    w: dim(img?.width),
    h: dim(img?.height),
  };
}

function attachmentSource(a: IgAttachment, mime: string | null): MediaSource | null {
  const url = httpsUrl(a.attachment_cdn_url) ?? httpsUrl(a.preview_cdn_url);
  if (!url) return null;
  const fallback = httpsUrl(a.attachment_cdn_fallback_url) ?? (url === httpsUrl(a.preview_cdn_url) ? null : httpsUrl(a.preview_cdn_url));
  return { url, fallbackUrl: fallback, mime, filename: null };
}

function isVideoAttachment(a: IgAttachment): boolean {
  return /video/i.test(a.__typename ?? '') || !!a.dash_manifest || /\.mp4(\?|$)/i.test(a.attachment_cdn_url ?? '');
}

function textOf(content: IgContent | null | undefined, msg: IgMessage): string | null {
  return str(content?.text_body) ?? str(msg.text_body);
}

const MEDIA_TYPES = new Set<MessageType>(['image', 'video', 'gif', 'voice', 'sticker']);

/**
 * Maps one Slide message to rows. Albums ("multi media", several photos) become one row per photo/video so
 * every file has its own download state; the text stays on the first row.
 */
export function mapMessage(msg: IgMessage | null | undefined, chatHint: string | null = null): MappedMessage {
  const empty: MappedMessage = {
    id: '',
    altId: null,
    chatId: null,
    senderId: null,
    ts: 0,
    forwarded: false,
    expiresAt: null,
    quotedId: null,
    parts: [],
    sender: null,
    reactions: [],
    previousBodies: [],
    editTs: null,
    skip: true,
  };
  if (!msg || typeof msg !== 'object') return empty;
  const id = str(msg.message_id) ?? str(msg.id);
  if (!id || id.length > 240 || /[\s/?#%~]/.test(id)) return empty;
  const altCandidate = str(msg.id);
  const altId = altCandidate && altCandidate !== id && altCandidate.length <= 240 ? altCandidate : null;
  const ts = ms(msg.timestamp_ms);
  if (!ts) return empty;
  const chatId = str(msg.thread_fbid) ?? chatHint;

  const content = msg.content ?? null;
  const typename = str(content?.__typename) ?? '';
  const senderUser = mapUser(msg.sender?.user_dict ?? null);
  const senderId = fbid(msg.sender_fbid) ?? senderUser?.id ?? null;
  const sender = senderUser ?? (senderId ? { id: senderId, igId: str(msg.sender?.igid), username: null, name: str(msg.sender?.name), verified: false, avatarUrl: null } : null);

  const mentions = (msg.mentions ?? [])
    .filter((m) => (m.profile_range_type ?? 'PROFILE') === 'PROFILE')
    .map((m) => fbid(m.user_fbid))
    .filter((x): x is string => !!x);

  const meta: MessageMeta = {};
  if (mentions.length) meta.mentions = [...new Set(mentions)];

  const quotedId = str(msg.replied_to_message_id);
  if (quotedId) {
    const q = msg.replied_to_message ?? null;
    const qm = q ? mapMessage(q, chatId) : null;
    const first = qm && !qm.skip ? qm.parts[0] : null;
    meta.quoted = {
      id: quotedId,
      senderId: qm && !qm.skip ? qm.senderId : fbid(q?.sender_fbid),
      type: first?.type ?? 'text',
      text: first?.body ?? str(q?.igd_snippet) ?? null,
    };
  }

  const parts: MappedPart[] = [];
  const single = (type: MessageType, body: string | null, media: MappedPart['media'], extra: Partial<MappedPart> = {}) =>
    parts.push({ id, type, body, meta: null, media, albumIndex: null, albumCount: null, viewOnce: false, ...extra });
  const album = (items: { type: MessageType; source: MediaSource | null; w: number | null; h: number | null; dur: number | null }[], body: string | null) => {
    items.forEach((it, i) =>
      parts.push({
        id: i === 0 ? id : `${id}~${i}`,
        type: it.type,
        body: i === 0 ? body : null,
        meta: null,
        media: { source: it.source, width: it.w, height: it.h, durationSec: it.dur },
        albumIndex: items.length > 1 ? i : null,
        albumCount: items.length > 1 ? items.length : null,
        viewOnce: false,
      }),
    );
  };
  const fromAttachment = (a: IgAttachment, forced?: MessageType) => {
    const video = forced ? forced === 'video' : isVideoAttachment(a);
    const dur = typeof a.playable_duration_ms === 'number' ? Math.round(a.playable_duration_ms / 1000) : typeof a.playable_duration_in_ms === 'number' ? Math.round(a.playable_duration_in_ms / 1000) : null;
    return {
      type: (video ? 'video' : 'image') as MessageType,
      source: attachmentSource(a, video ? 'video/mp4' : 'image/jpeg'),
      w: dim(a.original_width) ?? dim(a.preview_width),
      h: dim(a.original_height) ?? dim(a.preview_height),
      dur: video ? dur : null,
    };
  };

  switch (typename) {
    case 'SlideMessageText':
      single('text', textOf(content, msg), null);
      break;
    case 'SlideMessageAdminText': {
      const frags = (content?.text_fragments ?? []).map((f) => str(f.plaintext) ?? '').join('');
      single('system', frags || str(msg.igd_snippet), null);
      meta.contentType = str(msg.content_type);
      break;
    }
    case 'SlideMessageImageContent':
      album((content?.attachments ?? []).map((a) => fromAttachment(a, 'image')), null);
      break;
    case 'SlideMessageVideosContent':
      album((content?.videos ?? []).map((a) => fromAttachment(a, 'video')), null);
      break;
    case 'SlideMessageMultiMediaContent':
      album((content?.ordered_photo_video_attachments ?? []).map((a) => fromAttachment(a)), null);
      break;
    case 'SlideMessageAudiosContent':
      album(
        (content?.audio_attachments ?? []).map((a) => ({
          type: 'voice' as MessageType,
          source: httpsUrl(a.attachment_cdn_url) ? { url: httpsUrl(a.attachment_cdn_url)!, fallbackUrl: null, mime: 'audio/mp4', filename: null } : null,
          w: null,
          h: null,
          dur: typeof a.playable_duration_ms === 'number' ? Math.round(a.playable_duration_ms / 1000) : null,
        })),
        null,
      );
      break;
    case 'SlideMessageAnimatedMediaContent':
      album(
        (content?.animated_media ?? []).map((a) => {
          const webp = httpsUrl(a.attachment_webp_url);
          const mp4 = httpsUrl(a.attachment_mp4_url);
          if (webp && (a.is_sticker || !mp4)) {
            return { type: 'sticker' as MessageType, source: { url: webp, fallbackUrl: null, mime: 'image/webp', filename: null }, w: dim(a.preview_width), h: dim(a.preview_height), dur: null };
          }
          if (mp4) return { type: 'gif' as MessageType, source: { url: mp4, fallbackUrl: null, mime: 'video/mp4', filename: null }, w: dim(a.preview_width), h: dim(a.preview_height), dur: null };
          const prev = httpsUrl(a.preview_cdn_url);
          return { type: 'image' as MessageType, source: prev ? { url: prev, fallbackUrl: null, mime: 'image/jpeg', filename: null } : null, w: dim(a.preview_width), h: dim(a.preview_height), dur: null };
        }),
        null,
      );
      break;
    case 'SlideMessageRavenImageContent':
    case 'SlideMessageRavenVideoContent': {
      const video = typename === 'SlideMessageRavenVideoContent';
      const mode = typeof content?.view_mode === 'number' ? content.view_mode : 0;
      if (mode === 2 && content?.attachment) {
        // "Keep in chat": an ordinary photo/video.
        const it = fromAttachment(content.attachment, video ? 'video' : 'image');
        single(it.type, null, { source: it.source, width: it.w, height: it.h, durationSec: it.dur });
      } else {
        // View once / allow replay: never downloaded (same policy as wa_logger's view-once media).
        single('view_once', null, { source: null, width: null, height: null, durationSec: null }, { viewOnce: true });
        meta.rawType = video ? 'video' : 'image';
      }
      break;
    }
    case 'SlideMessageStoreStickerContent':
    case 'SlideMessageAvatarStickerXMAContent':
    case 'SlideMessageCutoutStickerXMAContent':
    case 'SlideMessageAIStickerXMAContent': {
      const url = httpsUrl(content?.preview_url);
      single('sticker', str(content?.alt_text), {
        source: url ? { url, fallbackUrl: null, mime: null, filename: null } : null,
        width: dim(content?.preview_width),
        height: dim(content?.preview_height),
        durationSec: null,
      });
      break;
    }
    case 'SlideMessageXMAContent': {
      const sh = mapShare(content?.xma ?? null);
      const body = str(content?.xma_text_body);
      if (sh) meta.share = sh.share;
      single('share', body, sh?.preview ? { source: sh.preview, width: sh.w, height: sh.h, durationSec: null } : null);
      break;
    }
    case 'SlideMessageMusicStickerXMAContent': {
      const t = content?.audio_track;
      meta.music = { title: str(t?.title), artist: str(t?.display_artist) };
      const url = httpsUrl(t?.web_30s_preview_download_url);
      single('music', null, url ? { source: { url, fallbackUrl: null, mime: 'audio/mp4', filename: null }, width: null, height: null, durationSec: 30 } : null);
      break;
    }
    case 'SlideMessageGenAIRichResponseXMAContent':
      single('text', str(content?.unified_response) ?? str(msg.igd_snippet), null);
      break;
    case 'SlideMessageGenAISearchPluginResponseXMAContent':
      single('text', str(content?.messasge_text_body) ?? str(msg.igd_snippet), null);
      break;
    default: {
      // No content wrapper but a text body: plain text (seen on older payloads).
      const t = textOf(content, msg);
      if (!typename && t) single('text', t, null);
      else {
        single('unknown', str(msg.igd_snippet) ?? t, null);
        meta.rawType = typename || null;
      }
    }
  }
  // A media message whose attachment list was empty: keep it as one row without a file.
  if (parts.length === 0) {
    const t: MessageType = typename === 'SlideMessageVideosContent' ? 'video' : typename === 'SlideMessageAudiosContent' ? 'voice' : 'image';
    single(t, null, { source: null, width: null, height: null, durationSec: null });
  }
  const hasMeta = Object.keys(meta).length > 0;
  parts[0]!.meta = hasMeta ? meta : null;
  for (const p of parts) if (p.media && !MEDIA_TYPES.has(p.type) && p.type !== 'share' && p.type !== 'music' && p.type !== 'view_once') p.media = null;

  const reactions = (msg.reactions ?? [])
    .map((r) => ({ senderId: fbid(r.sender_fbid), emoji: str(r.reaction), ts: ms(r.reaction_timestamp_ms) ?? ts }))
    .filter((r): r is { senderId: string; emoji: string; ts: number } => !!r.senderId && !!r.emoji);

  const history = (msg.slide_edit_history ?? [])
    .map((e) => ({ body: typeof e.body === 'string' ? e.body : null, ts: ms(e.timestamp_ms) ?? 0 }))
    .sort((a, b) => a.ts - b.ts);
  const currentBody = parts[0]!.body;
  const previousBodies = history.filter((h) => h.body !== currentBody);
  const editTs = history.length ? Math.max(...history.map((h) => h.ts)) || null : null;

  return {
    id,
    altId,
    chatId,
    senderId,
    ts,
    forwarded: msg.igd_is_forwarded === true,
    expiresAt: ms(msg.expiration_timestamp_ms),
    quotedId,
    parts,
    sender,
    reactions,
    previousBodies: editTs ? previousBodies : [],
    editTs,
    skip: false,
  };
}

/** Plain-text label of a message type for chat previews. */
export const TYPE_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Photo',
  video: '🎥 Video',
  gif: 'GIF',
  voice: '🎤 Voice message',
  sticker: 'Sticker',
  share: '↗ Shared',
  music: '🎵 Music',
  view_once: 'View-once media',
};
